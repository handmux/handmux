import { createHash, randomUUID } from 'node:crypto';
import type { AgentRunLease, AgentRunRef, AgentRunRegistry } from './run.js';
import { MemoryInboxStateStore } from './inboxStore.js';
import type {
  InboxStateStore,
  PersistedInboxAvailability,
  PersistedInboxEventReceipt,
  PersistedInboxRun,
  PersistedInboxSourceReceipt,
  PersistedInboxState,
} from './inboxStore.js';
import type {
  AgentTerminalNotificationRecord,
  InboxAvailability,
  InboxBaseline,
  InboxCommitResult,
  InboxOperation,
  InboxOrderedProjector,
  InboxRecord,
  InboxRestoreReceipt,
  InboxRestoreResult,
  InboxRunProjector,
  InboxServiceSnapshot,
  InboxSourceRef,
  InboxState,
  InboxTerminalReplay,
  InboxTerminalReadReceipt,
  InboxUserNotificationEvent,
  InboxUserNotificationListener,
} from './inboxTypes.js';

const SOURCE_RE = /^[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9._-]{0,63}$/;
const EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATES = new Set<InboxState>(['working', 'waiting', 'done', 'error']);
const AVAILABILITIES = new Set<InboxAvailability>(['ready', 'degraded', 'unavailable']);

export class InboxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxContractError';
  }
}

interface NormalizedOperation {
  operation: InboxOperation;
  hash: string;
}

interface NormalizedBaseline {
  baseline: InboxBaseline;
  hash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRunRef(value: unknown): value is AgentRunRef {
  return isRecord(value)
    && typeof value.agentId === 'string' && value.agentId.length > 0
    && typeof value.paneId === 'string' && value.paneId.length > 0
    && typeof value.runId === 'string' && value.runId.length > 0
    && (value.sessionId === undefined || (typeof value.sessionId === 'string' && value.sessionId.length > 0));
}

function copyRunRef(ref: AgentRunRef): AgentRunRef {
  return Object.freeze({
    agentId: ref.agentId,
    paneId: ref.paneId,
    runId: ref.runId,
    ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
  });
}

function sameTerminalEvent(
  left: AgentTerminalNotificationRecord,
  right: AgentTerminalNotificationRecord,
): boolean {
  if (left.agentId !== right.agentId || left.eventId !== right.eventId) return false;
  if (left.sessionId !== undefined && right.sessionId !== undefined) {
    return left.sessionId === right.sessionId;
  }
  return left.runId === right.runId && left.paneId === right.paneId;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function optionalText(value: unknown, max: number, nullable = false): boolean {
  return value === undefined || (nullable && value === null) || boundedString(value, max);
}

function validSource(value: unknown, agentId: string): value is InboxSourceRef {
  return isRecord(value)
    && typeof value.sourceId === 'string'
    && SOURCE_RE.test(value.sourceId)
    && value.sourceId.startsWith(`${agentId}.`)
    && (value.cursor === undefined || boundedString(value.cursor, 1024));
}

function copySource(source: InboxSourceRef): InboxSourceRef {
  return Object.freeze({
    sourceId: source.sourceId,
    ...(source.cursor === undefined ? {} : { cursor: source.cursor }),
  });
}

function semanticHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeOperation(raw: InboxOperation, agentId: string): NormalizedOperation | null {
  if (!isRecord(raw) || (raw.kind !== 'set' && raw.kind !== 'clear')
    || !validSource(raw.source, agentId)
    || !optionalText(raw.message, 4096, true)
    || !optionalText(raw.reason, 1024, true)
    || !optionalText(raw.correlationId, 256)
    || (raw.eventId !== undefined
      && (typeof raw.eventId !== 'string' || !EVENT_ID_RE.test(raw.eventId)))
    || (raw.sourceOccurredAt !== undefined
      && (typeof raw.sourceOccurredAt !== 'number' || !Number.isFinite(raw.sourceOccurredAt)))) return null;
  if (raw.kind === 'set' && (typeof raw.state !== 'string' || !STATES.has(raw.state as InboxState))) return null;

  const operation: InboxOperation = raw.kind === 'set' ? {
    kind: 'set',
    state: raw.state as InboxState,
    source: copySource(raw.source),
    ...(raw.message === undefined ? {} : { message: raw.message as string | null }),
    ...(raw.reason === undefined ? {} : { reason: raw.reason as string | null }),
    ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId as string }),
    ...(raw.eventId === undefined ? {} : { eventId: raw.eventId as string }),
    ...(raw.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: raw.sourceOccurredAt as number }),
  } : {
    kind: 'clear',
    source: copySource(raw.source),
    ...(raw.message === undefined ? {} : { message: raw.message as string | null }),
    ...(raw.reason === undefined ? {} : { reason: raw.reason as string | null }),
    ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId as string }),
    ...(raw.eventId === undefined ? {} : { eventId: raw.eventId as string }),
    ...(raw.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: raw.sourceOccurredAt as number }),
  };
  return {
    operation,
    hash: semanticHash({
      kind: operation.kind,
      ...(operation.kind === 'set' ? { state: operation.state } : {}),
      message: operation.message,
      reason: operation.reason,
      correlationId: operation.correlationId,
      eventId: operation.eventId,
    }),
  };
}

