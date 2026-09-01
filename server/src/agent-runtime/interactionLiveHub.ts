import type { InteractionService } from './interaction.js';
import type {
  InteractionEvent,
  InteractionLiveHandle,
  PendingInteraction,
} from './interactionTypes.js';
import type { AgentRunLease } from './run.js';

const DEFAULT_MAX_BUFFERED_EVENTS = 256;
const DEFAULT_IDLE_GRACE_MS = 5_000;

export interface InteractionLiveCheckpoint {
  revision: number;
  pending: PendingInteraction[];
}

export interface InteractionLiveSubscription extends AsyncIterable<InteractionEvent> {
  readonly checkpoint: InteractionLiveCheckpoint;
  close(): void;
}

export interface InteractionLiveHubOptions {
  interaction: Pick<InteractionService, 'open'>;
  maxBufferedEvents?: number;
  idleGraceMs?: number;
}

export class InteractionLiveHubError extends Error {
  constructor(
    readonly code: 'closed' | 'stale_run' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'InteractionLiveHubError';
  }
}

interface SharedObservation {
  run: AgentRunLease;
  ready: Promise<void>;
  handle?: InteractionLiveHandle;
  checkpoint?: InteractionLiveCheckpoint;
  subscribers: Set<EventQueue>;
  idleTimer: NodeJS.Timeout | undefined;
  terminated: boolean;
}

class EventQueue implements InteractionLiveSubscription {
  readonly checkpoint: InteractionLiveCheckpoint;
  readonly #maxBufferedEvents: number;
  readonly #detach: () => void;
  readonly #values: InteractionEvent[] = [];
  #waiting: ((result: IteratorResult<InteractionEvent>) => void) | undefined;
  #closed = false;
  #detached = false;

  constructor(
    checkpoint: InteractionLiveCheckpoint,
    maxBufferedEvents: number,
    detach: () => void,
  ) {
    this.checkpoint = Object.freeze(structuredClone(checkpoint));
    this.#maxBufferedEvents = maxBufferedEvents;
    this.#detach = detach;
  }

  [Symbol.asyncIterator](): AsyncIterator<InteractionEvent> { return this; }

