import { createHash, randomUUID } from 'node:crypto';
import type { AgentRunLease, AgentRunRef, AgentRunRegistry } from './run.js';
import {
  DEFAULT_BRIDGE_LIMITS,
} from './bridgeTypes.js';
import type {
  BridgeDurableReplayResult,
  BridgeDurableReplaySink,
  BridgeEventEnvelope,
  BridgeHostChannelHandle,
  BridgeHostEvent,
  BridgeHostEventSink,
  BridgeLimits,
  BridgePublishRequest,
  BridgeRequestContext,
  BridgeRequestHandler,
  BridgeWriteReceipt,
  LocalAgentBridgeChannel,
  LocalAgentBridgeConnection,
  LocalAgentBridgeHost,
} from './bridgeTypes.js';
import { MemoryBridgeStateStore } from './bridgeStore.js';
import type {
  BridgeStateStore,
  PersistedBridgeChannel,
  PersistedBridgeDurableEvent,
  PersistedBridgeReceipt,
  PersistedBridgeState,
} from './bridgeStore.js';

const NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export class BridgeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeContractError';
  }
}

export type BridgeRequestErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'unavailable'
  | 'limit_exceeded'
  | 'handler_error'
  | 'invalid_response';

export class BridgeRequestError extends Error {
  constructor(readonly code: BridgeRequestErrorCode, message: string) {
    super(message);
    this.name = 'BridgeRequestError';
  }
}

interface EncodedValue {
  value: unknown;
  bytes: number;
  hash: string;
}

interface LiveOperation {
  sequence: number;
  bytes: number;
  event: BridgeHostEvent;
}

interface LiveSubscription {
  sink: BridgeHostEventSink;
  deliveredSequence: number;
  closed: boolean;
  detachAbort: () => void;
}

interface RuntimeChannel {
  persisted: PersistedBridgeChannel;
  live: LiveOperation[];
  liveBytes: number;
  acceptedEphemeralSinceSnapshot: number;
  continuityLost: boolean;
  gapAfter: number | undefined;
  gapEpoch: number;
  subscription: LiveSubscription | undefined;
  pumping: boolean;
  pumpAgain: boolean;
  retryTimer: NodeJS.Timeout | undefined;
  durableWaiters: Array<{
    throughSequence: number;
    resolve: () => void;
    reject: (error: Error) => void;
    detachAbort: () => void;
  }>;
}

interface DurableConsumer {
  sink: BridgeDurableReplaySink;
  active: boolean;
}

interface RequestHandlerEntry {
  handler: BridgeRequestHandler;
  pending: Set<AbortController>;
}

interface RuntimeConnection {
  agentId: string;
  runId: string;
  abort: AbortController;
  handlers: Map<string, RequestHandlerEntry>;
  close: (reason?: string) => void;
}

interface PendingRequest {
  agentId: string;
  runId: string;
  abort: AbortController;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validRunRef(value: unknown, agentId: string): value is AgentRunRef {
  if (!isRecord(value)) return false;
  return value.agentId === agentId
    && typeof value.paneId === 'string' && value.paneId.length > 0
    && typeof value.runId === 'string' && value.runId.length > 0
    && (value.sessionId === undefined || (typeof value.sessionId === 'string' && value.sessionId.length > 0));
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BridgeContractError('Bridge payload contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') throw new BridgeContractError('Bridge payload must be JSON-serializable');
  if (seen.has(value)) throw new BridgeContractError('Bridge payload contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BridgeContractError('Bridge payload must contain only plain JSON objects');
    }
    for (const item of Object.values(value as Record<string, unknown>)) assertJsonValue(item, seen);
  }
  seen.delete(value);
}

function encodeValue(value: unknown): EncodedValue {
  assertJsonValue(value);
  const json = JSON.stringify(value);
  if (json === undefined) throw new BridgeContractError('Bridge payload cannot be undefined');
  return {
    value: JSON.parse(json) as unknown,
    bytes: Buffer.byteLength(json),
    hash: createHash('sha256').update(json).digest('hex'),
  };
}

function copyRunRef(ref: AgentRunRef): AgentRunRef {
  return Object.freeze({
    agentId: ref.agentId,
    paneId: ref.paneId,
    runId: ref.runId,
    ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
  });
}

function channelKey(agentId: string, runId: string, name: string): string {
  return `${agentId}\0${runId}\0${name}`;
}

function consumerKey(agentId: string, name: string): string {
  return `${agentId}\0${name}`;
}

function mergeLimits(overrides: Partial<BridgeLimits> | undefined): Readonly<BridgeLimits> {
  const limits = { ...DEFAULT_BRIDGE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`Bridge limit ${name} must be positive`);
    }
  }
  if (limits.defaultRequestTimeoutMs > limits.maxRequestTimeoutMs) {
    throw new TypeError('Bridge default request timeout cannot exceed its maximum');
  }
  return Object.freeze(limits);
}