function baselineAsOperation(baseline: InboxBaseline): InboxOperation {
  return {
    kind: 'set',
    state: baseline.state,
    source: baseline.source,
    ...(baseline.message === undefined ? {} : { message: baseline.message }),
    ...(baseline.reason === undefined ? {} : { reason: baseline.reason }),
    ...(baseline.correlationId === undefined ? {} : { correlationId: baseline.correlationId }),
    ...(baseline.eventId === undefined ? {} : { eventId: baseline.eventId }),
    ...(baseline.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: baseline.sourceOccurredAt }),
  };
}

function normalizeBaseline(raw: InboxBaseline, agentId: string): NormalizedBaseline | null {
  if (!isRecord(raw) || !validRunRef(raw.run) || raw.run.agentId !== agentId
    || !validSource(raw.source, agentId)
    || typeof raw.state !== 'string' || !STATES.has(raw.state as InboxState)
    || !optionalText(raw.message, 4096)
    || !optionalText(raw.reason, 1024)
    || !optionalText(raw.correlationId, 256)
    || (raw.eventId !== undefined
      && (typeof raw.eventId !== 'string' || !EVENT_ID_RE.test(raw.eventId)))
    || (raw.sourceOccurredAt !== undefined
      && (typeof raw.sourceOccurredAt !== 'number' || !Number.isFinite(raw.sourceOccurredAt)))) return null;
  const baseline: InboxBaseline = {
    run: copyRunRef(raw.run),
    source: copySource(raw.source),
    state: raw.state as InboxState,
    ...(raw.message === undefined ? {} : { message: raw.message as string }),
    ...(raw.reason === undefined ? {} : { reason: raw.reason as string }),
    ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId as string }),
    ...(raw.eventId === undefined ? {} : { eventId: raw.eventId as string }),
    ...(raw.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: raw.sourceOccurredAt as number }),
  };
  const normalized = normalizeOperation(baselineAsOperation(baseline), agentId);
  return normalized ? { baseline, hash: normalized.hash } : null;
}

function parseInboxRecord(value: unknown, run: AgentRunRef): InboxRecord {
  if (!isRecord(value) || !validSource(value.source, run.agentId)
    || typeof value.state !== 'string' || !STATES.has(value.state as InboxState)
    || !optionalText(value.message, 4096) || !optionalText(value.reason, 1024)
    || !optionalText(value.correlationId, 256)
    || (value.eventId !== undefined
      && (typeof value.eventId !== 'string' || !EVENT_ID_RE.test(value.eventId)))
    || (value.inboxSequence !== undefined
      && (!Number.isSafeInteger(value.inboxSequence) || Number(value.inboxSequence) <= 0))
    || (value.acceptedAt !== undefined
      && (typeof value.acceptedAt !== 'number' || !Number.isFinite(value.acceptedAt)))
    || typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt)
    || (value.sourceOccurredAt !== undefined
      && (typeof value.sourceOccurredAt !== 'number' || !Number.isFinite(value.sourceOccurredAt)))) {
    throw new InboxContractError('Corrupt persisted Inbox latest record');
  }
  return {
    run: copyRunRef(run),
    source: copySource(value.source),
    state: value.state as InboxState,
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(value.eventId === undefined ? {} : { eventId: value.eventId as string }),
    ...(value.inboxSequence === undefined ? {} : { inboxSequence: value.inboxSequence as number }),
    ...(value.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: value.sourceOccurredAt as number }),
    ...(value.acceptedAt === undefined ? {} : { acceptedAt: value.acceptedAt as number }),
    receivedAt: value.receivedAt,
  };
}