  next(): Promise<IteratorResult<InteractionEvent>> {
    const value = this.#values.shift();
    if (value) return Promise.resolve({ value: structuredClone(value), done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.#waiting = resolve; });
  }

  push(event: InteractionEvent): void {
    if (this.#closed) return;
    const cloned = structuredClone(event);
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting({ value: cloned, done: false });
      return;
    }
    if (this.#values.length >= this.#maxBufferedEvents) {
      this.close();
      return;
    }
    this.#values.push(cloned);
  }

  finishAfterDrain(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachOnce();
    if (!this.#values.length && this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
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

// App-level fan-out only. InteractionService remains the owner of native observation, persistence,
// revision ordering, resolution tokens, and first-response-wins semantics.
export class InteractionLiveHub {
  readonly #interaction: Pick<InteractionService, 'open'>;
  readonly #maxBufferedEvents: number;
  readonly #idleGraceMs: number;
  readonly #observations = new Map<string, SharedObservation>();
  #closed = false;

  constructor({
    interaction,
    maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS,
    idleGraceMs = DEFAULT_IDLE_GRACE_MS,
  }: InteractionLiveHubOptions) {
    if (!interaction || typeof interaction.open !== 'function'
      || !Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents <= 0
      || !Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) {
      throw new TypeError('Interaction live hub requires a service and bounded queues');
    }
    this.#interaction = interaction;
    this.#maxBufferedEvents = maxBufferedEvents;
    this.#idleGraceMs = idleGraceMs;
  }

  async subscribe(run: AgentRunLease): Promise<InteractionLiveSubscription> {
    if (this.#closed) throw new InteractionLiveHubError('closed', 'Interaction live hub is closed');
    let shared = this.#observations.get(run.ref.runId);
    if (!shared) shared = this.#create(run);
    if (shared.run !== run || shared.terminated) {
      throw new InteractionLiveHubError('stale_run', 'Interaction live run is no longer current');
    }
    if (shared.idleTimer) {
      clearTimeout(shared.idleTimer);
      shared.idleTimer = undefined;
    }
    await shared.ready;
    if (!shared.checkpoint || shared.terminated) {
      throw new InteractionLiveHubError('unavailable', 'Interaction live observation is unavailable');
    }
    let subscription!: EventQueue;
    subscription = new EventQueue(shared.checkpoint, this.#maxBufferedEvents, () => {
      this.#detach(shared!, subscription);
    });
    shared.subscribers.add(subscription);
    return subscription;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const shared of [...this.#observations.values()]) this.#terminate(shared);
  }

  #create(run: AgentRunLease): SharedObservation {
    const shared: SharedObservation = {
      run,
      ready: Promise.resolve(),
      subscribers: new Set(),
      idleTimer: undefined,
      terminated: false,
    };
    this.#observations.set(run.ref.runId, shared);
    shared.ready = this.#interaction.open(run, (event) => this.#publish(shared, event)).then((handle) => {
      if (shared.terminated) {
        try { void Promise.resolve(handle.close()).catch(() => {}); } catch { /* best effort */ }
        throw new Error('Interaction live run was revoked during open');
      }
      shared.handle = handle;
      shared.checkpoint = {
        revision: handle.revision,
        pending: structuredClone(handle.pending),
      };
      void handle.closed.then(() => this.#terminate(shared, true));
    }).catch((error) => {
      this.#terminate(shared);
      throw error;
    });
    return shared;
  }

  #publish(shared: SharedObservation, event: InteractionEvent): void {
    if (shared.terminated) return;
    const checkpoint = shared.checkpoint;
    if (!checkpoint || !Number.isSafeInteger(event.revision)
      || event.revision !== checkpoint.revision + 1) {
      this.#terminate(shared);
      throw new InteractionLiveHubError('unavailable', 'Interaction revision is invalid');
    }
    const pending = new Map(checkpoint.pending.map((item) => [item.id, item]));
    if (event.type === 'opened') {
      const previous = pending.get(event.interaction.id);
      if (event.interaction.runId !== shared.run.ref.runId
        || (previous !== undefined
          && previous.resolutionToken !== event.interaction.resolutionToken)) {
        this.#terminate(shared);
        throw new InteractionLiveHubError('unavailable', 'Interaction opened event is invalid');
      }
      // Core deliberately reuses the public identity and resolution token when a native pending item
      // changes in place. Mirror its upsert contract so prompt/option updates do not tear down SSE.
      pending.set(event.interaction.id, structuredClone(event.interaction));
    } else if (!pending.delete(event.interactionId)) {
      this.#terminate(shared);
      throw new InteractionLiveHubError('unavailable', 'Interaction terminal event is invalid');
    }
    shared.checkpoint = {
      revision: event.revision,
      pending: [...pending.values()],
    };
    for (const subscriber of [...shared.subscribers]) subscriber.push(event);
  }

  #detach(shared: SharedObservation, subscription: EventQueue): void {
    shared.subscribers.delete(subscription);
    this.#idle(shared);
  }

  #idle(shared: SharedObservation): void {
    if (shared.terminated || shared.subscribers.size || shared.idleTimer) return;
    if (this.#idleGraceMs === 0) {
      this.#terminate(shared);
      return;
    }
    shared.idleTimer = setTimeout(() => {
      shared.idleTimer = undefined;
      if (!shared.subscribers.size) this.#terminate(shared);
    }, this.#idleGraceMs);
    shared.idleTimer.unref?.();
  }

  #terminate(shared: SharedObservation, drain = false): void {
    if (shared.terminated) return;
    shared.terminated = true;
    if (this.#observations.get(shared.run.ref.runId) === shared) {
      this.#observations.delete(shared.run.ref.runId);
    }
    if (shared.idleTimer) clearTimeout(shared.idleTimer);
    shared.idleTimer = undefined;
    for (const subscriber of [...shared.subscribers]) {
      if (drain) subscriber.finishAfterDrain(); else subscriber.close();
    }
    shared.subscribers.clear();
    try {
      void Promise.resolve(shared.handle?.close()).catch(() => {});
    } catch { /* close is best effort */ }
  }
}
