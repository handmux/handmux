import type { ConversationService } from './conversation.js';
import type {
  ConversationEvent,
  ConversationLiveHandle,
  ConversationOpenRequest,
} from './conversationTypes.js';
import type { AgentRunLease } from './run.js';

const DEFAULT_MAX_BUFFERED_EVENTS = 512;
const DEFAULT_MAX_REPLAY_EVENTS = 2_048;
const DEFAULT_IDLE_GRACE_MS = 5_000;

export interface ConversationLiveSubscription extends AsyncIterable<ConversationEvent> {
  readonly checkpoint: ConversationLiveHandle['checkpoint'];
  close(): void;
}

export interface ConversationLiveHubOptions {
  conversation: Pick<ConversationService, 'open'>;
  maxBufferedEvents?: number;
  maxReplayEvents?: number;
  idleGraceMs?: number;
}

export class ConversationLiveHubError extends Error {
  constructor(
    readonly code: 'closed' | 'stale_run' | 'stale_view' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ConversationLiveHubError';
  }
}

interface SharedObservation {
  run: AgentRunLease;
  ready: Promise<void>;
  handle?: ConversationLiveHandle;
  baseline?: ConversationLiveHandle['checkpoint'];
  checkpoint?: ConversationLiveHandle['checkpoint'];
  replay: ConversationEvent[];
  provisional: Set<string>;
  subscribers: Set<EventQueue>;
  idleTimer: NodeJS.Timeout | undefined;
  detachAbort: () => void;
  terminated: boolean;
}

class EventQueue implements ConversationLiveSubscription {
  readonly checkpoint: ConversationLiveHandle['checkpoint'];
  readonly #maxBufferedEvents: number;
  readonly #detach: () => void;
  readonly #values: ConversationEvent[] = [];
  #waiting: ((result: IteratorResult<ConversationEvent>) => void) | undefined;
  #closed = false;
  #finishWhenEmpty = false;
  #detached = false;
  #lastReadSequence: number;

  constructor(
    checkpoint: ConversationLiveHandle['checkpoint'],
    maxBufferedEvents: number,
    detach: () => void,
  ) {
    this.checkpoint = Object.freeze(structuredClone(checkpoint));
    this.#lastReadSequence = checkpoint.streamSequence;
    this.#maxBufferedEvents = maxBufferedEvents;
    this.#detach = detach;
  }

  [Symbol.asyncIterator](): AsyncIterator<ConversationEvent> { return this; }

  next(): Promise<IteratorResult<ConversationEvent>> {
    const value = this.#values.shift();
    if (value) {
      this.#lastReadSequence = value.sequence;
      return Promise.resolve({ value: structuredClone(value), done: false });
    }
    if (this.#closed || this.#finishWhenEmpty) {
      this.#closed = true;
      this.#detachOnce();
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => { this.#waiting = resolve; });
  }

  push(event: ConversationEvent, finish = false): void {
    if (this.#closed || this.#finishWhenEmpty) return;
    const cloned = structuredClone(event);
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      this.#lastReadSequence = cloned.sequence;
      if (finish) {
        this.#finishWhenEmpty = true;
        this.#detachOnce();
      }
      waiting({ value: cloned, done: false });
      return;
    }
    if (this.#values.length >= this.#maxBufferedEvents) {
      this.#values.splice(0);
      this.#values.push({
        type: 'stream.gap',
        sequence: cloned.sequence,
        afterSequence: this.#lastReadSequence,
      });
      this.#finishWhenEmpty = true;
      this.#detachOnce();
      return;
    }
    this.#values.push(cloned);
    if (finish) {
      this.#finishWhenEmpty = true;
      this.#detachOnce();
    }
  }