function parsePersistedState(raw: unknown): PersistedInboxState {
  if (raw === null || raw === undefined) {
    return { version: 1, runs: [], availability: [], terminalNotifications: [] };
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.runs)
    || !Array.isArray(raw.availability) || !Array.isArray(raw.terminalNotifications)) {
    throw new InboxContractError('Unsupported or corrupt Inbox state');
  }
  const runIds = new Set<string>();
  const runs: PersistedInboxRun[] = raw.runs.map((value) => {
    if (!isRecord(value) || !validRunRef(value.run)
      || !Number.isSafeInteger(value.highWatermark) || Number(value.highWatermark) < 0
      || !Array.isArray(value.sources) || !Array.isArray(value.events)) {
      throw new InboxContractError('Corrupt persisted Inbox run');
    }
    if (runIds.has(value.run.runId)) throw new InboxContractError('Duplicate persisted Inbox runId');
    runIds.add(value.run.runId);
    const runRef = value.run;
    const highWatermark = value.highWatermark as number;
    const sources: PersistedInboxSourceReceipt[] = value.sources.map((source) => {
      if (!isRecord(source) || !validSource(source, runRef.agentId)
        || typeof source.cursor !== 'string' || source.cursor.length === 0 || source.cursor.length > 1024
        || typeof source.operationHash !== 'string' || !HASH_RE.test(source.operationHash)
        || (source.inboxSequence !== undefined
          && (!Number.isSafeInteger(source.inboxSequence) || Number(source.inboxSequence) <= 0
            || Number(source.inboxSequence) > highWatermark))
        || (source.acceptedAt !== undefined
          && (typeof source.acceptedAt !== 'number' || !Number.isFinite(source.acceptedAt)))
        || (source.eventId !== undefined
          && (typeof source.eventId !== 'string' || !EVENT_ID_RE.test(source.eventId)))
        || typeof source.lastReceivedAt !== 'number' || !Number.isFinite(source.lastReceivedAt)) {
        throw new InboxContractError('Corrupt persisted Inbox source receipt');
      }
      return {
        sourceId: source.sourceId,
        cursor: source.cursor,
        operationHash: source.operationHash,
        ...(source.inboxSequence === undefined ? {} : { inboxSequence: source.inboxSequence as number }),
        ...(source.acceptedAt === undefined ? {} : { acceptedAt: source.acceptedAt as number }),
        ...(source.eventId === undefined ? {} : { eventId: source.eventId as string }),
        lastReceivedAt: source.lastReceivedAt,
      };
    });
    const events: PersistedInboxEventReceipt[] = value.events.map((event) => {
      if (!isRecord(event) || typeof event.eventId !== 'string' || !EVENT_ID_RE.test(event.eventId)
        || typeof event.operationHash !== 'string' || !HASH_RE.test(event.operationHash)
        || !Number.isSafeInteger(event.inboxSequence) || Number(event.inboxSequence) <= 0
        || Number(event.inboxSequence) > highWatermark
        || typeof event.acceptedAt !== 'number' || !Number.isFinite(event.acceptedAt)
        || typeof event.lastReceivedAt !== 'number' || !Number.isFinite(event.lastReceivedAt)) {
        throw new InboxContractError('Corrupt persisted Inbox event receipt');
      }
      return {
        eventId: event.eventId,
        operationHash: event.operationHash,
        inboxSequence: event.inboxSequence as number,
        acceptedAt: event.acceptedAt,
        lastReceivedAt: event.lastReceivedAt,
      };
    });
    return {
      run: copyRunRef(runRef),
      highWatermark,
      latest: value.latest === undefined ? undefined : parseInboxRecord(value.latest, runRef),
      sources,
      events,
    };
  });
  const availability: PersistedInboxAvailability[] = raw.availability.map((value) => {
    if (!isRecord(value) || typeof value.agentId !== 'string' || !AVAILABILITIES.has(value.availability as InboxAvailability)
      || !optionalText(value.message, 1024)) throw new InboxContractError('Corrupt Inbox availability');
    return {
      agentId: value.agentId,
      availability: value.availability as InboxAvailability,
      ...(value.message === undefined ? {} : { message: value.message as string }),
    };
  });
  const terminalNotifications = raw.terminalNotifications.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !validRunRef({
      agentId: value.agentId, paneId: value.paneId, runId: value.runId, sessionId: value.sessionId,
    }) || typeof value.eventId !== 'string' || !EVENT_ID_RE.test(value.eventId)
      || (value.state !== 'done' && value.state !== 'error')
      || !optionalText(value.message, 4096) || !optionalText(value.reason, 1024)
      || !optionalText(value.correlationId, 256)
      || typeof value.acceptedAt !== 'number' || !Number.isFinite(value.acceptedAt)
      || (value.readAt !== undefined && (typeof value.readAt !== 'number' || !Number.isFinite(value.readAt)))
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) {
      throw new InboxContractError('Corrupt terminal notification record');
    }
    return {
      id: value.id,
      agentId: value.agentId as string,
      runId: value.runId as string,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
      paneId: value.paneId as string,
      eventId: value.eventId,
      state: value.state as 'done' | 'error',
      ...(value.message === undefined ? {} : { message: value.message as string }),
      ...(value.reason === undefined ? {} : { reason: value.reason as string }),
      ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
      acceptedAt: value.acceptedAt,
      ...(value.readAt === undefined ? {} : { readAt: value.readAt as number }),
      expiresAt: value.expiresAt,
    };
  });
  return { version: 1, runs, availability, terminalNotifications };
}

export interface InboxServiceOptions {
  runs: AgentRunRegistry;
  adapterIds: readonly string[];
  store?: InboxStateStore;
  now?: () => number;
  newServiceEpoch?: () => string;
  newNotificationId?: () => string;
}

export class InboxService {
  readonly serviceEpoch: string;
  readonly #runs: AgentRunRegistry;
  readonly #adapterIds: ReadonlySet<string>;
  readonly #store: InboxStateStore;
  readonly #now: () => number;
  readonly #newNotificationId: () => string;
  readonly #boundLeases = new WeakSet<AgentRunLease>();
  readonly #notificationListeners = new Set<InboxUserNotificationListener>();
  #state: PersistedInboxState;
  #runsById = new Map<string, PersistedInboxRun>();
  #writeTail: Promise<void> = Promise.resolve();
  #notificationTail: Promise<void> = Promise.resolve();
  #revision = 0;