function parsePersistedState(raw: unknown): PersistedBridgeState {
  if (raw === null || raw === undefined) return { version: 1, channels: [] };
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.channels)) {
    throw new BridgeContractError('Unsupported or corrupt LocalAgentBridge state');
  }
  const channels: PersistedBridgeChannel[] = [];
  const keys = new Set<string>();
  for (const value of raw.channels) {
    if (!isRecord(value) || typeof value.agentId !== 'string' || !NAME_RE.test(value.agentId)
      || typeof value.name !== 'string' || !NAME_RE.test(value.name)
      || !validRunRef(value.run, value.agentId)
      || !isSafeSequence(value.highWatermark)
      || !isSafeSequence(value.lastEphemeralSequence)
      || value.lastEphemeralSequence > value.highWatermark
      || !Array.isArray(value.durable) || !Array.isArray(value.receipts)) {
      throw new BridgeContractError('Corrupt LocalAgentBridge channel state');
    }
    const key = channelKey(value.agentId, value.run.runId, value.name);
    if (keys.has(key)) throw new BridgeContractError('Duplicate LocalAgentBridge channel state');
    keys.add(key);
    const highWatermark = value.highWatermark;
    const lastEphemeralSequence = value.lastEphemeralSequence;

    const durable: PersistedBridgeDurableEvent[] = value.durable.map((event) => {
      if (!isRecord(event) || typeof event.eventId !== 'string' || !EVENT_ID_RE.test(event.eventId)
        || !isSafeSequence(event.sequence) || event.sequence === 0
        || event.sequence > highWatermark) {
        throw new BridgeContractError('Corrupt LocalAgentBridge durable event');
      }
      const payload = encodeValue(event.payload);
      return {
        eventId: event.eventId,
        sequence: event.sequence,
        payload: payload.value,
        bytes: payload.bytes + Buffer.byteLength(event.eventId) + 64,
      };
    }).sort((first, second) => first.sequence - second.sequence);
    if (new Set(durable.map((event) => event.eventId)).size !== durable.length) {
      throw new BridgeContractError('Duplicate LocalAgentBridge durable event id');
    }

    const receipts: PersistedBridgeReceipt[] = value.receipts.map((receipt) => {
      if (!isRecord(receipt) || typeof receipt.eventId !== 'string' || !EVENT_ID_RE.test(receipt.eventId)
        || !isSafeSequence(receipt.sequence) || receipt.sequence === 0
        || receipt.sequence > highWatermark
        || typeof receipt.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.payloadHash)
        || (receipt.delivery !== 'ephemeral' && receipt.delivery !== 'durable')) {
        throw new BridgeContractError('Corrupt LocalAgentBridge event receipt');
      }
      return {
        eventId: receipt.eventId,
        sequence: receipt.sequence,
        payloadHash: receipt.payloadHash,
        delivery: receipt.delivery,
      };
    });
    if (new Set(receipts.map((receipt) => receipt.eventId)).size !== receipts.length) {
      throw new BridgeContractError('Duplicate LocalAgentBridge event receipt');
    }
    for (const event of durable) {
      const receipt = receipts.find((candidate) => candidate.eventId === event.eventId);
      if (!receipt || receipt.sequence !== event.sequence || receipt.delivery !== 'durable') {
        throw new BridgeContractError('Durable LocalAgentBridge event is missing its stable receipt');
      }
    }

    let snapshot: PersistedBridgeChannel['snapshot'];
    if (value.snapshot !== undefined) {
      if (!isRecord(value.snapshot) || !isSafeSequence(value.snapshot.sequence)
        || value.snapshot.sequence === 0 || value.snapshot.sequence > value.highWatermark) {
        throw new BridgeContractError('Corrupt LocalAgentBridge snapshot');
      }
      const encoded = encodeValue(value.snapshot.value);
      snapshot = { sequence: value.snapshot.sequence, value: encoded.value, bytes: encoded.bytes };
    }
    channels.push({
      agentId: value.agentId,
      run: copyRunRef(value.run),
      name: value.name,
      highWatermark,
      lastEphemeralSequence,
      ...(snapshot ? { snapshot } : {}),
      durable,
      receipts,
    });
  }
  return { version: 1, channels };
}

export interface LocalAgentBridgeOptions {
  runs: AgentRunRegistry;
  adapterIds: readonly string[];
  store?: BridgeStateStore;
  limits?: Partial<BridgeLimits>;
  newConnectionId?: () => string;
  newRequestId?: () => string;
  now?: () => number;
  retryDelayMs?: number;
}

