import fs from 'node:fs';
import path from 'node:path';
import { PrivateStateStore } from '../src/privateStateStore.js';
import { connectBridgeTransport } from '../src/agent-runtime/bridgeTransport.js';
import type { BridgeTransportClientConnection } from '../src/agent-runtime/bridgeTransport.js';
import type {
  BridgePublishRequest,
  BridgeRequestContext,
  BridgeRequestHandler,
} from '../src/agent-runtime/bridgeTypes.js';
import type { AgentAttachmentCandidate } from '../src/agent-runtime/run.js';

interface DurableWrite { channel: string; eventId: string; payload: unknown }
interface StoredConnectorBridgeState {
  version: 1;
  snapshots: Record<string, unknown>;
  durable: DurableWrite[];
}
interface SnapshotEntry { revision: number; value: unknown }
interface HandlerEntry { channel: string; method: string; handler: BridgeRequestHandler }
type ConnectorBridgeHandler = (
  payload: unknown,
  context: BridgeRequestContext,
) => unknown | Promise<unknown>;

export interface LocalConnectorBridgeClientOptions {
  adapterId: string;
  socketPath: string;
  credentialFile: string;
  stateFile: string;
  candidate: AgentAttachmentCandidate;
  generation?: { id: string; replace: true };
  connect?: typeof connectBridgeTransport;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxEphemeralPerChannel?: number;
  logger?: (message: string, error?: unknown) => void;
}

const NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(value: unknown): StoredConnectorBridgeState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.snapshots)
    || !Array.isArray(value.durable)) {
    return { version: 1, snapshots: {}, durable: [] };
  }
  const durable: DurableWrite[] = [];
  const ids = new Set<string>();
  for (const item of value.durable) {
    if (!isRecord(item) || typeof item.channel !== 'string' || !NAME_RE.test(item.channel)
      || typeof item.eventId !== 'string' || !EVENT_ID_RE.test(item.eventId)
      || ids.has(`${item.channel}\0${item.eventId}`)) continue;
    ids.add(`${item.channel}\0${item.eventId}`);
    durable.push({ channel: item.channel, eventId: item.eventId, payload: item.payload });
  }
  return { version: 1, snapshots: structuredClone(value.snapshots), durable };
}

function credential(file: string): string {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(value) || value.version !== 1 || typeof value.authToken !== 'string'
    || value.authToken.length < 32 || value.authToken.length > 1024) {
    throw new Error('Handmux Agent Runtime credential is unavailable or invalid');
  }
  return value.authToken;
}

function samePayload(first: unknown, second: unknown): boolean {
  try { return JSON.stringify(first) === JSON.stringify(second); } catch { return false; }
}

function durableKey(channel: string, eventId: string): string {
  return `${channel}\0${eventId}`;
}