  constructor({
    runs,
    adapterIds,
    store = new MemoryInboxStateStore(),
    now = Date.now,
    newServiceEpoch = randomUUID,
    newNotificationId = randomUUID,
  }: InboxServiceOptions) {
    if (!runs || !Array.isArray(adapterIds) || adapterIds.length === 0) {
      throw new TypeError('InboxService requires a run registry and static adapter ids');
    }
    this.#runs = runs;
    this.#adapterIds = new Set(adapterIds);
    if (this.#adapterIds.size !== adapterIds.length) throw new TypeError('Inbox adapter ids must be unique');
    this.#store = store;
    this.#now = now;
    this.#newNotificationId = newNotificationId;
    this.serviceEpoch = newServiceEpoch();
    this.#state = parsePersistedState(this.#store.load());
    this.#rebuildRunIndex();
    if (this.#pruneExpired(this.#now())) this.#save();
  }

  projectorFor(agentId: string): InboxOrderedProjector {
    this.#assertAdapter(agentId);
    return Object.freeze({
      forRun: (run: AgentRunLease) => this.#forRun(agentId, run),
      restore: (result: InboxRestoreResult) => this.#restore(agentId, result),
      submitTerminalReplay: (replay: InboxTerminalReplay) => this.#submitTerminalReplay(agentId, replay),
    });
  }

  subscribeNotifications(listener: InboxUserNotificationListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('Inbox notification listener is required');
    this.#notificationListeners.add(listener);
    return () => { this.#notificationListeners.delete(listener); };
  }

  read(): InboxServiceSnapshot {
    const before = structuredClone(this.#state);
    if (this.#pruneExpired(this.#now())) {
      try {
        this.#save();
        this.#revision += 1;
      } catch {
        this.#state = before;
        this.#rebuildRunIndex();
        throw new InboxContractError('Terminal notification expiry persistence failed');
      }
    }
    const availability: Record<string, { availability: InboxAvailability; message?: string }> = {};
    for (const entry of this.#state.availability) {
      availability[entry.agentId] = {
        availability: entry.availability,
        ...(entry.message === undefined ? {} : { message: entry.message }),
      };
    }
    return {
      serviceEpoch: this.serviceEpoch,
      revision: this.#revision,
      availability,
      records: this.#state.runs.flatMap((run) => run.latest ? [structuredClone(run.latest)] : []),
      terminalNotifications: structuredClone(this.#state.terminalNotifications),
    };
  }

  async markTerminalRead(notificationIds: readonly string[]): Promise<InboxTerminalReadReceipt> {
    if (!Array.isArray(notificationIds) || notificationIds.length === 0 || notificationIds.length > 256
      || notificationIds.some((id) => !boundedString(id, 256))) {
      throw new InboxContractError('Terminal notification ids must be a non-empty bounded list');
    }
    const ids = new Set(notificationIds);
    const readAt = this.#now();
    return this.#withWrite(async () => {
      const before = structuredClone(this.#state);
      try {
        const pruned = this.#pruneExpired(readAt);
        const targets = this.#state.terminalNotifications.filter((record) => ids.has(record.id));
        const markedIds: string[] = [];
        for (const record of this.#state.terminalNotifications) {
          if (record.readAt !== undefined
            || !targets.some((target) => sameTerminalEvent(target, record))) continue;
          record.readAt = readAt;
          markedIds.push(record.id);
        }
        if (pruned || markedIds.length > 0) {
          this.#save();
          this.#revision += 1;
        }
        return {
          serviceEpoch: this.serviceEpoch,
          revision: this.#revision,
          markedIds,
          ...(markedIds.length === 0 ? {} : { readAt }),
        };
      } catch {
        this.#state = before;
        this.#rebuildRunIndex();
        throw new InboxContractError('Terminal notification read state persistence failed');
      }
    });
  }

  #assertAdapter(agentId: string): void {
    if (!this.#adapterIds.has(agentId)) throw new InboxContractError(`Unknown Inbox adapter: ${agentId}`);
  }

  #forRun(agentId: string, run: AgentRunLease): InboxRunProjector {
    if (run.ref.agentId !== agentId || this.#runs.resolve(run.ref) !== run || run.signal.aborted) {
      throw new InboxContractError('Inbox projector requires its scoped live Agent run lease');
    }
    if (!this.#boundLeases.has(run)) {
      this.#boundLeases.add(run);
      run.signal.addEventListener('abort', () => { void this.#invalidateRevokedRun(run.ref); }, { once: true });
    }
    return Object.freeze({ submit: (operation: InboxOperation) => this.#submit(agentId, run, operation) });
  }

  async #withWrite<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await operation(); } finally { release(); }
  }

  #rebuildRunIndex(): void {
    this.#runsById = new Map(this.#state.runs.map((run) => [run.run.runId, run]));
  }

  #save(): void {
    this.#store.save(structuredClone(this.#state));
  }

  #pruneExpired(now: number): boolean {
    const before = this.#state.terminalNotifications.length;
    this.#state.terminalNotifications = this.#state.terminalNotifications
      .filter((record) => record.expiresAt > now);
    return this.#state.terminalNotifications.length !== before;
  }

  #ensureRun(ref: AgentRunRef): PersistedInboxRun {
    let run = this.#runsById.get(ref.runId);
    if (!run) {
      run = { run: copyRunRef(ref), highWatermark: 0, latest: undefined, sources: [], events: [] };
      this.#state.runs.push(run);
      this.#runsById.set(ref.runId, run);
    } else {
      run.run = copyRunRef(ref);
      if (run.latest) run.latest.run = copyRunRef(ref);
    }
    return run;
  }

  #nextSequence(run: PersistedInboxRun): number {
    if (run.highWatermark >= Number.MAX_SAFE_INTEGER) throw new InboxContractError('Inbox sequence exhausted');
    run.highWatermark += 1;
    return run.highWatermark;
  }

  #queueNotification(event: InboxUserNotificationEvent): void {
    const immutable = Object.freeze(structuredClone(event));
    this.#notificationTail = this.#notificationTail.then(async () => {
      for (const listener of this.#notificationListeners) {
        try { await listener(immutable); } catch { /* delivery is isolated from canonical persistence */ }
      }
    });
  }

  #result(
    receivedAt: number,
    accepted: boolean,
    details: Partial<Pick<InboxCommitResult, 'reason' | 'inboxSequence' | 'acceptedAt'>> = {},
  ): InboxCommitResult {
    return {
      accepted,
      ...details,
      serviceEpoch: this.serviceEpoch,
      revision: this.#revision,
      receivedAt,
    };
  }

  #sourceReceipt(
    run: PersistedInboxRun,
    source: InboxSourceRef,
  ): PersistedInboxSourceReceipt | undefined {
    return source.cursor === undefined ? undefined : run.sources.find((receipt) => (
      receipt.sourceId === source.sourceId && receipt.cursor === source.cursor
    ));
  }

  #crossRunEventReceipts(
    ref: AgentRunRef,
    eventId: string,
  ): PersistedInboxEventReceipt[] {
    if (ref.sessionId === undefined) return [];
    return this.#state.runs.flatMap((run) => (
      run.run.runId !== ref.runId
        && run.run.agentId === ref.agentId
        && run.run.sessionId === ref.sessionId
        ? run.events.filter((receipt) => receipt.eventId === eventId)
        : []
    ));
  }

  #addSourceReceipt(
    run: PersistedInboxRun,
    source: InboxSourceRef,
    hash: string,
    receivedAt: number,
    details: { inboxSequence?: number; acceptedAt?: number; eventId?: string },
  ): void {
    if (source.cursor === undefined) return;
    run.sources.push({
      sourceId: source.sourceId,
      cursor: source.cursor,
      operationHash: hash,
      ...(details.inboxSequence === undefined ? {} : { inboxSequence: details.inboxSequence }),
      ...(details.acceptedAt === undefined ? {} : { acceptedAt: details.acceptedAt }),
      ...(details.eventId === undefined ? {} : { eventId: details.eventId }),
      lastReceivedAt: receivedAt,
    });
  }

  #terminalNotification(
    ref: AgentRunRef,
    operation: {
      state: InboxState;
      eventId?: string;
      message?: string;
      reason?: string;
      correlationId?: string;
    },
    acceptedAt: number,
  ): AgentTerminalNotificationRecord | null {
    if ((operation.state !== 'done' && operation.state !== 'error') || !operation.eventId) return null;
    return {
      id: this.#newNotificationId(),
      agentId: ref.agentId,
      runId: ref.runId,
      ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
      paneId: ref.paneId,
      eventId: operation.eventId,
      state: operation.state,
      ...(typeof operation.message === 'string' ? { message: operation.message } : {}),
      ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}),
      ...(operation.correlationId === undefined ? {} : { correlationId: operation.correlationId }),
      acceptedAt,
      expiresAt: acceptedAt + TERMINAL_RETENTION_MS,
    };
  }

  async #submit(
    agentId: string,
    lease: AgentRunLease,
    raw: InboxOperation,
  ): Promise<InboxCommitResult> {
    const receivedAt = this.#now();
    const normalized = normalizeOperation(raw, agentId);
    if (!normalized) return this.#result(receivedAt, false, { reason: 'invalid_operation' });
    if (this.#runs.resolve(lease.ref) !== lease || lease.signal.aborted) {
      return this.#result(receivedAt, false, { reason: 'stale_lease' });
    }
    return this.#withWrite(async () => {
      if (this.#runs.resolve(lease.ref) !== lease || lease.signal.aborted) {
        return this.#result(receivedAt, false, { reason: 'stale_lease' });
      }
      const before = structuredClone(this.#state);
      const run = this.#ensureRun(lease.ref);
      const sourceDuplicate = this.#sourceReceipt(run, normalized.operation.source);
      if (sourceDuplicate) {
        if (sourceDuplicate.operationHash !== normalized.hash) {
          this.#state = before;
          this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'invalid_operation' });
        }
        sourceDuplicate.lastReceivedAt = receivedAt;
        if (run.latest && (run.latest.inboxSequence === sourceDuplicate.inboxSequence
          || (sourceDuplicate.inboxSequence === undefined
            && run.latest.source.sourceId === sourceDuplicate.sourceId
            && run.latest.source.cursor === sourceDuplicate.cursor))) {
          run.latest.receivedAt = receivedAt;
        }
        try { this.#save(); } catch {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'persistence_failed' });
        }
        return this.#result(receivedAt, true, {
          reason: 'duplicate_source',
          ...(sourceDuplicate.inboxSequence === undefined ? {} : { inboxSequence: sourceDuplicate.inboxSequence }),
          ...(sourceDuplicate.acceptedAt === undefined ? {} : { acceptedAt: sourceDuplicate.acceptedAt }),
        });
      }
      const eventId = normalized.operation.eventId;
      const eventDuplicate = eventId ? run.events.find((receipt) => receipt.eventId === eventId) : undefined;
      if (eventDuplicate) {
        if (eventDuplicate.operationHash !== normalized.hash) {
          this.#state = before;
          this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'invalid_operation' });
        }
        eventDuplicate.lastReceivedAt = receivedAt;
        if (run.latest?.inboxSequence === eventDuplicate.inboxSequence) run.latest.receivedAt = receivedAt;
        this.#addSourceReceipt(run, normalized.operation.source, normalized.hash, receivedAt, {
          inboxSequence: eventDuplicate.inboxSequence,
          acceptedAt: eventDuplicate.acceptedAt,
          ...(eventId === undefined ? {} : { eventId }),
        });
        try { this.#save(); } catch {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'persistence_failed' });
        }
        return this.#result(receivedAt, true, {
          reason: 'duplicate_event',
          inboxSequence: eventDuplicate.inboxSequence,
          acceptedAt: eventDuplicate.acceptedAt,
        });
      }
      // `runId` is process-local and is regenerated when Handmux restarts. A provider event remains the
      // same durable fact inside its native session, so replaying it under the replacement run must inherit
      // the original acceptance instead of creating a fresh unread notification at restart time.
      const historicalEvents = eventId
        ? this.#crossRunEventReceipts(lease.ref, eventId) : [];
      if (eventId && historicalEvents.length > 0) {
        if (historicalEvents.some((receipt) => receipt.operationHash !== normalized.hash)) {
          this.#state = before;
          this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'invalid_operation' });
        }
        try {
          const acceptedAt = Math.min(...historicalEvents.map((receipt) => receipt.acceptedAt));
          const inboxSequence = this.#nextSequence(run);
          if (normalized.operation.kind === 'clear') {
            run.latest = undefined;
          } else {
            const previous = run.latest;
            const message = normalized.operation.message === undefined
              ? previous?.message : normalized.operation.message ?? undefined;
            const reason = normalized.operation.reason === undefined
              ? previous?.reason : normalized.operation.reason ?? undefined;
            const correlationId = normalized.operation.correlationId ?? previous?.correlationId;
            run.latest = {
              run: copyRunRef(lease.ref),
              source: copySource(normalized.operation.source),
              state: normalized.operation.state,
              ...(message === undefined ? {} : { message }),
              ...(reason === undefined ? {} : { reason }),
              ...(correlationId === undefined ? {} : { correlationId }),
              eventId,
              inboxSequence,
              ...(normalized.operation.sourceOccurredAt === undefined
                ? {} : { sourceOccurredAt: normalized.operation.sourceOccurredAt }),
              acceptedAt,
              receivedAt,
            };
          }
          run.events.push({
            eventId, operationHash: normalized.hash, inboxSequence, acceptedAt, lastReceivedAt: receivedAt,
          });
          this.#addSourceReceipt(run, normalized.operation.source, normalized.hash, receivedAt, {
            inboxSequence, acceptedAt, eventId,
          });
          this.#pruneExpired(receivedAt);
          this.#save();
          this.#revision += 1;
          return this.#result(receivedAt, true, {
            reason: 'duplicate_event', inboxSequence, acceptedAt,
          });
        } catch (error) {
          this.#state = before;
          this.#rebuildRunIndex();
          return this.#result(receivedAt, false, {
            reason: error instanceof InboxContractError ? 'invalid_operation' : 'persistence_failed',
          });
        }
      }

      try {
        const inboxSequence = this.#nextSequence(run);
        const acceptedAt = eventId ? receivedAt : undefined;
        if (normalized.operation.kind === 'clear') {
          run.latest = undefined;
        } else {
          const previous = run.latest;
          const message = normalized.operation.message === undefined
            ? previous?.message : normalized.operation.message ?? undefined;
          const reason = normalized.operation.reason === undefined
            ? previous?.reason : normalized.operation.reason ?? undefined;
          const correlationId = normalized.operation.correlationId ?? previous?.correlationId;
          run.latest = {
            run: copyRunRef(lease.ref),
            source: copySource(normalized.operation.source),
            state: normalized.operation.state,
            ...(message === undefined ? {} : { message }),
            ...(reason === undefined ? {} : { reason }),
            ...(correlationId === undefined ? {} : { correlationId }),
            ...(eventId === undefined ? {} : { eventId }),
            inboxSequence,
            ...(normalized.operation.sourceOccurredAt === undefined
              ? {} : { sourceOccurredAt: normalized.operation.sourceOccurredAt }),
            ...(acceptedAt === undefined ? {} : { acceptedAt }),
            receivedAt,
          };
          const terminal = acceptedAt === undefined
            ? null : this.#terminalNotification(lease.ref, run.latest, acceptedAt);
          if (terminal) this.#state.terminalNotifications.push(terminal);
        }
        this.#addSourceReceipt(run, normalized.operation.source, normalized.hash, receivedAt, {
          inboxSequence,
          ...(acceptedAt === undefined ? {} : { acceptedAt }),
          ...(eventId === undefined ? {} : { eventId }),
        });
        if (eventId && acceptedAt !== undefined) {
          run.events.push({
            eventId,
            operationHash: normalized.hash,
            inboxSequence,
            acceptedAt,
            lastReceivedAt: receivedAt,
          });
        }
        this.#pruneExpired(receivedAt);
        this.#save();
        this.#revision += 1;
        if (run.latest?.acceptedAt !== undefined && run.latest.eventId
          && run.latest.state !== 'working') {
          const terminal = this.#state.terminalNotifications.find((item) => (
            item.runId === lease.ref.runId && item.eventId === run.latest!.eventId
          ));
          this.#queueNotification({
            run: copyRunRef(lease.ref),
            state: run.latest.state,
            eventId: run.latest.eventId,
            ...(run.latest.message === undefined ? {} : { message: run.latest.message }),
            ...(run.latest.reason === undefined ? {} : { reason: run.latest.reason }),
            ...(run.latest.correlationId === undefined ? {} : { correlationId: run.latest.correlationId }),
            acceptedAt: run.latest.acceptedAt,
            ...(terminal === undefined ? {} : { terminalNotificationId: terminal.id }),
          });
        }
        return this.#result(receivedAt, true, {
          inboxSequence,
          ...(acceptedAt === undefined ? {} : { acceptedAt }),
        });
      } catch (error) {
        this.#state = before;
        this.#rebuildRunIndex();
        return this.#result(receivedAt, false, {
          reason: error instanceof InboxContractError ? 'invalid_operation' : 'persistence_failed',
        });
      }
    });
  }

  async #restore(agentId: string, result: InboxRestoreResult): Promise<InboxRestoreReceipt> {
    if (!isRecord(result) || !AVAILABILITIES.has(result.availability as InboxAvailability)
      || !optionalText(result.message, 1024)
      || (result.snapshot !== undefined && !Array.isArray(result.snapshot))
      || (result.availability === 'unavailable' && result.snapshot !== undefined)) {
      throw new InboxContractError('Invalid Inbox restore result');
    }
    const baselines = (result.snapshot ?? []).map((baseline) => normalizeBaseline(baseline, agentId));
    if (baselines.some((baseline) => baseline === null)) throw new InboxContractError('Invalid Inbox baseline');
    const normalized = baselines as NormalizedBaseline[];
    if (new Set(normalized.map((item) => item.baseline.run.runId)).size !== normalized.length) {
      throw new InboxContractError('Inbox restore contains duplicate run baselines');
    }
    for (const item of normalized) {
      if (this.#runs.status(item.baseline.run) !== 'current') {
        throw new InboxContractError('Inbox restore baseline requires a current verified run');
      }
    }
    const receivedAt = this.#now();
    return this.#withWrite(async () => {
      const before = structuredClone(this.#state);
      try {
        const availability: PersistedInboxAvailability = {
          agentId,
          availability: result.availability as InboxAvailability,
          ...(result.message === undefined ? {} : { message: result.message as string }),
        };
        const availabilityIndex = this.#state.availability.findIndex((entry) => entry.agentId === agentId);
        if (availabilityIndex === -1) this.#state.availability.push(availability);
        else this.#state.availability[availabilityIndex] = availability;

        if (result.availability !== 'unavailable') {
          const restoredRunIds = new Set<string>();
          for (const item of normalized) {
            const baseline = item.baseline;
            restoredRunIds.add(baseline.run.runId);
            const run = this.#ensureRun(baseline.run);
            let eventReceipt = baseline.eventId
              ? run.events.find((receipt) => receipt.eventId === baseline.eventId)
              : undefined;
            if (!eventReceipt && baseline.eventId) {
              const historical = this.#crossRunEventReceipts(baseline.run, baseline.eventId)
                .sort((left, right) => left.acceptedAt - right.acceptedAt)[0];
              if (historical) {
                eventReceipt = {
                  eventId: baseline.eventId,
                  operationHash: item.hash,
                  inboxSequence: this.#nextSequence(run),
                  acceptedAt: historical.acceptedAt,
                  lastReceivedAt: receivedAt,
                };
                run.events.push(eventReceipt);
              }
            }
            run.latest = {
              run: copyRunRef(baseline.run),
              source: copySource(baseline.source),
              state: baseline.state,
              ...(baseline.message === undefined ? {} : { message: baseline.message }),
              ...(baseline.reason === undefined ? {} : { reason: baseline.reason }),
              ...(baseline.correlationId === undefined ? {} : { correlationId: baseline.correlationId }),
              ...(baseline.eventId === undefined ? {} : { eventId: baseline.eventId }),
              ...(eventReceipt === undefined ? {} : {
                inboxSequence: eventReceipt.inboxSequence,
                acceptedAt: eventReceipt.acceptedAt,
              }),
              ...(baseline.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: baseline.sourceOccurredAt }),
              receivedAt,
            };
            const existingSource = this.#sourceReceipt(run, baseline.source);
            if (existingSource) {
              existingSource.operationHash = item.hash;
              existingSource.lastReceivedAt = receivedAt;
            } else {
              this.#addSourceReceipt(run, baseline.source, item.hash, receivedAt, {
                ...(eventReceipt === undefined ? {} : {
                  inboxSequence: eventReceipt.inboxSequence,
                  acceptedAt: eventReceipt.acceptedAt,
                }),
                ...(baseline.eventId === undefined ? {} : { eventId: baseline.eventId }),
              });
            }
          }
          if (result.availability === 'ready') {
            for (const run of this.#state.runs) {
              if (run.run.agentId === agentId && !restoredRunIds.has(run.run.runId)) run.latest = undefined;
            }
          }
        }
        this.#pruneExpired(receivedAt);
        this.#save();
        this.#revision += 1;
        return {
          availability: result.availability as InboxAvailability,
          serviceEpoch: this.serviceEpoch,
          revision: this.#revision,
        };
      } catch (error) {
        this.#state = before;
        this.#rebuildRunIndex();
        if (error instanceof InboxContractError) throw error;
        throw new InboxContractError('Inbox restore persistence failed');
      }
    });
  }

  async #submitTerminalReplay(
    agentId: string,
    replay: InboxTerminalReplay,
  ): Promise<InboxCommitResult> {
    const receivedAt = this.#now();
    if (!isRecord(replay) || !validRunRef(replay.run) || replay.run.agentId !== agentId
      || this.#runs.status(replay.run) !== 'revoked'
      || (replay.state !== 'done' && replay.state !== 'error')) {
      return this.#result(receivedAt, false, { reason: 'invalid_operation' });
    }
    const normalized = normalizeOperation({
      kind: 'set',
      state: replay.state,
      source: replay.source,
      ...(replay.message === undefined ? {} : { message: replay.message }),
      ...(replay.reason === undefined ? {} : { reason: replay.reason }),
      ...(replay.correlationId === undefined ? {} : { correlationId: replay.correlationId }),
      eventId: replay.eventId,
      ...(replay.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: replay.sourceOccurredAt }),
    }, agentId);
    if (!normalized || normalized.operation.kind !== 'set') {
      return this.#result(receivedAt, false, { reason: 'invalid_operation' });
    }
    const operation = normalized.operation;
    return this.#withWrite(async () => {
      const before = structuredClone(this.#state);
      const run = this.#ensureRun(replay.run);
      const sourceDuplicate = this.#sourceReceipt(run, operation.source);
      if (sourceDuplicate) {
        if (sourceDuplicate.operationHash !== normalized.hash) {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'invalid_operation' });
        }
        sourceDuplicate.lastReceivedAt = receivedAt;
        try { this.#save(); } catch {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'persistence_failed' });
        }
        return this.#result(receivedAt, true, {
          reason: 'duplicate_source',
          ...(sourceDuplicate.inboxSequence === undefined ? {} : { inboxSequence: sourceDuplicate.inboxSequence }),
          ...(sourceDuplicate.acceptedAt === undefined ? {} : { acceptedAt: sourceDuplicate.acceptedAt }),
        });
      }
      const eventDuplicate = run.events.find((receipt) => receipt.eventId === operation.eventId);
      if (eventDuplicate) {
        if (eventDuplicate.operationHash !== normalized.hash) {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'invalid_operation' });
        }
        eventDuplicate.lastReceivedAt = receivedAt;
        this.#addSourceReceipt(run, operation.source, normalized.hash, receivedAt, {
          inboxSequence: eventDuplicate.inboxSequence,
          acceptedAt: eventDuplicate.acceptedAt,
          ...(operation.eventId === undefined ? {} : { eventId: operation.eventId }),
        });
        try { this.#save(); } catch {
          this.#state = before; this.#rebuildRunIndex();
          return this.#result(receivedAt, false, { reason: 'persistence_failed' });
        }
        return this.#result(receivedAt, true, {
          reason: 'duplicate_event',
          inboxSequence: eventDuplicate.inboxSequence,
          acceptedAt: eventDuplicate.acceptedAt,
        });
      }
      try {
        const inboxSequence = this.#nextSequence(run);
        const acceptedAt = receivedAt;
        run.events.push({
          eventId: operation.eventId!,
          operationHash: normalized.hash,
          inboxSequence,
          acceptedAt,
          lastReceivedAt: receivedAt,
        });
        this.#addSourceReceipt(run, operation.source, normalized.hash, receivedAt, {
          inboxSequence,
          acceptedAt,
          ...(operation.eventId === undefined ? {} : { eventId: operation.eventId }),
        });
        const terminal = this.#terminalNotification(replay.run, {
          state: operation.state,
          ...(operation.eventId === undefined ? {} : { eventId: operation.eventId }),
          ...(typeof operation.message === 'string' ? { message: operation.message } : {}),
          ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}),
          ...(operation.correlationId === undefined ? {} : { correlationId: operation.correlationId }),
        }, acceptedAt);
        if (!terminal) throw new InboxContractError('Terminal replay did not produce a notification');
        this.#state.terminalNotifications.push(terminal);
        this.#pruneExpired(receivedAt);
        this.#save();
        this.#revision += 1;
        this.#queueNotification({
          run: copyRunRef(replay.run),
          state: replay.state,
          eventId: operation.eventId!,
          ...(typeof operation.message === 'string' ? { message: operation.message } : {}),
          ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}),
          ...(operation.correlationId === undefined ? {} : { correlationId: operation.correlationId }),
          acceptedAt,
          terminalNotificationId: terminal.id,
        });
        return this.#result(receivedAt, true, { inboxSequence, acceptedAt });
      } catch (error) {
        this.#state = before;
        this.#rebuildRunIndex();
        return this.#result(receivedAt, false, {
          reason: error instanceof InboxContractError ? 'invalid_operation' : 'persistence_failed',
        });
      }
    });
  }

  async #invalidateRevokedRun(ref: AgentRunRef): Promise<void> {
    await this.#withWrite(async () => {
      const run = this.#runsById.get(ref.runId);
      if (!run?.latest || (run.latest.state !== 'working' && run.latest.state !== 'waiting')) return;
      const before = structuredClone(this.#state);
      try {
        run.latest = undefined;
        this.#save();
        this.#revision += 1;
      } catch {
        this.#state = before;
        this.#rebuildRunIndex();
      }
    });
  }
}