  finishAfterDrain(): void {
    if (this.#closed || this.#finishWhenEmpty) return;
    this.#finishWhenEmpty = true;
    this.#detachOnce();
    if (!this.#values.length && this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      this.#closed = true;
      waiting({ value: undefined, done: true });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.splice(0);
    this.#detachOnce();
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  #detachOnce(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#detach();
  }
}

// App-level fan-out only. ConversationService still owns provider ordering, reconciliation, and durable
// truth; this hub owns one shared observation plus bounded per-client delivery queues.
export class ConversationLiveHub {
  readonly #conversation: Pick<ConversationService, 'open'>;
  readonly #maxBufferedEvents: number;
  readonly #maxReplayEvents: number;
  readonly #idleGraceMs: number;
  readonly #observations = new Map<string, SharedObservation>();
  #closed = false;

  constructor({
    conversation,
    maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS,
    maxReplayEvents = DEFAULT_MAX_REPLAY_EVENTS,
    idleGraceMs = DEFAULT_IDLE_GRACE_MS,
  }: ConversationLiveHubOptions) {
    if (!conversation || typeof conversation.open !== 'function'
      || !Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents <= 0
      || !Number.isSafeInteger(maxReplayEvents) || maxReplayEvents <= 0
      || !Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) {
      throw new TypeError('Conversation live hub requires a service and bounded queues');
    }
    this.#conversation = conversation;
    this.#maxBufferedEvents = maxBufferedEvents;
    this.#maxReplayEvents = maxReplayEvents;
    this.#idleGraceMs = idleGraceMs;
  }

  async subscribe(
    run: AgentRunLease,
    request: ConversationOpenRequest = {},
  ): Promise<ConversationLiveSubscription> {
    if (this.#closed) throw new ConversationLiveHubError('closed', 'Conversation live hub is closed');
    let shared = this.#observations.get(run.ref.runId);
    if (!shared) shared = this.#create(run);
    if (shared.run !== run || shared.terminated) {
      throw new ConversationLiveHubError('stale_run', 'Conversation live run is no longer current');
    }
    if (shared.idleTimer) {
      clearTimeout(shared.idleTimer);
      shared.idleTimer = undefined;
    }
    await shared.ready;
    const checkpoint = shared.checkpoint;
    const baseline = shared.baseline;
    if (!checkpoint || !baseline || shared.terminated) {
      throw new ConversationLiveHubError('unavailable', 'Conversation live observation is unavailable');
    }
    if (request.expectedViewId !== undefined && request.expectedViewId !== checkpoint.viewId) {
      this.#idle(shared);
      throw new ConversationLiveHubError('stale_view', 'Conversation view is stale');
    }
    let subscription!: EventQueue;
    subscription = new EventQueue(baseline, this.#maxBufferedEvents, () => {
      this.#detach(shared!, subscription);
    });
    shared.subscribers.add(subscription);
    for (const event of shared.replay) subscription.push(event);
    return subscription;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const shared of [...this.#observations.values()]) this.#terminate(shared, false);
  }

  #create(run: AgentRunLease): SharedObservation {
    const shared: SharedObservation = {
      run,
      ready: Promise.resolve(),
      subscribers: new Set(),
      replay: [],
      provisional: new Set(),
      idleTimer: undefined,
      detachAbort: () => {},
      terminated: false,
    };
    const abort = (): void => this.#terminate(shared, false);
    run.signal.addEventListener('abort', abort, { once: true });
    shared.detachAbort = () => run.signal.removeEventListener('abort', abort);
    this.#observations.set(run.ref.runId, shared);
    shared.ready = this.#conversation.open(run, {}, (event) => {
      this.#publish(shared, event);
    }).then((handle) => {
      if (shared.terminated) {
        try { void Promise.resolve(handle.close()).catch(() => {}); } catch { /* best effort */ }
        throw new Error('Conversation live run was revoked during open');
      }
      shared.handle = handle;
      shared.baseline = structuredClone(handle.checkpoint);
      shared.checkpoint = structuredClone(handle.checkpoint);
    }).catch((error) => {
      this.#terminate(shared, false);
      throw error;
    });
    return shared;
  }

  #publish(shared: SharedObservation, event: ConversationEvent): void {
    if (shared.terminated || !shared.checkpoint
      || !Number.isSafeInteger(event.sequence)
      || event.sequence <= shared.checkpoint.streamSequence) return;
    const previousSequence = shared.checkpoint.streamSequence;
    const advancesBaseline = event.type === 'history.changed' && shared.provisional.size === 0;
    if (shared.replay.length >= this.#maxReplayEvents
      && !advancesBaseline && event.type !== 'stream.gap') {
      const gap: ConversationEvent = {
        type: 'stream.gap', sequence: event.sequence, afterSequence: previousSequence,
      };
      shared.checkpoint = { ...shared.checkpoint, streamSequence: event.sequence };
      for (const subscriber of [...shared.subscribers]) subscriber.push(gap, true);
      this.#terminate(shared, true);
      return;
    }
    shared.checkpoint = {
      viewId: event.type === 'history.changed' ? event.viewId : shared.checkpoint.viewId,
      historyVersion: event.type === 'history.changed'
        ? event.historyVersion : shared.checkpoint.historyVersion,
      streamSequence: event.sequence,
    };
    const terminal = event.type === 'stream.gap';
    shared.replay.push(structuredClone(event));
    for (const subscriber of [...shared.subscribers]) subscriber.push(event, terminal);
    if (event.type === 'item.opened') shared.provisional.add(event.provisionalId);
    else if (event.type === 'item.settled' || event.type === 'item.cancelled') {
      shared.provisional.delete(event.provisionalId);
    } else if (event.type === 'stream.gap') shared.provisional.clear();
    if (advancesBaseline) {
      // A barrier can release replay only when no provisional lifecycle crosses it. Otherwise a late
      // subscriber must replay item.opened before receiving that item's later delta or settlement.
      shared.baseline = structuredClone(shared.checkpoint);
      shared.replay = [];
    }
    if (terminal) this.#terminate(shared, true);
  }

  #detach(shared: SharedObservation, subscription: EventQueue): void {
    shared.subscribers.delete(subscription);
    this.#idle(shared);
  }

  #idle(shared: SharedObservation): void {
    if (shared.terminated || shared.subscribers.size || shared.idleTimer) return;
    if (this.#idleGraceMs === 0) {
      this.#terminate(shared, false);
      return;
    }
    shared.idleTimer = setTimeout(() => {
      shared.idleTimer = undefined;
      if (!shared.subscribers.size) this.#terminate(shared, false);
    }, this.#idleGraceMs);
    shared.idleTimer.unref?.();
  }

  #terminate(shared: SharedObservation, drain: boolean): void {
    if (shared.terminated) return;
    shared.terminated = true;
    if (this.#observations.get(shared.run.ref.runId) === shared) {
      this.#observations.delete(shared.run.ref.runId);
    }
    if (shared.idleTimer) clearTimeout(shared.idleTimer);
    shared.idleTimer = undefined;
    shared.detachAbort();
    for (const subscriber of [...shared.subscribers]) {
      if (drain) subscriber.finishAfterDrain(); else subscriber.close();
    }
    shared.subscribers.clear();
    try {
      void Promise.resolve(shared.handle?.close()).catch(() => {});
    } catch { /* close is best effort */ }
  }
}