// Reliable Bridge semantics independent of the private transport codec. A future Unix-socket layer calls
// connect() after peer/nonce/run verification; tests can exercise the same ordering and persistence in-process.
export class LocalAgentBridge {
  readonly limits: Readonly<BridgeLimits>;
  readonly #runs: AgentRunRegistry;
  readonly #adapterIds: ReadonlySet<string>;
  readonly #store: BridgeStateStore;
  readonly #channels = new Map<string, RuntimeChannel>();
  readonly #connections = new Map<string, RuntimeConnection>();
  readonly #connectionIds = new Set<string>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #consumers = new Map<string, DurableConsumer>();
  readonly #newConnectionId: () => string;
  readonly #newRequestId: () => string;
  readonly #now: () => number;
  readonly #retryDelayMs: number;
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor({
    runs,
    adapterIds,
    store = new MemoryBridgeStateStore(),
    limits,
    newConnectionId = randomUUID,
    newRequestId = randomUUID,
    now = Date.now,
    retryDelayMs = 250,
  }: LocalAgentBridgeOptions) {
    if (!runs || !Array.isArray(adapterIds) || adapterIds.length === 0) {
      throw new TypeError('LocalAgentBridge requires a run registry and static adapter ids');
    }
    this.#runs = runs;
    this.#adapterIds = new Set(adapterIds);
    if (this.#adapterIds.size !== adapterIds.length
      || [...this.#adapterIds].some((id) => !NAME_RE.test(id))) {
      throw new TypeError('LocalAgentBridge adapter ids must be unique valid names');
    }
    this.#store = store;
    this.limits = mergeLimits(limits);
    this.#newConnectionId = newConnectionId;
    this.#newRequestId = newRequestId;
    this.#now = now;
    this.#retryDelayMs = Math.max(1, retryDelayMs);

    const persisted = parsePersistedState(this.#store.load());
    const spoolBytes = new Map<string, number>();
    for (const channel of persisted.channels) {
      if (channel.snapshot && channel.snapshot.bytes > this.limits.maxSnapshotBytes) {
        throw new BridgeContractError('Persisted Bridge snapshot exceeds the configured limit');
      }
      if (channel.durable.some((event) => event.bytes > this.limits.maxFrameBytes)) {
        throw new BridgeContractError('Persisted Bridge durable event exceeds the configured frame limit');
      }
      const adapterBytes = (spoolBytes.get(channel.agentId) ?? 0)
        + channel.durable.reduce((total, event) => total + event.bytes, 0);
      if (adapterBytes > this.limits.maxDurableSpoolBytesPerAdapter) {
        throw new BridgeContractError('Persisted Bridge durable spool exceeds the configured limit');
      }
      spoolBytes.set(channel.agentId, adapterBytes);
      const baseline = channel.snapshot?.sequence ?? 0;
      this.#channels.set(channelKey(channel.agentId, channel.run.runId, channel.name), {
        persisted: channel,
        live: [],
        liveBytes: 0,
        acceptedEphemeralSinceSnapshot: 0,
        continuityLost: channel.lastEphemeralSequence > baseline,
        gapAfter: undefined,
        gapEpoch: 0,
        subscription: undefined,
        pumping: false,
        pumpAgain: false,
        retryTimer: undefined,
        durableWaiters: [],
      });
    }
  }