// Shared only by Handmux-owned built-in Connectors. Provider callbacks enqueue local state synchronously;
// socket retries and ordered flushing stay here so every Connector gets the same offline semantics.
export class LocalConnectorBridgeClient {
  readonly #adapterId: string;
  readonly #socketPath: string;
  readonly #credentialFile: string;
  readonly #candidate: AgentAttachmentCandidate;
  readonly #connect: typeof connectBridgeTransport;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #maxEphemeralPerChannel: number;
  readonly #logger: NonNullable<LocalConnectorBridgeClientOptions['logger']>;
  readonly #store: PrivateStateStore<StoredConnectorBridgeState>;
  readonly #snapshots = new Map<string, SnapshotEntry>();
  readonly #dirtySnapshots = new Set<string>();
  readonly #unpersistedSnapshots = new Set<string>();
  readonly #ephemeral = new Map<string, BridgePublishRequest[]>();
  readonly #dropped = new Set<string>();
  readonly #handlers = new Map<string, HandlerEntry>();
  readonly #durableWaiters = new Map<string, Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>>();
  #state: StoredConnectorBridgeState;
  #generation: { id: string; replace: true } | undefined;
  #connection: BridgeTransportClientConnection | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #retryAttempt = 0;
  #flushTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor({
    adapterId, socketPath, credentialFile, stateFile, candidate, generation,
    connect = connectBridgeTransport,
    retryDelayMs = 250,
    maxRetryDelayMs = 5_000,
    maxEphemeralPerChannel = 256,
    logger = () => {},
  }: LocalConnectorBridgeClientOptions) {
    if (!NAME_RE.test(adapterId) || !path.isAbsolute(socketPath)
      || !path.isAbsolute(credentialFile) || !path.isAbsolute(stateFile)
      || !candidate || !Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0
      || !Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs
      || !Number.isSafeInteger(maxEphemeralPerChannel) || maxEphemeralPerChannel <= 0) {
      throw new TypeError('Connector Bridge client requires an adapter, private paths, and bounded retries');
    }
    this.#adapterId = adapterId;
    this.#socketPath = socketPath;
    this.#credentialFile = credentialFile;
    this.#candidate = structuredClone(candidate);
    this.#generation = generation;
    this.#connect = connect;
    this.#retryDelayMs = retryDelayMs;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#maxEphemeralPerChannel = maxEphemeralPerChannel;
    this.#logger = logger;
    this.#store = new PrivateStateStore(stateFile);
    this.#state = parseState(this.#store.read());
    for (const [channel, value] of Object.entries(this.#state.snapshots)) {
      if (!NAME_RE.test(channel)) continue;
      this.#snapshots.set(channel, { revision: 1, value });
      this.#dirtySnapshots.add(channel);
    }
  }

  start(): void {
    if (this.#closed) throw new Error('Connector Bridge client is closed');
    if (this.#started) return;
    this.#started = true;
    this.#scheduleConnect(0);
  }

  setSnapshot(channel: string, value: unknown): boolean {
    this.#assertName(channel);
    if (this.#closed) return false;
    const previous = this.#snapshots.get(channel);
    if (previous && samePayload(previous.value, value)) {
      const persisted = !this.#unpersistedSnapshots.has(channel) || this.#persist();
      if (persisted) this.#unpersistedSnapshots.delete(channel);
      this.#kickFlush();
      return persisted;
    }
    this.#snapshots.set(channel, { revision: (previous?.revision ?? 0) + 1, value: structuredClone(value) });
    this.#dirtySnapshots.add(channel);
    this.#state.snapshots[channel] = structuredClone(value);
    const persisted = this.#persist();
    if (persisted) this.#unpersistedSnapshots.delete(channel);
    else this.#unpersistedSnapshots.add(channel);
    this.#kickFlush();
    return persisted;
  }

  publishDurable(channel: string, eventId: string, payload: unknown): boolean {
    this.#assertName(channel);
    if (!EVENT_ID_RE.test(eventId)) throw new Error('Durable event requires a stable bounded eventId');
    if (this.#closed) return false;
    const existing = this.#state.durable.find((item) => (
      item.channel === channel && item.eventId === eventId
    ));
    if (existing) {
      if (!samePayload(existing.payload, payload)) {
        throw new Error('Durable eventId was reused with a different payload');
      }
      return true;
    }
    const item = { channel, eventId, payload: structuredClone(payload) };
    this.#state.durable.push(item);
    if (!this.#persist()) {
      const index = this.#state.durable.indexOf(item);
      if (index !== -1) this.#state.durable.splice(index, 1);
      return false;
    }
    this.#kickFlush();
    return true;
  }

  waitForDurableAck(channel: string, eventId: string): Promise<void> {
    this.#assertName(channel);
    if (!EVENT_ID_RE.test(eventId)) return Promise.reject(new Error('Invalid durable eventId'));
    if (!this.#state.durable.some((item) => item.channel === channel && item.eventId === eventId)) {
      return Promise.resolve();
    }
    if (this.#closed) return Promise.reject(new Error('Connector Bridge client is closed'));
    const key = durableKey(channel, eventId);
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#durableWaiters.get(key) ?? new Set();
      if (!this.#durableWaiters.has(key)) this.#durableWaiters.set(key, waiters);
      waiters.add({ resolve, reject });
    });
  }

  waitForDurableDrain(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Connector Bridge client is closed'));
    const pending = this.#state.durable.map(({ channel, eventId }) => (
      this.waitForDurableAck(channel, eventId)
    ));
    return Promise.all(pending).then(() => undefined);
  }

  closeAndRemoveIfDrained(): boolean {
    if (this.#state.durable.length !== 0) return false;
    this.close();
    try {
      this.#store.remove();
      return true;
    } catch (error) {
      this.#logger('Drained Connector Bridge state could not be removed', error);
      return false;
    }
  }

  publishEphemeral(channel: string, payload: unknown): void {
    this.#assertName(channel);
    if (this.#closed) return;
    const queue = this.#ephemeral.get(channel) ?? [];
    if (!this.#ephemeral.has(channel)) this.#ephemeral.set(channel, queue);
    if (queue.length >= this.#maxEphemeralPerChannel) {
      queue.shift();
      this.#dropped.add(channel);
    }
    queue.push({ payload: structuredClone(payload) });
    this.#kickFlush();
  }

  handle(channel: string, method: string, handler: ConnectorBridgeHandler): () => void {
    this.#assertName(channel);
    this.#assertName(method);
    if (typeof handler !== 'function' || this.#closed) throw new Error('Invalid Connector Bridge handler');
    const key = `${channel}\0${method}`;
    if (this.#handlers.has(key)) throw new Error('Connector Bridge handler is already registered');
    const wrapped: BridgeRequestHandler = async (payload, context) => handler(payload, context);
    const entry = { channel, method, handler: wrapped };
    this.#handlers.set(key, entry);
    if (this.#connection) {
      void this.#connection.channel(channel).handle(method, wrapped).catch((error) => {
        this.#logger(`Failed to register Bridge handler ${channel}.${method}`, error);
        this.#connection?.close();
      });
    }
    return () => { if (this.#handlers.get(key) === entry) this.#handlers.delete(key); };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#connection?.close();
    this.#connection = undefined;
    const error = new Error('Connector Bridge client is closed');
    for (const waiters of this.#durableWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.#durableWaiters.clear();
  }

  #assertName(value: string): void {
    if (!NAME_RE.test(value)) throw new Error('Invalid Bridge channel or method name');
  }

  #persist(): boolean {
    try { this.#store.write(this.#state); return true; }
    catch (error) {
      this.#logger('Connector Bridge local state could not be persisted', error);
      return false;
    }
  }

  #resolveDurable(channel: string, eventId: string): void {
    const key = durableKey(channel, eventId);
    const waiters = this.#durableWaiters.get(key);
    if (!waiters) return;
    this.#durableWaiters.delete(key);
    for (const waiter of waiters) waiter.resolve();
  }

  #invalidateEphemeral(): void {
    for (const [channel, queue] of this.#ephemeral) {
      if (!queue.length) continue;
      queue.splice(0);
      this.#dropped.add(channel);
    }
  }

  #scheduleConnect(delay: number): void {
    if (!this.#started || this.#closed || this.#connection || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#open();
    }, delay);
    this.#retryTimer.unref?.();
  }

  async #open(): Promise<void> {
    if (this.#closed || this.#connection) return;
    try {
      const connection = await this.#connect({
        socketPath: this.#socketPath,
        authToken: credential(this.#credentialFile),
        adapterId: this.#adapterId,
        candidate: this.#candidate,
        ...(this.#generation === undefined ? {} : { generation: this.#generation }),
      });
      if (this.#closed) { connection.close(); return; }
      this.#connection = connection;
      this.#generation = undefined;
      this.#retryAttempt = 0;
      for (const channel of this.#snapshots.keys()) this.#dirtySnapshots.add(channel);
      for (const entry of this.#handlers.values()) {
        await connection.channel(entry.channel).handle(entry.method, entry.handler);
      }
      connection.signal.addEventListener('abort', () => {
        if (this.#connection === connection) this.#connection = undefined;
        this.#scheduleRetry();
      }, { once: true });
      this.#kickFlush();
    } catch (error) {
      this.#connection?.close();
      this.#connection = undefined;
      this.#invalidateEphemeral();
      this.#logger('Connector Bridge connection failed; retrying in background', error);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    if (this.#closed) return;
    const delay = Math.min(this.#maxRetryDelayMs, this.#retryDelayMs * (2 ** this.#retryAttempt));
    this.#retryAttempt = Math.min(this.#retryAttempt + 1, 20);
    this.#scheduleConnect(delay);
  }

  #kickFlush(): void {
    if (!this.#connection || this.#closed) return;
    const pending = this.#flushTail.then(() => this.#flush());
    this.#flushTail = pending.catch((error) => {
      this.#invalidateEphemeral();
      this.#logger('Connector Bridge flush failed; state remains queued', error);
      this.#connection?.close();
    });
  }

  async #flush(): Promise<void> {
    const connection = this.#connection;
    if (!connection || connection.signal.aborted || this.#closed) return;
    while (this.#state.durable.length) {
      const item = this.#state.durable[0]!;
      const receipt = await connection.channel(item.channel).publish({
        eventId: item.eventId, payload: item.payload,
      }, { delivery: 'durable' });
      if (!receipt.accepted && receipt.reason !== 'duplicate') {
        throw new Error(`Durable Bridge write rejected: ${receipt.reason ?? 'unknown'}`);
      }
      this.#state.durable.shift();
      if (!this.#persist()) {
        this.#state.durable.unshift(item);
        throw new Error('Durable Bridge acknowledgement could not be persisted locally');
      }
      this.#resolveDurable(item.channel, item.eventId);
    }
    for (const channel of [...this.#dirtySnapshots]) {
      const entry = this.#snapshots.get(channel);
      if (!entry) { this.#dirtySnapshots.delete(channel); continue; }
      const revision = entry.revision;
      const receipt = await connection.channel(channel).setSnapshot(entry.value);
      if (!receipt.accepted) throw new Error(`Bridge snapshot rejected: ${receipt.reason ?? 'unknown'}`);
      if (this.#snapshots.get(channel)?.revision === revision) this.#dirtySnapshots.delete(channel);
    }
    for (const channel of [...this.#dropped]) {
      const receipt = await connection.channel(channel).publish({ payload: { type: 'stream.gap' } });
      if (!receipt.accepted) throw new Error(`Bridge gap rejected: ${receipt.reason ?? 'unknown'}`);
      this.#dropped.delete(channel);
    }
    for (const [channel, queue] of this.#ephemeral) {
      while (queue.length) {
        const event = queue[0]!;
        const receipt = await connection.channel(channel).publish(event);
        if (!receipt.accepted) throw new Error(`Bridge event rejected: ${receipt.reason ?? 'unknown'}`);
        queue.shift();
      }
    }
  }
}