  connect(run: AgentRunLease): LocalAgentBridgeConnection {
    this.#assertLive(run);
    const agentId = run.ref.agentId;
    this.#assertAdapter(agentId);
    if (this.#closed) throw new BridgeContractError('LocalAgentBridge is closed');

    const previous = this.#connections.get(run.ref.runId);
    const abort = new AbortController();
    const channels = new Map<string, LocalAgentBridgeChannel>();
    const handlers = new Map<string, RequestHandlerEntry>();
    let closed = false;
    const close = (reason: string = 'transport_closed'): void => {
      if (closed) return;
      closed = true;
      run.signal.removeEventListener('abort', onLeaseAbort);
      if (this.#connections.get(run.ref.runId)?.abort === abort) {
        this.#connections.delete(run.ref.runId);
      }
      this.#connectionIds.delete(connectionId);
      for (const entry of handlers.values()) {
        for (const pending of entry.pending) {
          pending.abort(new BridgeRequestError('unavailable', `Bridge request cancelled: ${reason}`));
        }
        entry.pending.clear();
      }
      handlers.clear();
      abort.abort(reason);
    };
    const onLeaseAbort = (): void => close('stale_lease');
    run.signal.addEventListener('abort', onLeaseAbort, { once: true });
    previous?.close('transport_replaced');

    let connectionId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const proposed = this.#newConnectionId();
      if (typeof proposed === 'string' && proposed.length > 0 && proposed.length <= 256
        && !this.#connectionIds.has(proposed)) {
        connectionId = proposed;
        break;
      }
    }
    if (!connectionId) throw new BridgeContractError('Unable to allocate a unique Bridge connectionId');
    this.#connectionIds.add(connectionId);
    const connection: LocalAgentBridgeConnection = Object.freeze({
      connectionId,
      signal: abort.signal,
      limits: this.limits,
      channel: (name: string) => {
        this.#assertName(name, 'channel');
        if (abort.signal.aborted) throw new BridgeContractError('Bridge connection is closed');
        const existing = channels.get(name);
        if (existing) return existing;
        const bucket: RateBucket = { tokens: this.limits.burstEvents, updatedAt: this.#now() };
        const created: LocalAgentBridgeChannel = Object.freeze({
          setSnapshot: (value: unknown) => this.#setSnapshot(run, abort.signal, name, value),
          publish: (event: BridgePublishRequest, options?: { delivery?: 'ephemeral' | 'durable' }) => (
            this.#publish(run, abort.signal, name, bucket, event, options?.delivery ?? 'ephemeral')
          ),
          handle: (method: string, handler: BridgeRequestHandler) => {
            this.#assertName(method, 'method');
            if (abort.signal.aborted || typeof handler !== 'function') {
              throw new BridgeContractError('Bridge request handler requires a live connection');
            }
            const key = `${name}\0${method}`;
            if (handlers.has(key)) {
              throw new BridgeContractError('Bridge request handler is already registered');
            }
            const entry: RequestHandlerEntry = { handler, pending: new Set() };
            handlers.set(key, entry);
            return () => {
              if (handlers.get(key) !== entry) return;
              handlers.delete(key);
              for (const pending of entry.pending) {
                pending.abort(new BridgeRequestError('unavailable', 'Bridge request handler was removed'));
              }
              entry.pending.clear();
            };
          },
        });
        channels.set(name, created);
        return created;
      },
      close: () => close(),
    });
    this.#connections.set(run.ref.runId, {
      agentId,
      runId: run.ref.runId,
      abort,
      handlers,
      close,
    });
    return connection;
  }

  hostFor(agentId: string): LocalAgentBridgeHost {
    if (this.#closed) throw new BridgeContractError('LocalAgentBridge is closed');
    this.#assertAdapter(agentId);
    return Object.freeze({
      limits: this.limits,
      openChannel: (run: AgentRunLease, name: string, sink: BridgeHostEventSink) => (
        this.#openChannel(agentId, run, name, sink)
      ),
      consumeDurableReplays: (name: string, sink: BridgeDurableReplaySink) => (
        this.#consumeDurable(agentId, name, sink)
      ),
      drainDurable: (
        run: AgentRunRef,
        name: string,
        throughSequence: number,
        options?: { signal?: AbortSignal },
      ) => (
        this.#drainDurable(agentId, run, name, throughSequence, options?.signal)
      ),
      request: (
        run: AgentRunLease,
        channel: string,
        method: string,
        payload: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => this.#request(agentId, run, channel, method, payload, options),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    for (const consumer of this.#consumers.values()) consumer.active = false;
    this.#consumers.clear();
    for (const state of this.#channels.values()) {
      this.#closeSubscription(state);
      if (state.retryTimer) clearTimeout(state.retryTimer);
      for (const waiter of state.durableWaiters) {
        waiter.detachAbort();
        waiter.reject(new BridgeContractError('LocalAgentBridge closed before durable drain completed'));
      }
      state.durableWaiters = [];
    }
    await this.#writeTail.catch(() => {});
  }

  #assertAdapter(agentId: string): void {
    if (!this.#adapterIds.has(agentId)) throw new BridgeContractError(`Unknown Agent adapter: ${agentId}`);
  }

  #assertName(name: string, kind: string): void {
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.startsWith('handmux.')) {
      throw new BridgeContractError(`Invalid or reserved Bridge ${kind} name`);
    }
  }

  #assertLive(run: AgentRunLease): void {
    if (this.#closed || !run || run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
      throw new BridgeContractError('Bridge operation requires a live Agent run lease');
    }
  }

  #isLive(run: AgentRunLease, signal?: AbortSignal): boolean {
    return !this.#closed && !signal?.aborted && !run.signal.aborted && this.#runs.resolve(run.ref) === run;
  }

  #stateFor(run: AgentRunLease, name: string): RuntimeChannel {
    const key = channelKey(run.ref.agentId, run.ref.runId, name);
    let state = this.#channels.get(key);
    if (!state) {
      state = {
        persisted: {
          agentId: run.ref.agentId,
          run: copyRunRef(run.ref),
          name,
          highWatermark: 0,
          lastEphemeralSequence: 0,
          durable: [],
          receipts: [],
        },
        live: [],
        liveBytes: 0,
        acceptedEphemeralSinceSnapshot: 0,
        continuityLost: false,
        gapAfter: undefined,
        gapEpoch: 0,
        subscription: undefined,
        pumping: false,
        pumpAgain: false,
        retryTimer: undefined,
        durableWaiters: [],
      };
      this.#channels.set(key, state);
    }
    return state;
  }

  async #withWrite<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #save(): void {
    this.#store.save({
      version: 1,
      channels: [...this.#channels.values()].map((state) => structuredClone(state.persisted)),
    });
  }

  #nextSequence(state: RuntimeChannel): number {
    if (state.persisted.highWatermark >= Number.MAX_SAFE_INTEGER) {
      throw new BridgeContractError('Bridge channel sequence is exhausted');
    }
    state.persisted.highWatermark += 1;
    return state.persisted.highWatermark;
  }

  #takeRate(bucket: RateBucket): boolean {
    const now = this.#now();
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.limits.burstEvents,
      bucket.tokens + elapsedSeconds * this.limits.sustainedEventsPerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #loseContinuity(state: RuntimeChannel): void {
    state.continuityLost = true;
    state.live = [];
    state.liveBytes = 0;
    state.gapAfter = state.subscription?.deliveredSequence
      ?? state.persisted.snapshot?.sequence
      ?? 0;
    state.gapEpoch += 1;
    this.#schedulePump(state);
  }

  async #setSnapshot(
    run: AgentRunLease,
    connectionSignal: AbortSignal,
    name: string,
    rawValue: unknown,
  ): Promise<BridgeWriteReceipt> {
    if (!this.#isLive(run, connectionSignal)) return { accepted: false, reason: 'stale_lease' };
    let encoded: EncodedValue;
    try { encoded = encodeValue(rawValue); } catch { return { accepted: false, reason: 'invalid' }; }
    if (encoded.bytes > this.limits.maxSnapshotBytes) return { accepted: false, reason: 'invalid' };

    return this.#withWrite(async () => {
      if (!this.#isLive(run, connectionSignal)) return { accepted: false, reason: 'stale_lease' };
      const state = this.#stateFor(run, name);
      const before = structuredClone(state.persisted);
      try {
        state.persisted.run = copyRunRef(run.ref);
        const sequence = this.#nextSequence(state);
        state.persisted.snapshot = { sequence, value: encoded.value, bytes: encoded.bytes };
        this.#save();
        state.live = [];
        state.liveBytes = 0;
        state.acceptedEphemeralSinceSnapshot = 0;
        state.continuityLost = false;
        state.gapAfter = undefined;
        state.gapEpoch += 1;
        if (state.subscription) {
          state.live.push({
            sequence,
            bytes: encoded.bytes,
            event: { type: 'snapshot', sequence, value: structuredClone(encoded.value) },
          });
          state.liveBytes = encoded.bytes;
        }
        this.#schedulePump(state);
        return { accepted: true, sequence };
      } catch {
        state.persisted = before;
        return { accepted: false, reason: 'invalid' };
      }
    });
  }

  async #publish(
    run: AgentRunLease,
    connectionSignal: AbortSignal,
    name: string,
    bucket: RateBucket,
    event: BridgePublishRequest,
    delivery: 'ephemeral' | 'durable',
  ): Promise<BridgeWriteReceipt> {
    if (!this.#isLive(run, connectionSignal)) return { accepted: false, reason: 'stale_lease' };
    if (!isRecord(event) || (event.eventId !== undefined
      && (typeof event.eventId !== 'string' || !EVENT_ID_RE.test(event.eventId)))) {
      return { accepted: false, reason: 'invalid' };
    }
    if (delivery === 'durable' && !event.eventId) return { accepted: false, reason: 'invalid' };
    if (delivery !== 'ephemeral' && delivery !== 'durable') return { accepted: false, reason: 'invalid' };
    let encoded: EncodedValue;
    try { encoded = encodeValue(event.payload); } catch { return { accepted: false, reason: 'invalid' }; }
    const frameBytes = encoded.bytes + (event.eventId ? Buffer.byteLength(event.eventId) : 0) + 64;
    if (frameBytes > this.limits.maxFrameBytes) return { accepted: false, reason: 'invalid' };

    return this.#withWrite(async () => {
      if (!this.#isLive(run, connectionSignal)) return { accepted: false, reason: 'stale_lease' };
      const state = this.#stateFor(run, name);
      const existing = event.eventId
        ? state.persisted.receipts.find((receipt) => receipt.eventId === event.eventId)
        : undefined;
      if (existing) {
        if (existing.payloadHash !== encoded.hash || existing.delivery !== delivery) {
          return { accepted: false, reason: 'invalid' };
        }
        return { accepted: true, sequence: existing.sequence, reason: 'duplicate' };
      }

      if (!this.#takeRate(bucket)) {
        if (delivery === 'ephemeral') this.#loseContinuity(state);
        return { accepted: false, reason: 'rate_limited' };
      }
      if (delivery === 'ephemeral') {
        const eventCount = state.live.filter((operation) => operation.event.type === 'event').length;
        if (eventCount >= this.limits.maxQueuedEventsPerChannel
          || state.liveBytes + frameBytes > this.limits.maxQueuedBytesPerChannel) {
          this.#loseContinuity(state);
          return { accepted: false, reason: 'rate_limited' };
        }
      } else {
        const adapterSpoolBytes = [...this.#channels.values()]
          .filter((candidate) => candidate.persisted.agentId === run.ref.agentId)
          .flatMap((candidate) => candidate.persisted.durable)
          .reduce((total, item) => total + item.bytes, 0);
        if (adapterSpoolBytes + frameBytes > this.limits.maxDurableSpoolBytesPerAdapter) {
          return { accepted: false, reason: 'spool_full' };
        }
      }

      const before = structuredClone(state.persisted);
      try {
        state.persisted.run = copyRunRef(run.ref);
        const sequence = this.#nextSequence(state);
        if (event.eventId) {
          state.persisted.receipts.push({
            eventId: event.eventId,
            sequence,
            payloadHash: encoded.hash,
            delivery,
          });
        }
        if (delivery === 'durable') {
          state.persisted.durable.push({
            eventId: event.eventId!,
            sequence,
            payload: encoded.value,
            bytes: frameBytes,
          });
        } else {
          state.persisted.lastEphemeralSequence = sequence;
        }
        this.#save();

        if (delivery === 'ephemeral') {
          const envelope: BridgeEventEnvelope = {
            ...(event.eventId ? { eventId: event.eventId } : {}),
            sequence,
            payload: structuredClone(encoded.value),
          };
          state.live.push({
            sequence,
            bytes: frameBytes,
            event: { type: 'event', event: envelope },
          });
          state.liveBytes += frameBytes;
          state.acceptedEphemeralSinceSnapshot += 1;
        }
        this.#schedulePump(state);
        return { accepted: true, sequence };
      } catch {
        state.persisted = before;
        return { accepted: false, reason: delivery === 'durable' ? 'spool_full' : 'invalid' };
      }
    });
  }

  async #openChannel(
    agentId: string,
    run: AgentRunLease,
    name: string,
    sink: BridgeHostEventSink,
  ): Promise<BridgeHostChannelHandle> {
    this.#assertName(name, 'channel');
    this.#assertLive(run);
    if (run.ref.agentId !== agentId || typeof sink !== 'function') {
      throw new BridgeContractError('Bridge host channel is outside its scoped Agent adapter');
    }
    return this.#withWrite(async () => {
      this.#assertLive(run);
      const state = this.#stateFor(run, name);
      this.#closeSubscription(state);
      state.persisted.run = copyRunRef(run.ref);
      const baseline = state.persisted.snapshot?.sequence ?? 0;
      state.live = state.live.filter((operation) => operation.sequence > baseline);
      state.liveBytes = state.live.reduce((total, operation) => total + operation.bytes, 0);
      if (state.continuityLost
        || state.acceptedEphemeralSinceSnapshot > state.live.filter((operation) => (
          operation.event.type === 'event'
        )).length) {
        state.gapAfter = baseline;
        state.gapEpoch += 1;
      }

      const subscription: LiveSubscription = {
        sink,
        deliveredSequence: baseline,
        closed: false,
        detachAbort: () => {},
      };
      const onAbort = (): void => {
        if (state.subscription === subscription) this.#closeSubscription(state);
      };
      run.signal.addEventListener('abort', onAbort, { once: true });
      subscription.detachAbort = () => run.signal.removeEventListener('abort', onAbort);
      state.subscription = subscription;
      setTimeout(() => this.#schedulePump(state), 0).unref?.();

      const snapshot = state.persisted.snapshot;
      return Object.freeze({
        ...(snapshot ? { snapshot: structuredClone(snapshot.value) } : {}),
        snapshotAvailability: snapshot ? 'ready' as const : 'unavailable' as const,
        streamSequence: baseline,
        close: () => {
          if (state.subscription === subscription) this.#closeSubscription(state);
        },
      });
    });
  }

  #consumeDurable(
    agentId: string,
    name: string,
    sink: BridgeDurableReplaySink,
  ): () => void {
    if (this.#closed) throw new BridgeContractError('LocalAgentBridge is closed');
    this.#assertName(name, 'channel');
    if (typeof sink !== 'function') throw new BridgeContractError('Durable replay sink is required');
    const key = consumerKey(agentId, name);
    if (this.#consumers.has(key)) {
      throw new BridgeContractError('A durable replay consumer is already registered for this channel');
    }
    const consumer: DurableConsumer = { sink, active: true };
    this.#consumers.set(key, consumer);
    for (const state of this.#channels.values()) {
      if (state.persisted.agentId === agentId && state.persisted.name === name) this.#schedulePump(state);
    }
    return () => {
      consumer.active = false;
      if (this.#consumers.get(key) === consumer) this.#consumers.delete(key);
    };
  }

  async #drainDurable(
    agentId: string,
    run: AgentRunRef,
    name: string,
    throughSequence: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertName(name, 'channel');
    if (signal?.aborted) throw new BridgeContractError('Durable drain was cancelled');
    if (this.#closed || !run || run.agentId !== agentId
      || this.#runs.status(run) === 'unknown'
      || !Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new BridgeContractError('Invalid durable drain boundary');
    }
    let pending: Promise<void> | null = null;
    await this.#withWrite(async () => {
      if (signal?.aborted) throw new BridgeContractError('Durable drain was cancelled');
      if (this.#closed) {
        throw new BridgeContractError('LocalAgentBridge closed before durable drain started');
      }
      const state = this.#channels.get(channelKey(agentId, run.runId, name));
      if (!state || !state.persisted.durable.some((event) => event.sequence <= throughSequence)) return;
      pending = new Promise<void>((resolve, reject) => {
        const waiter = {
          throughSequence,
          resolve,
          reject,
          detachAbort: () => {},
        };
        if (signal) {
          const onAbort = (): void => {
            const index = state.durableWaiters.indexOf(waiter);
            if (index !== -1) state.durableWaiters.splice(index, 1);
            reject(new BridgeContractError('Durable drain was cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
        }
        state.durableWaiters.push(waiter);
      });
      this.#schedulePump(state);
    });
    if (pending) await pending;
  }

  #resolveDurableWaiters(state: RuntimeChannel): void {
    const remaining = state.durableWaiters.filter((waiter) => {
      if (state.persisted.durable.some((event) => event.sequence <= waiter.throughSequence)) return true;
      waiter.detachAbort();
      waiter.resolve();
      return false;
    });
    state.durableWaiters = remaining;
  }

  async #request(
    agentId: string,
    run: AgentRunLease,
    channel: string,
    method: string,
    payload: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } | undefined,
  ): Promise<unknown> {
    this.#assertName(channel, 'channel');
    this.#assertName(method, 'method');
    this.#assertLive(run);
    if (run.ref.agentId !== agentId) {
      throw new BridgeContractError('Bridge request lease belongs to another adapter');
    }
    if (options?.signal?.aborted) {
      throw new BridgeRequestError('cancelled', 'Bridge request was cancelled before dispatch');
    }
    const timeoutMs = options?.timeoutMs ?? this.limits.defaultRequestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || timeoutMs > this.limits.maxRequestTimeoutMs) {
      throw new BridgeContractError('Bridge request timeout is outside the configured limit');
    }
    const encoded = encodeValue(payload);
    if (encoded.bytes > this.limits.maxFrameBytes) {
      throw new BridgeContractError('Bridge request payload exceeds the configured frame limit');
    }

    const connection = this.#connections.get(run.ref.runId);
    if (!connection || connection.agentId !== agentId || connection.abort.signal.aborted) {
      throw new BridgeRequestError('unavailable', 'Bridge request connection is unavailable');
    }
    const entry = connection.handlers.get(`${channel}\0${method}`);
    if (!entry) throw new BridgeRequestError('unavailable', 'Bridge request handler is unavailable');

    let runPending = 0;
    let adapterPending = 0;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.agentId !== agentId) continue;
      adapterPending += 1;
      if (pending.runId === run.ref.runId) runPending += 1;
    }
    if (runPending >= this.limits.maxRequestsPerRun
      || adapterPending >= this.limits.maxRequestsPerAdapter) {
      throw new BridgeRequestError('limit_exceeded', 'Bridge request concurrency limit reached');
    }

    let requestId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const proposed = this.#newRequestId();
      if (typeof proposed === 'string' && proposed.length > 0 && proposed.length <= 256
        && !this.#pendingRequests.has(proposed)) {
        requestId = proposed;
        break;
      }
    }
    if (!requestId) throw new BridgeContractError('Unable to allocate a unique Bridge requestId');

    const abort = new AbortController();
    const deadlineAt = this.#now() + timeoutMs;
    const context: BridgeRequestContext = Object.freeze({
      requestId,
      deadlineAt,
      signal: abort.signal,
    });
    this.#pendingRequests.set(requestId, { agentId, runId: run.ref.runId, abort });
    entry.pending.add(abort);
    const onCallerAbort = (): void => {
      abort.abort(new BridgeRequestError('cancelled', 'Bridge request was cancelled by the caller'));
    };
    options?.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const finish = (result: { value: unknown } | { error: Error }): void => {
          if (settled) return;
          settled = true;
          if ('error' in result) reject(result.error);
          else resolve(result.value);
        };
        const onAbort = (): void => {
          const reason = abort.signal.reason;
          finish({
            error: reason instanceof BridgeRequestError
              ? reason : new BridgeRequestError('cancelled', 'Bridge request was cancelled'),
          });
        };
        abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          abort.abort(new BridgeRequestError('timeout', 'Bridge request timed out'));
        }, timeoutMs);
        timer.unref?.();

        Promise.resolve()
          .then(() => entry.handler(structuredClone(encoded.value), context))
          .then((value) => {
            if (settled) return;
            try {
              const response = encodeValue(value);
              if (response.bytes > this.limits.maxFrameBytes) {
                finish({
                  error: new BridgeRequestError(
                    'invalid_response',
                    'Bridge request response exceeds the configured frame limit',
                  ),
                });
                return;
              }
              finish({ value: response.value });
            } catch {
              finish({
                error: new BridgeRequestError(
                  'invalid_response',
                  'Bridge request handler returned an invalid response',
                ),
              });
            }
          }, () => {
            finish({ error: new BridgeRequestError('handler_error', 'Bridge request handler failed') });
          });
      });
    } finally {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onCallerAbort);
      entry.pending.delete(abort);
      this.#pendingRequests.delete(requestId);
    }
  }

  #closeSubscription(state: RuntimeChannel): void {
    const subscription = state.subscription;
    if (!subscription) return;
    subscription.closed = true;
    subscription.detachAbort();
    state.subscription = undefined;
  }

  #schedulePump(state: RuntimeChannel): void {
    if (this.#closed) return;
    if (state.pumping) {
      state.pumpAgain = true;
      return;
    }
    state.pumping = true;
    queueMicrotask(() => { void this.#pump(state); });
  }

  #scheduleRetry(state: RuntimeChannel): void {
    if (state.retryTimer || this.#closed) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      this.#schedulePump(state);
    }, this.#retryDelayMs);
    state.retryTimer.unref?.();
  }

  async #pump(state: RuntimeChannel): Promise<void> {
    try {
      do {
        state.pumpAgain = false;
        while (!this.#closed) {
          const durable = state.persisted.durable[0];
          const live = state.live[0];
          const gapAfter = state.gapAfter;
          const gapEpoch = state.gapEpoch;

          if (gapAfter !== undefined && (!durable || durable.sequence > gapAfter)) {
            const subscription = state.subscription;
            if (!subscription || subscription.closed) break;
            try {
              await subscription.sink({ type: 'gap', afterSequence: gapAfter });
              if (state.subscription !== subscription) continue;
              subscription.deliveredSequence = Math.max(subscription.deliveredSequence, gapAfter);
              if (state.gapEpoch === gapEpoch) state.gapAfter = undefined;
            } catch {
              this.#closeSubscription(state);
              break;
            }
            continue;
          }

          if (durable && (!live || durable.sequence < live.sequence)) {
            const consumer = this.#consumers.get(consumerKey(state.persisted.agentId, state.persisted.name));
            if (!consumer?.active) break;
            let result: BridgeDurableReplayResult = 'retry';
            try {
              result = await consumer.sink({
                run: copyRunRef(state.persisted.run),
                runStatus: this.#runs.resolve(state.persisted.run) ? 'current' : 'revoked',
                event: {
                  eventId: durable.eventId,
                  sequence: durable.sequence,
                  payload: structuredClone(durable.payload),
                },
              });
            } catch { result = 'retry'; }
            if (result === 'retry') {
              this.#scheduleRetry(state);
              break;
            }
            if (result !== 'accepted' && result !== 'invalid') {
              this.#scheduleRetry(state);
              break;
            }
            const removed = await this.#withWrite(async () => {
              const current = state.persisted.durable[0];
              if (!current || current.sequence !== durable.sequence) return true;
              const before = structuredClone(state.persisted);
              try {
                state.persisted.durable.shift();
                this.#save();
                return true;
              } catch {
                state.persisted = before;
                this.#scheduleRetry(state);
                return false;
              }
            });
            if (!removed) break;
            this.#resolveDurableWaiters(state);
            continue;
          }

          if (live) {
            const subscription = state.subscription;
            if (!subscription || subscription.closed) {
              if (durable) {
                if (live.event.type === 'snapshot') {
                  state.live.shift();
                  state.liveBytes -= live.bytes;
                } else {
                  this.#loseContinuity(state);
                }
                continue;
              }
              break;
            }
            try {
              await subscription.sink(structuredClone(live.event));
              if (state.subscription !== subscription) continue;
              if (state.live[0] === live) {
                state.live.shift();
                state.liveBytes -= live.bytes;
              }
              subscription.deliveredSequence = Math.max(subscription.deliveredSequence, live.sequence);
            } catch {
              this.#closeSubscription(state);
              break;
            }
            continue;
          }

          if (durable) continue;
          break;
        }
      } while (state.pumpAgain && !this.#closed);
    } finally {
      state.pumping = false;
      if (state.pumpAgain && !this.#closed) this.#schedulePump(state);
    }
  }
}
