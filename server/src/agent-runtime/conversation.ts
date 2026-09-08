import { createHash, randomUUID } from 'node:crypto';
import type { AgentRunLease, AgentRunRef, AgentRunRegistry, AgentSessionRef } from './run.js';
import { MemoryConversationStateStore, parseConversationState } from './conversationStore.js';
import type {
  ConversationStateStore,
  PersistedConversationCycle,
  PersistedConversationDeliveryReceipt,
  PersistedConversationSend,
  PersistedConversationState,
  PersistedConversationStateV2,
  PersistedConversationSubmission,
} from './conversationStore.js';
import type {
  AgentConversationAdapterV1,
  ConversationAdapterDescriptor,
  ConversationAdapterEvent,
  ConversationAdapterLiveHandle,
  ConversationAdapterPage,
  ConversationCapabilities,
  ConversationDescriptor,
  ConversationEvent,
  ConversationEventSink,
  ConversationItem,
  ConversationItemDraft,
  ConversationLiveHandle,
  ConversationOpenRequest,
  ConversationPageRequest,
  ConversationPageResult,
  ConversationSendReceipt,
  ConversationSubmitReceipt,
  ConversationSubmissionSnapshot,
  ConversationDispatchReceipt,
  ConversationActivitySnapshot,
  ConversationActivitySource,
  ConversationSteerPlan,
  ConversationReason,
  ConversationSendRequest,
  InterruptReceipt,
} from './conversationTypes.js';
import {
  ConversationValidationError,
  normalizeConversationDelta,
  normalizeConversationDraft,
  normalizeConversationItem,
  validConversationId,
} from './conversationValidation.js';

const TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,1023}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SEND_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERY_RECEIPTS = 4_096;

function compareDeliveryReceiptPriority(
  left: PersistedConversationDeliveryReceipt,
  right: PersistedConversationDeliveryReceipt,
): number {
  const leftObserved = left.canonicalObservedAt === undefined ? 0 : 1;
  const rightObserved = right.canonicalObservedAt === undefined ? 0 : 1;
  return leftObserved - rightObserved || right.acceptedAt - left.acceptedAt;
}
const MAX_SEND_PRUNE_PER_MUTATION = 256;
const MAX_LIVE_BUFFER_EVENTS = 4096;
const MAX_PROJECTIONS = 256;
const MAX_CURSORS = 2_048;
const MAX_ISSUED_TOKENS = 8_192;
const SEND_DELIVERIES = new Set(['prompt', 'steer', 'follow_up']);
const RECEIPT_STATUSES = new Set(['accepted', 'queued', 'rejected', 'unknown']);

export type ConversationContractErrorCode =
  | 'invalid_request'
  | 'page_stale'
  | 'session_unavailable'
  | 'contract_violation';

export class ConversationContractError extends Error {
  constructor(
    message: string,
    readonly code: ConversationContractErrorCode = 'contract_violation',
  ) {
    super(message);
    this.name = 'ConversationContractError';
  }
}

interface Projection {
  agentId: string;
  sessionId: string;
  sourceViewId: string;
  sourceHistoryToken: string;
  viewId: string;
  historyVersion: string;
  tailItemId?: string;
}

interface CursorRecord {
  agentId: string;
  sessionId: string;
  viewId: string;
  sourceCursor: string;
}

interface InFlightSend {
  payloadHash: string;
  promise: Promise<ConversationSendReceipt>;
}

interface DispatcherState {
  running: boolean;
  wakePending: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface EditLease {
  token: string;
  submissionId: string;
  revision: number;
  expiresAt: number;
}

interface LiveState {
  run: AgentRunLease;
  adapter: AgentConversationAdapterV1;
  session: AgentSessionRef;
  sink: ConversationEventSink;
  phase: 'buffering' | 'live' | 'closed';
  sourceViewId: string;
  lastSourceSequence: number;
  sequence: number;
  projection: Projection | undefined;
  nativeHandle: ConversationAdapterLiveHandle | undefined;
  provisional: Map<string, ConversationItemDraft>;
  buffered: ConversationAdapterEvent[];
  openingFailure: ConversationContractError | undefined;
  tail: Promise<void>;
  detachAbort: () => void;
}

function raceRunAbort<T>(signal: AbortSignal, operation: Promise<T>, aborted: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(aborted);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { resolve(aborted); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validRunRef(value: unknown): value is AgentRunRef {
  return isRecord(value) && bounded(value.agentId, 64) && bounded(value.paneId, 256)
    && bounded(value.runId, 256)
    && (value.implementationVersion === undefined
      || (Number.isSafeInteger(value.implementationVersion)
        && Number(value.implementationVersion) > 0))
    && (value.sessionId === undefined || bounded(value.sessionId, 1024));
}

function copyRun(ref: AgentRunRef): AgentRunRef {
  return {
    agentId: ref.agentId,
    paneId: ref.paneId,
    runId: ref.runId,
    ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
    ...(ref.implementationVersion === undefined
      ? {} : { implementationVersion: ref.implementationVersion }),
  };
}

function copySession(ref: AgentSessionRef): AgentSessionRef {
  return { agentId: ref.agentId, sessionId: ref.sessionId };
}

function sessionKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

function sendKey(
  agentId: string,
  runId: string,
  clientRequestId: string,
  sessionId?: string,
): string {
  const owner = sessionId === undefined ? `run:${runId}` : `session:${sessionId}`;
  return `${agentId}\0${owner}\0${clientRequestId}`;
}

function persistedSendKey(record: PersistedConversationSend): string {
  return sendKey(record.agentId, record.runId, record.clientRequestId, record.sessionId);
}

function normalizeReceipt(raw: unknown): ConversationSendReceipt | null {
  if (!isRecord(raw) || typeof raw.status !== 'string' || !RECEIPT_STATUSES.has(raw.status)
    || (raw.nativeId !== undefined && !bounded(raw.nativeId, 1024))
    || (raw.reason !== undefined && !bounded(raw.reason, 4096))) return null;
  const status = raw.status as ConversationSendReceipt['status'];
  const reason = status === 'accepted' || status === 'queued' || raw.reason === undefined
    ? undefined : normalizeReason(raw.reason, status === 'rejected'
      ? 'provider_rejected' : 'delivery_unconfirmed');
  return {
    status,
    ...(raw.nativeId === undefined ? {} : { nativeId: raw.nativeId as string }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeInterrupt(raw: unknown): InterruptReceipt | null {
  if (!isRecord(raw) || !['accepted', 'rejected', 'unknown'].includes(String(raw.status))
    || (raw.reason !== undefined && !bounded(raw.reason, 4096))) return null;
  const status = raw.status as InterruptReceipt['status'];
  const reason = status === 'accepted' || raw.reason === undefined
    ? undefined : normalizeReason(raw.reason, 'temporarily_unavailable');
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

const PUBLIC_REASONS = new Set<ConversationReason>([
  'invalid_request', 'unsupported', 'stale_run', 'conflict',
  'provider_rejected', 'temporarily_unavailable', 'delivery_unconfirmed',
]);

const LEGACY_REASON_MAP: Readonly<Record<string, ConversationReason>> = Object.freeze({
  stale_lease: 'stale_run',
  lease_revoked: 'stale_run',
  lease_revoked_before_dispatch: 'stale_run',
  lease_revoked_during_dispatch: 'delivery_unconfirmed',
  client_request_id_conflict: 'conflict',
  server_restarted_during_dispatch: 'delivery_unconfirmed',
  dispatch_outcome_unknown: 'delivery_unconfirmed',
  native_delivery_unconfirmed: 'delivery_unconfirmed',
  unsupported_delivery: 'unsupported',
  agent_busy: 'temporarily_unavailable',
  invalid_extension_response: 'temporarily_unavailable',
  invalid_adapter_receipt: 'temporarily_unavailable',
  adapter_error: 'temporarily_unavailable',
  ledger_persistence_failed: 'temporarily_unavailable',
  ledger_state_lost: 'temporarily_unavailable',
});

function normalizeReason(value: unknown, fallback: ConversationReason): ConversationReason {
  const reason = String(value);
  return PUBLIC_REASONS.has(reason as ConversationReason)
    ? reason as ConversationReason : LEGACY_REASON_MAP[reason] ?? fallback;
}

function parseState(raw: unknown, now: number): PersistedConversationState {
  if (raw === null || raw === undefined) return { version: 1, sends: [] };
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.sends)) {
    throw new ConversationContractError('Unsupported or corrupt Conversation state');
  }
  const keys = new Set<string>();
  const sends: PersistedConversationSend[] = raw.sends.map((value) => {
    if (!isRecord(value) || !bounded(value.agentId, 64) || !bounded(value.runId, 256)
      || (value.sessionId !== undefined && !bounded(value.sessionId, 1024))
      || !bounded(value.clientRequestId, 256) || typeof value.payloadHash !== 'string'
      || !HASH_RE.test(value.payloadHash) || (value.state !== 'dispatching' && value.state !== 'terminal')
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
      || (value.expiresAt !== undefined
        && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)))) {
      throw new ConversationContractError('Corrupt Conversation send ledger');
    }
    const receipt = value.receipt === undefined ? undefined : normalizeReceipt(value.receipt);
    if ((value.state === 'terminal' && !receipt) || (value.state === 'dispatching' && value.receipt !== undefined)) {
      throw new ConversationContractError('Corrupt Conversation send receipt');
    }
    const key = sendKey(
      value.agentId,
      value.runId,
      value.clientRequestId,
      value.sessionId as string | undefined,
    );
    if (keys.has(key)) throw new ConversationContractError('Duplicate Conversation send ledger key');
    keys.add(key);
    return {
      agentId: value.agentId,
      runId: value.runId,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
      clientRequestId: value.clientRequestId,
      payloadHash: value.payloadHash,
      state: value.state as PersistedConversationSend['state'],
      ...(receipt ? { receipt } : {}),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    };
  }).filter((record) => record.expiresAt === undefined || record.expiresAt > now);
  return { version: 1, sends };
}

function capabilities(raw: unknown): ConversationCapabilities | null {
  if (!isRecord(raw) || raw.history !== true || !['delta', 'settled', 'poll'].includes(String(raw.live))) {
    return null;
  }
  if (raw.send !== undefined && (!Array.isArray(raw.send)
    || raw.send.some((value) => !SEND_DELIVERIES.has(String(value)))
    || new Set(raw.send).size !== raw.send.length)) return null;
  if (raw.interrupt !== undefined && raw.interrupt !== true) return null;
  if (raw.sendable !== undefined && raw.sendable !== true) return null;
  if (raw.steer !== undefined && raw.steer !== true) return null;
  if (raw.branching !== undefined && raw.branching !== true) return null;
  return {
    history: true,
    live: raw.live as ConversationCapabilities['live'],
    ...(raw.sendable === true ? { sendable: true } : {}),
    ...(raw.steer === true ? { steer: true } : {}),
    ...(raw.send === undefined ? {} : {
      send: [...raw.send] as NonNullable<ConversationCapabilities['send']>,
    }),
    ...(raw.interrupt === undefined ? {} : { interrupt: true }),
    ...(raw.branching === undefined ? {} : { branching: true }),
  };
}

export interface ConversationServiceOptions {
  runs: AgentRunRegistry;
  adapters: Readonly<Record<string, AgentConversationAdapterV1>>;
  store?: ConversationStateStore;
  activitySource?: ConversationActivitySource;
  dispatchFences?: Readonly<Record<string, string>>;
  now?: () => number;
  newToken?: () => string;
}

export class ConversationService {
  readonly #runs: AgentRunRegistry;
  readonly #adapters: ReadonlyMap<string, AgentConversationAdapterV1>;
  readonly #store: ConversationStateStore;
  readonly #activitySource: ConversationActivitySource;
  readonly #dispatchFences: ReadonlyMap<string, string>;
  readonly #now: () => number;
  readonly #newToken: () => string;
  readonly #projections = new Map<string, Projection>();
  readonly #cursors = new Map<string, CursorRecord>();
  readonly #open = new Map<string, LiveState>();
  readonly #sessionReads = new Map<string, Promise<void>>();
  readonly #inFlightSends = new Map<string, InFlightSend>();
  readonly #dispatchers = new Map<string, DispatcherState>();
  readonly #lastRuns = new Map<string, AgentRunLease>();
  readonly #editLeases = new Map<string, EditLease>();
  readonly #boundRuns = new WeakSet<AgentRunLease>();
  readonly #issuedTokens = new Set<string>();
  #state: PersistedConversationStateV2;
  #writeTail: Promise<void> = Promise.resolve();

  constructor({
    runs,
    adapters,
    store = new MemoryConversationStateStore(),
    activitySource = { read: async (run) => ({
      activity: 'unknown', activeTurn: { state: 'unknown' }, revision: 1, epoch: run.ref.runId,
    }) },
    dispatchFences = {},
    now = Date.now,
    newToken = randomUUID,
  }: ConversationServiceOptions) {
    if (!runs || !isRecord(adapters) || Object.keys(adapters).length === 0) {
      throw new TypeError('ConversationService requires a run registry and adapters');
    }
    const map = new Map<string, AgentConversationAdapterV1>();
    for (const [agentId, adapter] of Object.entries(adapters)) {
      if (!bounded(agentId, 64) || !adapter || adapter.apiVersion !== 1
        || typeof adapter.discoverNative !== 'function' || typeof adapter.readNativePage !== 'function'
        || (adapter.dispatchPrompt !== undefined && typeof adapter.dispatchPrompt !== 'function')
        || (adapter.dispatchSteer !== undefined && typeof adapter.dispatchSteer !== 'function')) {
        throw new TypeError(`Invalid Conversation adapter: ${agentId}`);
      }
      map.set(agentId, adapter);
    }
    this.#runs = runs;
    this.#adapters = map;
    this.#store = store;
    this.#activitySource = activitySource;
    this.#dispatchFences = new Map(Object.entries(dispatchFences));
    this.#now = now;
    this.#newToken = newToken;
    const startedAt = now();
    let loaded: unknown;
    let privacyRewriteRequired = false;
    try {
      loaded = store.load();
      const loadedRecord = isRecord(loaded) ? loaded : null;
      privacyRewriteRequired = loadedRecord?.version === 2
        && Array.isArray(loadedRecord.submissions)
        && loadedRecord.submissions.some((candidate) => isRecord(candidate)
          && (candidate.state === 'accepted' || candidate.state === 'observed'
            || candidate.dispatchOrigin === 'steer'));
      this.#state = parseConversationState(loaded);
      if (isRecord(loaded) && loaded.version === 1) {
        this.#state.legacySends = parseState(loaded, startedAt).sends;
      }
    } catch (error) {
      throw new ConversationContractError(error instanceof Error ? error.message : 'Corrupt Conversation state');
    }
    let changed = privacyRewriteRequired;
    for (const legacy of this.#state.legacySends ?? []) {
      if (legacy.state !== 'dispatching') continue;
      legacy.state = 'terminal';
      legacy.receipt = { status: 'unknown', reason: 'delivery_unconfirmed' };
      legacy.updatedAt = startedAt;
      legacy.expiresAt ??= startedAt + SEND_RETENTION_MS;
      changed = true;
    }
    const retainedLegacy: PersistedConversationSend[] = [];
    for (const legacy of this.#state.legacySends ?? []) {
      if (legacy.state === 'terminal' && legacy.receipt?.status === 'accepted'
        && legacy.sessionId) {
        changed = true;
      } else retainedLegacy.push(legacy);
    }
    this.#state.legacySends = retainedLegacy;
    for (const record of this.#state.submissions) {
      if (record.state === 'dispatching' || record.state === 'steering') {
        record.state = 'unknown';
        record.updatedAt = startedAt;
        record.revision = ++this.#state.ledgerRevision;
        changed = true;
      }
    }
    const retainedReceipts = (this.#state.deliveryReceipts ?? [])
      .filter((receipt) => receipt.expiresAt > startedAt)
      .sort(compareDeliveryReceiptPriority)
      .slice(0, MAX_DELIVERY_RECEIPTS);
    if (retainedReceipts.length !== (this.#state.deliveryReceipts ?? []).length) changed = true;
    this.#state.deliveryReceipts = retainedReceipts;
    for (const receipt of retainedReceipts) {
      if (receipt.status === 'dispatching') {
        receipt.status = 'unknown';
        changed = true;
      }
    }
    for (const cycle of this.#state.cycles) {
      if (cycle.state !== 'closed') { cycle.state = 'unknown'; cycle.revision += 1; changed = true; }
    }
    if (changed) this.#save();
  }

  async discover(target: AgentSessionRef | AgentRunRef): Promise<ConversationDescriptor | null> {
    const normalized = this.#target(target);
    const adapter = this.#adapter(normalized.agentId);
    const descriptor = await adapter.discoverNative(normalized);
    if (descriptor === null) return null;
    const valid = this.#descriptor(descriptor, normalized.agentId);
    return this.#withSessionRead(valid.session.agentId, valid.session.sessionId, async () => {
      const page = await adapter.readNativePage(valid.session, { limit: 1 });
      const normalizedPage = this.#page(page, normalized.agentId, valid.session.sessionId, 1);
      if (normalizedPage.sourceViewId !== valid.sourceViewId) {
        throw new ConversationContractError('Conversation descriptor no longer matches its history view');
      }
      const projection = this.#projection(
        valid.session,
        normalizedPage.sourceViewId,
        normalizedPage.sourceHistoryToken,
      );
      const tailItemId = normalizedPage.items.at(-1)?.id;
      if (tailItemId === undefined) delete projection.tailItemId;
      else projection.tailItemId = tailItemId;
      return this.#publicDescriptor(valid, projection);
    });
  }

  async readPage(
    target: AgentSessionRef | AgentRunRef,
    request: ConversationPageRequest,
  ): Promise<ConversationPageResult> {
    const normalizedTarget = this.#target(target);
    const normalizedSession = this.#session(normalizedTarget);
    if (!isRecord(request) || !Number.isSafeInteger(request.limit)
      || request.limit <= 0 || request.limit > 200
      || (request.expectedViewId !== undefined && !bounded(request.expectedViewId, 1024))
      || (request.expectedHistoryVersion !== undefined && !bounded(request.expectedHistoryVersion, 1024))) {
      throw new ConversationContractError('Invalid Conversation page request', 'invalid_request');
    }
    const adapter = this.#adapter(normalizedSession.agentId);
    return this.#withSessionRead(normalizedSession.agentId, normalizedSession.sessionId, async () => {
      // A live page read must retain its run identity. Codex can expose a newly-created managed thread
      // before its rollout file exists; collapsing the run to a historical session here made discovery
      // succeed and the immediately following page read fail as "session unavailable".
      const descriptorRaw = await adapter.discoverNative(normalizedTarget);
      if (descriptorRaw === null) {
        throw new ConversationContractError(
          'Conversation session is unavailable',
          'session_unavailable',
        );
      }
      const descriptor = this.#descriptor(descriptorRaw, normalizedSession.agentId);
      if (descriptor.session.sessionId !== normalizedSession.sessionId) {
        throw new ConversationContractError('Conversation adapter returned another session');
      }
      let sourceCursor: string | undefined;
      if (request.before !== undefined) {
        const cursor = this.#cursors.get(request.before);
        if (!cursor || cursor.agentId !== normalizedSession.agentId
          || cursor.sessionId !== normalizedSession.sessionId) {
          throw new ConversationContractError(
            'Conversation cursor is invalid or expired',
            'page_stale',
          );
        }
        sourceCursor = cursor.sourceCursor;
      }
      const page = this.#page(await adapter.readNativePage(normalizedSession, {
        limit: request.limit,
        ...(sourceCursor === undefined ? {} : { beforeSourceCursor: sourceCursor }),
      }), normalizedSession.agentId, normalizedSession.sessionId, request.limit);
      let projection: Projection;
      if (request.before === undefined) {
        projection = this.#projection(normalizedSession, page.sourceViewId, page.sourceHistoryToken);
        await this.#observeCanonicalItems(normalizedSession, page.items, projection);
        const tailItemId = page.items.at(-1)?.id;
        if (tailItemId === undefined) delete projection.tailItemId;
        else projection.tailItemId = tailItemId;
      } else {
        // Older pages are historical evidence, never the latest canonical frontier. A provider append
        // can change the shared history token while an older cursor is being read; refresh the latest
        // edge independently instead of rebuilding the projection from the older page and losing its tail.
        await this.#observeCanonicalItems(normalizedSession, page.items);
        const current = this.#projections.get(sessionKey(
          normalizedSession.agentId,
          normalizedSession.sessionId,
        ));
        if (current?.sourceViewId === page.sourceViewId
          && current.sourceHistoryToken === page.sourceHistoryToken) {
          projection = this.#projection(normalizedSession, page.sourceViewId, page.sourceHistoryToken);
        } else {
          const latest = this.#page(await adapter.readNativePage(normalizedSession, { limit: 1 }),
            normalizedSession.agentId, normalizedSession.sessionId, 1);
          projection = this.#projection(
            normalizedSession,
            latest.sourceViewId,
            latest.sourceHistoryToken,
          );
          await this.#observeCanonicalItems(normalizedSession, latest.items, projection);
          const tailItemId = latest.items.at(-1)?.id;
          if (tailItemId === undefined) delete projection.tailItemId;
          else projection.tailItemId = tailItemId;
        }
      }
      if ((request.expectedViewId !== undefined && request.expectedViewId !== projection.viewId)
        || (request.before === undefined && request.expectedHistoryVersion !== undefined
          && request.expectedHistoryVersion !== projection.historyVersion)) {
        return {
          status: 'stale',
          currentViewId: projection.viewId,
          currentHistoryVersion: projection.historyVersion,
        };
      }
      if (request.before !== undefined) {
        const cursor = this.#cursors.get(request.before)!;
        // Provider cursors are absolute positions within one view. Appending to that same view changes
        // historyVersion but does not move an existing cursor; only a view replacement invalidates it.
        if (cursor.viewId !== projection.viewId) {
          return {
            status: 'stale',
            currentViewId: projection.viewId,
            currentHistoryVersion: projection.historyVersion,
          };
        }
      }
      const previousCursor = page.previousSourceCursor === undefined
        ? undefined : this.#wrapCursor(projection, page.previousSourceCursor);
      return {
        status: 'ok',
        page: {
          sessionId: normalizedSession.sessionId,
          viewId: projection.viewId,
          historyVersion: projection.historyVersion,
          items: page.items,
          ...(previousCursor === undefined ? {} : { previousCursor }),
          hasMore: page.hasMore,
        },
      };
    });
  }

  async open(
    run: AgentRunLease,
    request: ConversationOpenRequest,
    sink: ConversationEventSink,
  ): Promise<ConversationLiveHandle> {
    this.#requireRun(run);
    if (!run.ref.sessionId) throw new ConversationContractError('Conversation live run has no session');
    if (!isRecord(request) || (request.expectedViewId !== undefined
      && !bounded(request.expectedViewId, 1024)) || typeof sink !== 'function') {
      throw new ConversationContractError('Invalid Conversation open request');
    }
    const adapter = this.#adapter(run.ref.agentId);
    const observeNative = adapter.observeNative?.bind(adapter);
    if (!observeNative) throw new ConversationContractError('Conversation live stream is unsupported');
    if (this.#open.has(run.ref.runId)) throw new ConversationContractError('Conversation run is already open');
    const session = { agentId: run.ref.agentId, sessionId: run.ref.sessionId };
    const state: LiveState = {
      run,
      adapter,
      session,
      sink,
      phase: 'buffering',
      sourceViewId: '',
      lastSourceSequence: 0,
      sequence: 0,
      projection: undefined,
      nativeHandle: undefined,
      provisional: new Map(),
      buffered: [],
      openingFailure: undefined,
      tail: Promise.resolve(),
      detachAbort: () => {},
    };
    const onAbort = (): void => { void this.#closeLive(state); };
    run.signal.addEventListener('abort', onAbort, { once: true });
    state.detachAbort = () => run.signal.removeEventListener('abort', onAbort);
    this.#open.set(run.ref.runId, state);
    try {
      const projection = await this.#withSessionRead(session.agentId, session.sessionId, async () => {
        // Keep observation setup and its authoritative opening page under one session read lease. A
        // concurrent history request must not consume an adapter's one-shot opening snapshot first.
        const nativeHandle = await observeNative(
          run,
          (event) => this.#acceptAdapterEvent(state, event),
        );
        if (state.phase === 'closed' || run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
          try { await nativeHandle.close(); } catch { /* close is best effort */ }
          throw new ConversationContractError('Conversation run was revoked during open');
        }
        state.nativeHandle = nativeHandle;
        this.#throwOpeningFailure(state);
        const checkpoint = nativeHandle.checkpoint;
        if (!isRecord(checkpoint) || !bounded(checkpoint.sourceViewId, 1024)
          || !Number.isSafeInteger(checkpoint.sourceSequence) || checkpoint.sourceSequence < 0) {
          throw new ConversationContractError('Conversation adapter returned an invalid checkpoint');
        }
        state.sourceViewId = checkpoint.sourceViewId;
        state.lastSourceSequence = checkpoint.sourceSequence;
        const descriptorRaw = await adapter.discoverNative(run.ref);
        this.#throwOpeningFailure(state);
        if (run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
          throw new ConversationContractError('Conversation run was revoked during open');
        }
        if (descriptorRaw === null) {
          throw new ConversationContractError('Conversation session disappeared during open');
        }
        const descriptor = this.#descriptor(descriptorRaw, run.ref.agentId);
        if (descriptor.session.sessionId !== session.sessionId
          || descriptor.sourceViewId !== checkpoint.sourceViewId) {
          throw new ConversationContractError('Conversation open checkpoint no longer matches the session');
        }
        const page = this.#page(await adapter.readNativePage(session, { limit: 1 }),
          session.agentId, session.sessionId, 1);
        this.#throwOpeningFailure(state);
        if (run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
          throw new ConversationContractError('Conversation run was revoked during open');
        }
        if (page.sourceViewId !== checkpoint.sourceViewId) {
          throw new ConversationContractError('Conversation history view changed during open');
        }
        return this.#projection(session, page.sourceViewId, page.sourceHistoryToken);
      });
      state.projection = projection;
      if (request.expectedViewId !== undefined && request.expectedViewId !== projection.viewId) {
        throw new ConversationContractError('Conversation view is stale');
      }
      this.#throwOpeningFailure(state);
      const handle: ConversationLiveHandle = Object.freeze({
        checkpoint: Object.freeze({
          viewId: projection.viewId,
          historyVersion: projection.historyVersion,
          streamSequence: 0,
        }),
        close: () => this.#closeLive(state),
      });
      // Keep buffering through this turn. Facade callbacks must never run before open() settles.
      setTimeout(() => { this.#flushBuffered(state); }, 0).unref?.();
      return handle;
    } catch (error) {
      await this.#closeLive(state);
      throw error;
    }
  }

  async send(run: AgentRunLease, request: ConversationSendRequest): Promise<ConversationSubmitReceipt> {
    try { this.#requireRun(run); } catch {
      return { status: 'rejected', reason: 'stale_run', nativeMutation: false };
    }
    if (this.#dispatchFences.has(run.ref.agentId)) {
      return { status: 'rejected', reason: 'temporarily_unavailable', nativeMutation: false };
    }
    if (!isRecord(request) || !bounded(request.clientRequestId, 256)
      || !bounded(request.text, 256 * 1024) || request.delivery !== 'prompt'
      || !run.ref.sessionId) {
      return { status: 'rejected', reason: 'invalid_request', nativeMutation: false };
    }
    const adapter = this.#adapter(run.ref.agentId);
    if (!adapter.dispatchPrompt) {
      return { status: 'rejected', reason: 'unsupported', nativeMutation: false };
    }
    const session = { agentId: run.ref.agentId, sessionId: run.ref.sessionId };
    const owner = sessionKey(session.agentId, session.sessionId);
    this.#lastRuns.set(owner, run);
    this.#bindRun(run);
    const payloadHash = createHash('sha256').update(request.text).digest('hex');
    const legacyPayloadHash = createHash('sha256').update(JSON.stringify({
      text: request.text, delivery: request.delivery,
    })).digest('hex');
    const settled = this.#deliveryReceipt(
      session.agentId, session.sessionId, request.clientRequestId,
    );
    if (settled) {
      return settled.payloadHash === payloadHash || settled.payloadHash === legacyPayloadHash
        ? this.#deliveryReceiptView(settled)
        : { status: 'rejected', reason: 'conflict', nativeMutation: false };
    }
    const legacy = this.#state.legacySends?.find((record) => sendKey(
      record.agentId, record.runId, record.clientRequestId, record.sessionId,
    ) === sendKey(run.ref.agentId, run.ref.runId, request.clientRequestId, run.ref.sessionId));
    if (legacy) {
      if (legacy.payloadHash !== legacyPayloadHash) {
        return { status: 'rejected', reason: 'conflict', nativeMutation: false };
      }
      const receipt = legacy.receipt ?? { status: 'unknown', reason: 'delivery_unconfirmed' };
      return {
        ...receipt,
        ...(receipt.status === 'rejected' || receipt.status === 'queued'
          ? { nativeMutation: false as const }
          : receipt.status === 'unknown' ? { nativeMutation: 'unknown' as const } : {}),
      };
    }
    const activity = await this.#activitySource.read(run);
    const begin = await this.#withWrite(() => {
      const existing = this.#submission(session.agentId, session.sessionId, request.clientRequestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.text !== request.text) {
          return { kind: 'receipt' as const, value: {
            status: 'rejected', reason: 'conflict', nativeMutation: false,
          } as ConversationSubmitReceipt };
        }
        return { kind: 'receipt' as const, value: this.#submitReceipt(existing) };
      }
      const before = structuredClone(this.#state);
      const now = this.#now();
      const cycle = this.#cycle(session.agentId, session.sessionId, activity);
      if (cycle.state === 'closed' && activity.activity !== 'idle' && activity.activity !== 'unknown') {
        cycle.state = 'awaiting_idle';
        cycle.activityEpoch = activity.epoch;
        cycle.baselineRevision = activity.revision;
        this.#setCycleCompletionBaseline(cycle, activity.completionToken);
        cycle.nonIdleRevision = activity.revision;
        cycle.revision += 1;
      }
      const hasQueue = this.#state.submissions.some((item) => item.agentId === session.agentId
        && item.sessionId === session.sessionId && item.state === 'queued');
      const direct = activity.activity === 'idle' && activity.activeTurn.state === 'none'
        && cycle.state === 'closed' && !hasQueue;
      const revision = ++this.#state.ledgerRevision;
      const submission: PersistedConversationSubmission = {
        agentId: session.agentId, sessionId: session.sessionId,
        clientRequestId: request.clientRequestId, text: request.text, payloadHash,
        state: direct ? 'dispatching' : 'queued', revision,
        ...(direct ? { dispatchOrigin: 'direct' as const } : {
          queueOrderKey: this.#queueOrderKey(now, revision),
        }),
        lastRunId: run.ref.runId, createdAt: now, updatedAt: now,
        ...this.#currentBaseline(session.agentId, session.sessionId),
      };
      this.#state.submissions.push(submission);
      if (direct) this.#claimCycle(cycle, submission, activity);
      try { this.#save(); } catch {
        this.#state = before;
        return { kind: 'receipt' as const, value: {
          status: 'rejected', reason: 'temporarily_unavailable', nativeMutation: false,
        } as ConversationSubmitReceipt };
      }
      return direct
        ? { kind: 'dispatch' as const, id: submission.clientRequestId }
        : { kind: 'receipt' as const, value: this.#submitReceipt(submission) };
    });
    if (begin.kind === 'receipt') {
      if (begin.value.status === 'queued') this.#wake(owner);
      return begin.value;
    }
    return this.#dispatchClaim(run, begin.id, 'direct');
  }

  async queueSnapshot(run: AgentRunLease): Promise<{
    activity: ConversationActivitySnapshot['activity'];
    canSteer: boolean;
    canEdit: boolean;
    canRemove: boolean;
    items: Array<ConversationSubmissionSnapshot & { requestId: string }>;
    submissions: ConversationSubmissionSnapshot[];
    settled: Array<{ id: string; nativeId?: string }>;
  }> {
    this.#requireRun(run);
    if (!run.ref.sessionId) throw new ConversationContractError('Conversation run has no session');
    const owner = sessionKey(run.ref.agentId, run.ref.sessionId);
    this.#lastRuns.set(owner, run);
    const activity = await this.#activitySource.read(run);
    await this.#observeActivity(run, activity);
    const adapter = this.#adapter(run.ref.agentId);
    let canSteer = false;
    try {
      const descriptorRaw = await adapter.discoverNative(run.ref);
      if (descriptorRaw !== null) {
        const descriptor = this.#descriptor(descriptorRaw, run.ref.agentId);
        canSteer = descriptor.session.sessionId === run.ref.sessionId
          && descriptor.capabilities.steer === true
          && typeof adapter.dispatchSteer === 'function';
      }
    } catch {
      // Queue state remains usable when an optional provider capability probe is unavailable or stale.
    }
    const records = this.#state.submissions.filter((item) => item.agentId === run.ref.agentId
      && item.sessionId === run.ref.sessionId);
    const queueItems = records.filter((item) => item.state === 'queued'
      || (item.state === 'dispatching' && item.dispatchOrigin === 'queue'))
      .sort((a, b) => String(a.queueOrderKey).localeCompare(String(b.queueOrderKey)))
      .map((item) => ({ ...this.#snapshot(item), requestId: item.clientRequestId }));
    const submissions = records.filter((item) => item.state === 'dispatching'
      || item.state === 'steering' || item.state === 'unknown')
      .map((item) => this.#snapshot(item));
    const settled = (this.#state.deliveryReceipts ?? []).filter((receipt) => (
      receipt.agentId === run.ref.agentId && receipt.sessionId === run.ref.sessionId
      && receipt.status !== 'dispatching' && receipt.status !== 'unknown'
      && receipt.expiresAt > this.#now()
    )).sort(compareDeliveryReceiptPriority).slice(0, 1_000).map((receipt) => ({
      id: receipt.clientRequestId,
      ...(receipt.nativeId === undefined ? {} : { nativeId: receipt.nativeId }),
    }));
    return {
      activity: activity.activity,
      canSteer,
      canEdit: true, canRemove: true,
      items: queueItems, submissions, settled,
    };
  }

  async queueAction(run: AgentRunLease, request: Record<string, unknown>): Promise<unknown> {
    this.#requireRun(run);
    if (this.#dispatchFences.has(run.ref.agentId)) {
      throw new ConversationContractError(
        'Conversation dispatch is temporarily unavailable',
        'session_unavailable',
      );
    }
    if (!run.ref.sessionId || !bounded(request.itemId, 256)) {
      throw new ConversationContractError('Invalid queue action', 'invalid_request');
    }
    const itemId = request.itemId;
    if (request.action === 'remove') {
      await this.#mutateQueued(run, itemId, (item) => {
        this.#state.submissions = this.#state.submissions.filter((candidate) => candidate !== item);
      });
      return { ok: true };
    }
    if (request.action === 'begin_edit') {
      const item = this.#requireQueued(run, itemId);
      const token = this.#newToken();
      const lease = { token, submissionId: itemId, revision: item.revision, expiresAt: this.#now() + 30_000 };
      this.#editLeases.set(sessionKey(run.ref.agentId, run.ref.sessionId), lease);
      return { lease: { token, text: item.text, expiresAt: lease.expiresAt } };
    }
    if (request.action === 'renew_edit' && bounded(request.token, 1024)) {
      const lease = this.#requireEditLease(run, itemId, request.token);
      lease.expiresAt = this.#now() + 30_000;
      return { lease: { token: lease.token, text: this.#requireQueued(run, itemId).text, expiresAt: lease.expiresAt } };
    }
    if (request.action === 'cancel_edit' && bounded(request.token, 1024)) {
      this.#requireEditLease(run, itemId, request.token);
      this.#editLeases.delete(sessionKey(run.ref.agentId, run.ref.sessionId));
      this.#wake(sessionKey(run.ref.agentId, run.ref.sessionId));
      return { ok: true };
    }
    if (request.action === 'commit_edit' && bounded(request.token, 1024)
      && bounded(request.text, 256 * 1024)) {
      const lease = this.#requireEditLease(run, itemId, request.token);
      await this.#mutateQueued(run, itemId, (item) => {
        if (item.revision !== lease.revision) throw new ConversationContractError('Queue item changed', 'invalid_request');
        item.text = request.text as string;
        item.payloadHash = createHash('sha256').update(item.text).digest('hex');
        delete item.autoDispatchBlockedReason;
        item.revision = ++this.#state.ledgerRevision;
        item.updatedAt = this.#now();
      });
      this.#editLeases.delete(sessionKey(run.ref.agentId, run.ref.sessionId));
      return { ok: true };
    }
    if (request.action === 'steer') return this.#steer(run, itemId, request);
    throw new ConversationContractError('Invalid queue action', 'invalid_request');
  }

  querySubmission(
    run: AgentRunLease,
    submissionId: string,
    actionId?: string,
  ): ConversationSubmitReceipt {
    this.#requireRun(run);
    if (!run.ref.sessionId || !bounded(submissionId, 256)
      || (actionId !== undefined && !bounded(actionId, 256))) {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    const item = this.#submission(run.ref.agentId, run.ref.sessionId, submissionId);
    if (!item) {
      const settled = this.#deliveryReceipt(run.ref.agentId, run.ref.sessionId, submissionId);
      if (settled) {
        if (actionId !== undefined && settled.steerActionId !== actionId) {
          if (settled.steerAttempts?.some((attempt) => attempt.actionId === actionId)) {
            return { status: 'rejected', reason: 'provider_rejected', nativeMutation: false };
          }
          return { status: 'rejected', reason: 'conflict', conflict: 'action_id_mismatch' };
        }
        return this.#deliveryReceiptView(settled);
      }
      const legacy = this.#state.legacySends?.find((record) => record.agentId === run.ref.agentId
        && record.runId === run.ref.runId && record.sessionId === run.ref.sessionId
        && record.clientRequestId === submissionId);
      if (!legacy) return { status: 'rejected', reason: 'invalid_request' };
      const receipt = legacy.receipt ?? { status: 'unknown', reason: 'delivery_unconfirmed' };
      return {
        ...receipt,
        ...(receipt.status === 'rejected' || receipt.status === 'queued'
          ? { nativeMutation: false as const }
          : receipt.status === 'unknown' ? { nativeMutation: 'unknown' as const } : {}),
      };
    }
    if (actionId !== undefined && item.steerActionId !== actionId) {
      const prior = item.steerAttempts?.find((attempt) => attempt.actionId === actionId);
      if (prior) return {
        status: 'rejected', reason: 'provider_rejected', nativeMutation: false,
        submission: this.#snapshot(item),
      };
      return {
        status: 'rejected', reason: 'conflict', conflict: 'action_id_mismatch',
        submission: this.#snapshot(item),
      };
    }
    const receipt = this.#submitReceipt(item);
    if (actionId !== undefined && item.steerActionId === actionId) {
      if (item.state === 'queued') {
        return { ...receipt, status: 'rejected', reason: 'provider_rejected', nativeMutation: false };
      }
      return receipt;
    }
    return receipt;
  }

  async interrupt(run: AgentRunLease): Promise<InterruptReceipt> {
    try { this.#requireRun(run); } catch { return { status: 'rejected', reason: 'stale_run' }; }
    const adapter = this.#adapter(run.ref.agentId);
    if (!adapter.dispatchInterrupt) return { status: 'rejected', reason: 'unsupported' };
    try {
      const receipt = await raceRunAbort(
        run.signal,
        adapter.dispatchInterrupt(run),
        { status: 'unknown', reason: 'stale_run' },
      );
      return normalizeInterrupt(receipt) ?? { status: 'unknown', reason: 'temporarily_unavailable' };
    } catch { return { status: 'unknown', reason: 'temporarily_unavailable' }; }
  }

  #adapter(agentId: string): AgentConversationAdapterV1 {
    const adapter = this.#adapters.get(agentId);
    if (!adapter) throw new ConversationContractError(`Conversation adapter is unavailable: ${agentId}`);
    return adapter;
  }

  #session(value: AgentSessionRef | AgentRunRef): AgentSessionRef {
    if (!isRecord(value) || !bounded(value.agentId, 64) || !bounded(value.sessionId, 1024)) {
      throw new ConversationContractError('Invalid Agent session reference');
    }
    return { agentId: value.agentId, sessionId: value.sessionId };
  }

  #target(value: AgentSessionRef | AgentRunRef): AgentSessionRef | AgentRunRef {
    if (isRecord(value) && bounded(value.paneId, 256) && bounded(value.runId, 256)) {
      if (!validRunRef(value)) throw new ConversationContractError('Invalid Agent run reference');
      return copyRun(value);
    }
    return this.#session(value as AgentSessionRef);
  }

  #requireRun(run: AgentRunLease): void {
    if (!run || run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
      throw new ConversationContractError('Conversation operation requires a live run lease');
    }
  }

  #descriptor(raw: unknown, agentId: string): ConversationAdapterDescriptor {
    if (!isRecord(raw) || !isRecord(raw.session) || raw.session.agentId !== agentId
      || !bounded(raw.session.sessionId, 1024) || !bounded(raw.sourceViewId, 1024)) {
      throw new ConversationContractError('Conversation adapter returned an invalid descriptor');
    }
    const caps = capabilities(raw.capabilities);
    const implementation = raw.implementation === undefined ? undefined : (() => {
      if (!isRecord(raw.implementation)
        || !Number.isSafeInteger(raw.implementation.version)
        || (raw.implementation.version as number) <= 0
        || (raw.implementation.reloadRequired !== undefined
          && raw.implementation.reloadRequired !== true)) return null;
      return {
        version: raw.implementation.version as number,
        ...(raw.implementation.reloadRequired === true ? { reloadRequired: true as const } : {}),
      };
    })();
    if (!caps || (raw.run !== undefined && (!validRunRef(raw.run) || raw.run.agentId !== agentId))) {
      throw new ConversationContractError('Conversation adapter returned invalid capabilities');
    }
    if (implementation === null) {
      throw new ConversationContractError('Conversation adapter returned invalid implementation metadata');
    }
    const adapter = this.#adapter(agentId);
    if (raw.run !== undefined && implementation?.reloadRequired !== true
      && ((caps.sendable === true) !== (typeof adapter.dispatchPrompt === 'function')
        || (caps.steer === true) !== (typeof adapter.dispatchSteer === 'function'))) {
      throw new ConversationContractError('Conversation send capability does not match its adapter methods');
    }
    return {
      session: { agentId, sessionId: raw.session.sessionId },
      ...(raw.run === undefined ? {} : { run: copyRun(raw.run) }),
      sourceViewId: raw.sourceViewId,
      capabilities: caps,
      ...(implementation === undefined ? {} : { implementation }),
    };
  }

  #page(
    raw: unknown,
    agentId: string,
    sessionId: string,
    limit: number,
  ): ConversationAdapterPage {
    if (!isRecord(raw) || raw.sessionId !== sessionId || !bounded(raw.sourceViewId, 1024)
      || !bounded(raw.sourceHistoryToken, 1024) || !Array.isArray(raw.items)
      || raw.items.length > limit || typeof raw.hasMore !== 'boolean'
      || (raw.previousSourceCursor !== undefined && !bounded(raw.previousSourceCursor, 4096))) {
      throw new ConversationContractError('Conversation adapter returned an invalid page');
    }
    const items = raw.items.map((item) => normalizeConversationItem(item, agentId, sessionId));
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new ConversationContractError('Conversation page contains duplicate item ids');
    }
    const toolCalls = items.filter((item) => item.kind === 'tool_call').map((item) => item.callId);
    if (new Set(toolCalls).size !== toolCalls.length) {
      throw new ConversationContractError('Conversation page contains duplicate tool call ids');
    }
    return {
      sessionId,
      sourceViewId: raw.sourceViewId,
      sourceHistoryToken: raw.sourceHistoryToken,
      items,
      ...(raw.previousSourceCursor === undefined
        ? {} : { previousSourceCursor: raw.previousSourceCursor }),
      hasMore: raw.hasMore,
    };
  }

  #token(prefix: string, occupied: (value: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = `${prefix}:${this.#newToken()}`;
      if (TOKEN_RE.test(value) && !this.#issuedTokens.has(value) && !occupied(value)) {
        this.#issuedTokens.add(value);
        while (this.#issuedTokens.size > MAX_ISSUED_TOKENS) {
          const oldest = this.#issuedTokens.values().next().value;
          if (oldest === undefined) break;
          this.#issuedTokens.delete(oldest);
        }
        return value;
      }
    }
    throw new ConversationContractError(`Unable to allocate Conversation ${prefix}`);
  }

  #projection(session: AgentSessionRef, sourceViewId: string, sourceHistoryToken: string): Projection {
    const key = sessionKey(session.agentId, session.sessionId);
    const current = this.#projections.get(key);
    if (current && current.sourceViewId === sourceViewId
      && current.sourceHistoryToken === sourceHistoryToken) {
      this.#projections.delete(key);
      this.#projections.set(key, current);
      return current;
    }
    const viewId = current?.sourceViewId === sourceViewId
      ? current.viewId : this.#token('view', (value) => [...this.#projections.values()]
        .some((projection) => projection.viewId === value));
    const projection: Projection = {
      agentId: session.agentId,
      sessionId: session.sessionId,
      sourceViewId,
      sourceHistoryToken,
      viewId,
      historyVersion: this.#token('history', (value) => [...this.#projections.values()]
        .some((candidate) => candidate.historyVersion === value)),
    };
    this.#projections.set(key, projection);
    while (this.#projections.size > MAX_PROJECTIONS) {
      const oldest = this.#projections.keys().next().value;
      if (oldest === undefined) break;
      this.#projections.delete(oldest);
    }
    return projection;
  }

  #publicDescriptor(
    descriptor: ConversationAdapterDescriptor,
    projection: Projection,
  ): ConversationDescriptor {
    return {
      session: copySession(descriptor.session),
      ...(descriptor.run === undefined ? {} : { run: copyRun(descriptor.run) }),
      viewId: projection.viewId,
      historyVersion: projection.historyVersion,
      capabilities: structuredClone(descriptor.capabilities),
      ...(descriptor.implementation === undefined
        ? {} : { implementation: structuredClone(descriptor.implementation) }),
    };
  }

  #wrapCursor(projection: Projection, sourceCursor: string): string {
    const token = this.#token('cursor', (value) => this.#cursors.has(value));
    this.#cursors.set(token, {
      agentId: projection.agentId,
      sessionId: projection.sessionId,
      viewId: projection.viewId,
      sourceCursor,
    });
    while (this.#cursors.size > MAX_CURSORS) {
      const oldest = this.#cursors.keys().next().value;
      if (oldest === undefined) break;
      this.#cursors.delete(oldest);
    }
    return token;
  }

  #acceptAdapterEvent(state: LiveState, event: ConversationAdapterEvent): Promise<void> {
    if (state.phase === 'closed') return Promise.resolve();
    if (state.openingFailure) return Promise.reject(state.openingFailure);
    let cloned: ConversationAdapterEvent;
    try { cloned = structuredClone(event); } catch {
      const failure = new ConversationContractError('Conversation adapter event is not cloneable');
      if (state.phase === 'buffering') state.openingFailure = failure;
      else {
        const recovery = state.tail.then(() => this.#recoverLiveFailure(state));
        state.tail = recovery.catch(() => { void this.#closeLive(state); });
      }
      return Promise.reject(failure);
    }
    if (state.phase === 'buffering') {
      if (state.buffered.length >= MAX_LIVE_BUFFER_EVENTS) {
        state.openingFailure = new ConversationContractError('Conversation open buffer is full');
        return Promise.reject(state.openingFailure);
      }
      state.buffered.push(cloned);
      return Promise.resolve();
    }
    const pending = state.tail.then(() => this.#processAdapterEvent(state, cloned));
    state.tail = pending.catch(() => this.#recoverLiveFailure(state));
    return pending;
  }

  #flushBuffered(state: LiveState): void {
    if (state.phase !== 'buffering') return;
    if (state.openingFailure) {
      state.buffered = [];
      state.phase = 'live';
      const pending = this.#emitGap(state);
      state.tail = pending.catch(() => { void this.#closeLive(state); });
      return;
    }
    const events = state.buffered.splice(0);
    state.phase = 'live';
    for (const event of events) {
      // The checkpoint already covers these events. Adapter callbacks need only carry the suffix > S.
      if (event.sourceSequence <= state.lastSourceSequence) continue;
      void this.#acceptAdapterEvent(state, event).catch(() => this.#closeLive(state));
    }
  }

  #throwOpeningFailure(state: LiveState): void {
    if (state.openingFailure) throw state.openingFailure;
  }

  async #processAdapterEvent(state: LiveState, event: ConversationAdapterEvent): Promise<void> {
    if (state.phase !== 'live' || !isRecord(event) || !Number.isSafeInteger(event.sourceSequence)
      || event.sourceSequence <= state.lastSourceSequence) {
      throw new ConversationContractError('Conversation adapter sequence is duplicate or out of order');
    }
    state.lastSourceSequence = event.sourceSequence;
    if (event.type === 'item.opened') {
      if (!validConversationId(event.provisionalId) || state.provisional.has(event.provisionalId)) {
        throw new ConversationContractError('Conversation provisional id is invalid or duplicate');
      }
      const draft = normalizeConversationDraft(event.draft, state.session.agentId);
      if (draft.kind === 'message' && draft.role === 'user' && draft.correlationId) {
        await this.#observeCanonicalCorrelation(state.session, draft.correlationId);
      }
      state.provisional.set(event.provisionalId, draft);
      await this.#emit(state, {
        type: 'item.opened', sequence: ++state.sequence,
        provisionalId: event.provisionalId, draft,
      });
      return;
    }
    if (event.type === 'item.delta') {
      const current = state.provisional.get(event.provisionalId);
      if (!current) throw new ConversationContractError('Conversation delta targets an unknown provisional item');
      const normalized = normalizeConversationDelta(event.delta, state.session.agentId, current);
      state.provisional.set(event.provisionalId, normalized.next);
      await this.#emit(state, {
        type: 'item.delta', sequence: ++state.sequence,
        provisionalId: event.provisionalId, delta: normalized.delta,
      });
      return;
    }
    if (event.type === 'item.settled') {
      if (!state.provisional.has(event.provisionalId)
        || (event.durableItemId !== undefined && !validConversationId(event.durableItemId))) {
        throw new ConversationContractError('Conversation settlement targets an unknown provisional item');
      }
      const item = event.item === undefined ? undefined
        : normalizeConversationItem(event.item, state.session.agentId, state.session.sessionId);
      if (item?.kind === 'message' && item.role === 'user' && item.correlationId) {
        await this.#observeCanonicalCorrelation(state.session, item.correlationId, item.id);
      }
      if (item && event.durableItemId && item.id !== event.durableItemId) {
        throw new ConversationContractError('Conversation settlement ids disagree');
      }
      state.provisional.delete(event.provisionalId);
      if (!item && !event.durableItemId) {
        await this.#emitGap(state);
        return;
      }
      await this.#emit(state, {
        type: 'item.settled', sequence: ++state.sequence,
        provisionalId: event.provisionalId,
        ...(event.durableItemId === undefined ? {} : { durableItemId: event.durableItemId }),
        ...(item === undefined ? {} : { item }),
      });
      return;
    }
    if (event.type === 'item.cancelled') {
      if (!state.provisional.has(event.provisionalId)
        || (event.reason !== undefined && !['interrupted', 'superseded', 'provider_error', 'stream_reset']
          .includes(event.reason))) {
        throw new ConversationContractError('Conversation cancellation targets an unknown provisional item');
      }
      state.provisional.delete(event.provisionalId);
      await this.#emit(state, {
        type: 'item.cancelled', sequence: ++state.sequence,
        provisionalId: event.provisionalId,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      return;
    }
    if (event.type === 'history.committed') {
      if (!bounded(event.sourceViewId, 1024) || !bounded(event.sourceHistoryToken, 1024)
        || event.sourceViewId !== state.sourceViewId) {
        throw new ConversationContractError('Conversation history commit targets another view');
      }
      const projection = await this.#withSessionRead(
        state.session.agentId,
        state.session.sessionId,
        async () => {
          const page = this.#page(await state.adapter.readNativePage(state.session, { limit: 1 }),
            state.session.agentId, state.session.sessionId, 1);
          if (page.sourceViewId !== event.sourceViewId
            || page.sourceHistoryToken !== event.sourceHistoryToken) {
            throw new ConversationContractError('Conversation history commit is not readable yet');
          }
          if (state.projection?.sourceHistoryToken === page.sourceHistoryToken) return undefined;
          const previousFrontier = state.projection;
          const next = this.#projection(state.session, page.sourceViewId, page.sourceHistoryToken);
          await this.#observeCanonicalItems(state.session, page.items, next, previousFrontier);
          const tailItemId = page.items.at(-1)?.id;
          if (tailItemId === undefined) delete next.tailItemId;
          else next.tailItemId = tailItemId;
          return next;
        },
      );
      if (!projection) return;
      state.projection = projection;
      await this.#emit(state, {
        type: 'history.changed', sequence: ++state.sequence,
        historyVersion: projection.historyVersion,
        viewId: projection.viewId,
      });
      return;
    }
    if (event.type === 'stream.gap') {
      if (!Number.isSafeInteger(event.afterSourceSequence) || event.afterSourceSequence < 0) {
        throw new ConversationContractError('Conversation stream gap is invalid');
      }
      await this.#emitGap(state);
      return;
    }
    throw new ConversationContractError('Unknown Conversation adapter event');
  }

  async #emitGap(state: LiveState): Promise<void> {
    const afterSequence = state.sequence;
    state.provisional.clear();
    await this.#emit(state, {
      type: 'stream.gap', sequence: ++state.sequence, afterSequence,
    });
    void this.#closeLive(state);
  }

  async #recoverLiveFailure(state: LiveState): Promise<void> {
    if (state.phase === 'live') {
      try { await this.#emitGap(state); } catch { /* sink may already be unavailable */ }
    }
    await this.#closeLive(state);
  }

  async #emit(state: LiveState, event: ConversationEvent): Promise<void> {
    if (state.phase !== 'live') return;
    await state.sink(structuredClone(event));
  }

  async #closeLive(state: LiveState): Promise<void> {
    if (state.phase === 'closed') return;
    state.phase = 'closed';
    state.detachAbort();
    state.provisional.clear();
    state.buffered = [];
    if (this.#open.get(state.run.ref.runId) === state) this.#open.delete(state.run.ref.runId);
    try { await state.nativeHandle?.close(); } catch { /* close is best effort */ }
  }

  async #withSessionRead<T>(agentId: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = sessionKey(agentId, sessionId);
    const previous = this.#sessionReads.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#sessionReads.set(key, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#sessionReads.get(key) === current) this.#sessionReads.delete(key);
    }
  }

  async #withWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await operation(); } finally { release(); }
  }

  #save(): void {
    const now = this.#now();
    this.#state.deliveryReceipts = (this.#state.deliveryReceipts ?? [])
      .filter((receipt) => receipt.expiresAt > now)
      .sort(compareDeliveryReceiptPriority)
      .slice(0, MAX_DELIVERY_RECEIPTS);
    this.#state.ledgerRevision = Math.max(this.#state.ledgerRevision, 0,
      ...this.#state.submissions.map((item) => item.revision),
      ...this.#state.cycles.map((cycle) => cycle.revision));
    this.#store.save(structuredClone(this.#state));
  }

  async #observeCanonicalItems(
    session: AgentSessionRef,
    items: readonly ConversationItem[],
    projection?: Projection,
    previousFrontier?: Projection,
  ): Promise<void> {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.kind !== 'message' || item.role !== 'user') continue;
      if (item.correlationId) {
        const matched = await this.#observeCanonicalCorrelation(session, item.correlationId, item.id);
        if (matched) continue;
      }
      const nativeMatch = this.#state.submissions.find((submission) => (
        submission.agentId === session.agentId && submission.sessionId === session.sessionId
        && submission.nativeId !== undefined
        && (submission.nativeId === item.correlationId || submission.nativeId === item.id)
      ));
      if (nativeMatch) {
        await this.#observeCanonicalCorrelation(session, nativeMatch.clientRequestId, item.id);
        continue;
      }
      const settledNativeMatch = this.#state.deliveryReceipts?.find((receipt) => (
        receipt.agentId === session.agentId && receipt.sessionId === session.sessionId
        && receipt.nativeId !== undefined
        && (receipt.nativeId === item.correlationId || receipt.nativeId === item.id)
      ));
      if (settledNativeMatch) {
        await this.#observeCanonicalCorrelation(
          session, settledNativeMatch.clientRequestId, item.id,
        );
        continue;
      }
      if (!projection) continue;
      const text = item.content.filter((block) => block.type === 'text')
        .map((block) => block.text).join('');
      if (!text) continue;
      const candidates = this.#state.submissions.filter((submission) => {
        if (submission.agentId !== session.agentId || submission.sessionId !== session.sessionId
          || submission.state === 'queued'
          || submission.text !== text || submission.baseline?.viewId !== projection.viewId) return false;
        const tail = submission.baseline.tailItemId;
        if (tail === undefined) return index === 0;
        const tailIndex = items.findIndex((candidate) => candidate.id === tail);
        if (tailIndex >= 0) return index > tailIndex;
        return previousFrontier?.viewId === projection.viewId
          && previousFrontier.historyVersion === submission.baseline.historyVersion
          && previousFrontier.sourceHistoryToken !== projection.sourceHistoryToken
          && item.id !== tail;
      }).sort((left, right) => left.createdAt - right.createdAt || left.revision - right.revision);
      if (candidates[0]) {
        await this.#observeCanonicalCorrelation(session, candidates[0].clientRequestId, item.id);
        continue;
      }
      const payloadHash = createHash('sha256').update(text).digest('hex');
      const settledCandidates = (this.#state.deliveryReceipts ?? []).filter((receipt) => {
        if (receipt.agentId !== session.agentId || receipt.sessionId !== session.sessionId
          || receipt.canonicalObservedAt !== undefined
          || receipt.payloadHash !== payloadHash || receipt.baseline?.viewId !== projection.viewId) {
          return false;
        }
        const tail = receipt.baseline.tailItemId;
        if (tail === undefined) return index === 0;
        const tailIndex = items.findIndex((candidate) => candidate.id === tail);
        if (tailIndex >= 0) return index > tailIndex;
        return previousFrontier?.viewId === projection.viewId
          && previousFrontier.historyVersion === receipt.baseline.historyVersion
          && previousFrontier.sourceHistoryToken !== projection.sourceHistoryToken
          && item.id !== tail;
      }).sort((left, right) => left.acceptedAt - right.acceptedAt);
      if (settledCandidates[0]) {
        await this.#observeCanonicalCorrelation(
          session, settledCandidates[0].clientRequestId, item.id,
        );
      }
    }
  }

  #currentBaseline(agentId: string, sessionId: string):
  | { baseline: NonNullable<PersistedConversationSubmission['baseline']> }
  | Record<string, never> {
    const projection = this.#projections.get(sessionKey(agentId, sessionId));
    return projection ? { baseline: {
      viewId: projection.viewId,
      historyVersion: projection.historyVersion,
      ...(projection.tailItemId === undefined ? {} : { tailItemId: projection.tailItemId }),
    } } : {};
  }

  async #observeCanonicalCorrelation(
    session: AgentSessionRef,
    correlationId: string,
    nativeId?: string,
  ): Promise<boolean> {
    return this.#withWrite(() => {
      const item = this.#submission(session.agentId, session.sessionId, correlationId);
      const before = structuredClone(this.#state);
      if (!item) {
        const settled = this.#deliveryReceipt(session.agentId, session.sessionId, correlationId);
        if (!settled) return false;
        const now = this.#now();
        const changed = settled.canonicalObservedAt === undefined
          || settled.status === 'dispatching' || settled.status === 'unknown'
          || (nativeId !== undefined && settled.nativeId !== nativeId);
        if (!changed) return true;
        settled.canonicalObservedAt ??= now;
        settled.status = 'accepted';
        if (nativeId !== undefined) settled.nativeId = nativeId;
        try { this.#save(); return true; } catch { this.#state = before; return false; }
      }
      const cycle = this.#state.cycles.find((candidate) => candidate.agentId === session.agentId
        && candidate.sessionId === session.sessionId);
      if (cycle?.ownerSubmissionId === item.clientRequestId) {
        delete cycle.ownerSubmissionId;
        if (cycle.state === 'dispatching') cycle.state = 'awaiting_non_idle';
        cycle.revision += 1;
      }
      this.#settleAccepted(item, nativeId, true);
      try { this.#save(); return true; } catch { this.#state = before; return false; }
    });
  }

  #bindRun(run: AgentRunLease): void {
    if (this.#boundRuns.has(run)) return;
    this.#boundRuns.add(run);
    run.signal.addEventListener('abort', () => { void this.#markRunRevoked(run.ref); }, { once: true });
  }

  async #markRunRevoked(ref: AgentRunRef): Promise<void> {
    const owner = ref.sessionId ? sessionKey(ref.agentId, ref.sessionId) : null;
    if (owner && this.#lastRuns.get(owner)?.ref.runId === ref.runId) this.#lastRuns.delete(owner);
    await this.#withWrite(() => {
      const before = structuredClone(this.#state);
      const now = this.#now();
      let changed = false;
      for (const record of this.#state.submissions) {
        if (record.agentId !== ref.agentId || record.lastRunId !== ref.runId) continue;
        if (record.state === 'dispatching' || record.state === 'steering') {
          record.state = 'unknown';
          record.revision = ++this.#state.ledgerRevision;
          record.updatedAt = now;
          changed = true;
        }
      }
      for (const cycle of this.#state.cycles) {
        if (cycle.ownerSubmissionId && this.#submission(cycle.agentId, cycle.sessionId, cycle.ownerSubmissionId)?.lastRunId === ref.runId
          && cycle.state !== 'closed') {
          cycle.state = 'unknown'; cycle.revision += 1; changed = true;
        }
      }
      if (!changed) return;
      try { this.#save(); } catch { this.#state = before; }
    });
  }

  #submission(agentId: string, sessionId: string, id: string): PersistedConversationSubmission | undefined {
    return this.#state.submissions.find((item) => item.agentId === agentId
      && item.sessionId === sessionId && item.clientRequestId === id);
  }

  #cycle(
    agentId: string,
    sessionId: string,
    activity: ConversationActivitySnapshot,
  ): PersistedConversationCycle {
    let cycle = this.#state.cycles.find((item) => item.agentId === agentId && item.sessionId === sessionId);
    if (!cycle) {
      cycle = {
        agentId, sessionId, state: 'closed', revision: 0,
        activityEpoch: activity.epoch, baselineRevision: activity.revision,
        ...(activity.completionToken === undefined ? {}
          : { baselineCompletionToken: activity.completionToken }),
      };
      this.#state.cycles.push(cycle);
    }
    return cycle;
  }

  #claimCycle(
    cycle: PersistedConversationCycle,
    submission: PersistedConversationSubmission,
    activity: ConversationActivitySnapshot,
  ): void {
    cycle.state = 'dispatching';
    cycle.ownerSubmissionId = submission.clientRequestId;
    cycle.activityEpoch = activity.epoch;
    cycle.baselineRevision = activity.revision;
    this.#setCycleCompletionBaseline(cycle, activity.completionToken);
    delete cycle.nonIdleRevision;
    delete cycle.closedIdleRevision;
    cycle.revision += 1;
  }

  #setCycleCompletionBaseline(
    cycle: PersistedConversationCycle,
    token: string | undefined,
  ): void {
    if (token === undefined) delete cycle.baselineCompletionToken;
    else cycle.baselineCompletionToken = token;
  }

  #queueOrderKey(now: number, revision: number): string {
    return `${String(Math.floor(now)).padStart(16, '0')}:${String(revision).padStart(16, '0')}`;
  }

  #snapshot(item: PersistedConversationSubmission): ConversationSubmissionSnapshot {
    return {
      id: item.clientRequestId, text: item.text, state: item.state, revision: item.revision,
      ...(item.dispatchOrigin === undefined ? {} : { dispatchOrigin: item.dispatchOrigin }),
      ...(item.nativeId === undefined ? {} : { nativeId: item.nativeId }),
      ...(item.baseline === undefined ? {} : { baseline: structuredClone(item.baseline) }),
      ...(item.queueOrderKey === undefined ? {} : { queueOrderKey: item.queueOrderKey }),
      ...(item.autoDispatchBlockedReason === undefined ? {}
        : { autoDispatchBlockedReason: item.autoDispatchBlockedReason }),
      ...(item.steerActionId === undefined ? {} : { steerActionId: item.steerActionId }),
      ...(item.steerBaseRevision === undefined ? {} : { steerBaseRevision: item.steerBaseRevision }),
      ...(item.steerAnchor === undefined ? {} : { steerAnchor: structuredClone(item.steerAnchor) }),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }

  #submitReceipt(item: PersistedConversationSubmission): ConversationSubmitReceipt {
    const status = item.state === 'queued' || (item.state === 'dispatching' && item.dispatchOrigin === 'queue')
      ? 'queued' : item.state === 'unknown' ? 'unknown'
        : item.state === 'dispatching' || item.state === 'steering' ? 'accepted' : 'rejected';
    return {
      status, submission: this.#snapshot(item), ...(item.nativeId ? { nativeId: item.nativeId } : {}),
      ...(status === 'queued' ? { nativeMutation: false as const }
        : item.state === 'unknown' ? { nativeMutation: 'unknown' as const } : {}),
    };
  }

  #deliveryReceipt(
    agentId: string,
    sessionId: string,
    clientRequestId: string,
  ): PersistedConversationDeliveryReceipt | undefined {
    return this.#state.deliveryReceipts?.find((receipt) => receipt.agentId === agentId
      && receipt.sessionId === sessionId && receipt.clientRequestId === clientRequestId
      && receipt.expiresAt > this.#now());
  }

  #deliveryReceiptView(receipt: PersistedConversationDeliveryReceipt): ConversationSubmitReceipt {
    if (receipt.status === 'dispatching' || receipt.status === 'unknown') {
      return { status: 'unknown', reason: 'delivery_unconfirmed', nativeMutation: 'unknown' };
    }
    return {
      status: 'accepted',
      ...(receipt.nativeId === undefined ? {} : { nativeId: receipt.nativeId }),
    };
  }

  #settleAccepted(
    item: PersistedConversationSubmission,
    nativeId?: string,
    canonicalObserved = false,
  ): void {
    const now = this.#now();
    const existing = this.#state.deliveryReceipts?.find((receipt) => receipt.agentId === item.agentId
      && receipt.sessionId === item.sessionId && receipt.clientRequestId === item.clientRequestId);
    const receipt: PersistedConversationDeliveryReceipt = {
      agentId: item.agentId,
      sessionId: item.sessionId,
      clientRequestId: item.clientRequestId,
      payloadHash: item.payloadHash,
      ...(item.baseline === undefined ? {} : { baseline: structuredClone(item.baseline) }),
      ...(nativeId ?? item.nativeId ? { nativeId: (nativeId ?? item.nativeId)! } : {}),
      ...(canonicalObserved
        ? { canonicalObservedAt: existing?.canonicalObservedAt ?? now }
        : existing?.canonicalObservedAt === undefined
          ? {} : { canonicalObservedAt: existing.canonicalObservedAt }),
      ...(item.steerActionId === undefined ? {} : { steerActionId: item.steerActionId }),
      ...(item.steerBaseRevision === undefined ? {} : { steerBaseRevision: item.steerBaseRevision }),
      ...(item.steerAnchor === undefined ? {} : { steerAnchor: structuredClone(item.steerAnchor) }),
      ...(item.steerDispatchPlan === undefined ? {}
        : { steerDispatchPlan: structuredClone(item.steerDispatchPlan) }),
      ...(item.steerAttempts === undefined ? {} : { steerAttempts: structuredClone(item.steerAttempts) }),
      acceptedAt: existing?.acceptedAt ?? now,
      expiresAt: now + SEND_RETENTION_MS,
      status: 'accepted',
    };
    this.#state.deliveryReceipts ??= [];
    if (existing) Object.assign(existing, receipt);
    else this.#state.deliveryReceipts.push(receipt);
    this.#state.deliveryReceipts.sort(compareDeliveryReceiptPriority);
    if (this.#state.deliveryReceipts.length > MAX_DELIVERY_RECEIPTS) {
      this.#state.deliveryReceipts.length = MAX_DELIVERY_RECEIPTS;
    }
    this.#state.submissions = this.#state.submissions.filter((candidate) => candidate !== item);
  }

  async #dispatchClaim(
    run: AgentRunLease,
    submissionId: string,
    origin: 'direct' | 'queue' | 'steer',
    detached?: PersistedConversationSubmission,
  ): Promise<ConversationSubmitReceipt> {
    const runRef = copyRun(run.ref);
    if (!runRef.sessionId) {
      return { status: 'rejected', reason: 'invalid_request', nativeMutation: false };
    }
    const adapter = this.#adapter(runRef.agentId);
    const item = this.#submission(runRef.agentId, runRef.sessionId, submissionId) ?? detached;
    if (!item) return { status: 'rejected', reason: 'invalid_request', nativeMutation: false };
    let receipt: ConversationDispatchReceipt;
    const preDispatchActivity = await this.#activitySource.read(run);
    if (run.signal.aborted || this.#runs.resolve(runRef) !== run) {
      receipt = { outcome: 'unknown', nativeMutation: 'unknown', reason: 'stale_run' };
    } else if (origin === 'steer' && (!item.steerDispatchPlan
      || item.steerDispatchPlan.activityEpoch !== preDispatchActivity.epoch
      || item.steerDispatchPlan.activityRevision !== preDispatchActivity.revision
      || (item.steerDispatchPlan.kind === 'steer-active-turn'
        && (preDispatchActivity.activeTurn.state !== 'active'
          || preDispatchActivity.activeTurn.nativeTurnId !== item.steerDispatchPlan.nativeTurnId))
      || (item.steerDispatchPlan.kind === 'start-turn-fallback'
        && (preDispatchActivity.activity !== 'idle'
          || preDispatchActivity.activeTurn.state !== 'none')))) {
      receipt = { outcome: 'rejected', nativeMutation: false, reason: 'conflict' };
    } else if (origin !== 'steer' && (preDispatchActivity.activity !== 'idle'
      || preDispatchActivity.activeTurn.state !== 'none')) {
      receipt = { outcome: 'busy', nativeMutation: false };
    } else try {
      const operation = origin === 'steer'
        ? adapter.dispatchSteer?.(run, {
          clientRequestId: item.clientRequestId, text: item.text,
          plan: item.steerDispatchPlan!,
          anchor: item.steerAnchor!,
        })
        : adapter.dispatchPrompt?.(
          run,
          { clientRequestId: item.clientRequestId, text: item.text },
          {
            validate: async () => {
              if (run.signal.aborted || this.#runs.resolve(runRef) !== run) return false;
              let current: ConversationActivitySnapshot;
              try { current = await this.#activitySource.read(run); } catch { return false; }
              return !run.signal.aborted && this.#runs.resolve(runRef) === run
                && current.epoch === preDispatchActivity.epoch
                && current.revision === preDispatchActivity.revision
                && current.activity === 'idle'
                && current.activeTurn.state === 'none';
            },
          },
        );
      if (!operation) receipt = { outcome: 'rejected', nativeMutation: false, reason: 'unsupported' };
      else receipt = await raceRunAbort(run.signal, operation, {
        outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed',
      });
    } catch {
      receipt = { outcome: 'unknown', nativeMutation: 'unknown', reason: 'temporarily_unavailable' };
    }
    const activity = await this.#activitySource.read(run);
    if ((run.signal.aborted || this.#runs.resolve(runRef) !== run)
      && receipt.outcome === 'accepted') {
      receipt = { outcome: 'unknown', nativeMutation: 'unknown', reason: 'stale_run' };
    }
    const result = await this.#withWrite<ConversationSubmitReceipt>(() => {
      const current = this.#submission(runRef.agentId, runRef.sessionId!, submissionId);
      if (!current) {
        const settled = this.#deliveryReceipt(runRef.agentId, runRef.sessionId!, submissionId);
        if (settled && origin === 'steer' && detached) {
          const before = structuredClone(this.#state);
          const now = this.#now();
          const cycle = this.#cycle(runRef.agentId, runRef.sessionId!, activity);
          const settleAcceptedFallbackCycle = (): void => {
            if (detached.steerDispatchPlan?.kind !== 'start-turn-fallback') return;
            if (cycle.activityEpoch !== activity.epoch) {
              cycle.state = 'unknown'; cycle.activityEpoch = activity.epoch;
              cycle.baselineRevision = activity.revision;
              this.#setCycleCompletionBaseline(cycle, activity.completionToken);
            } else if (cycle.baselineCompletionToken !== undefined
              && activity.completionToken !== undefined
              && activity.completionToken !== cycle.baselineCompletionToken
              && activity.activity === 'idle' && activity.activeTurn.state === 'none') {
              cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
              delete cycle.ownerSubmissionId;
            } else if (cycle.state === 'closed'
              && cycle.closedIdleRevision !== undefined
              && cycle.closedIdleRevision > cycle.baselineRevision) {
              // Activity may complete before canonical correlation and the Adapter receipt. The
              // late receipt must not reopen a fully observed fallback cycle.
            } else if (activity.revision > cycle.baselineRevision
              && activity.activity !== 'idle' && activity.activity !== 'unknown') {
              cycle.state = 'awaiting_idle'; cycle.nonIdleRevision = activity.revision;
            } else cycle.state = 'awaiting_non_idle';
            if (cycle.ownerSubmissionId === detached.clientRequestId) {
              delete cycle.ownerSubmissionId;
            }
            cycle.revision += 1;
          };
          if (settled.canonicalObservedAt !== undefined) {
            // Canonical correlation is stronger than a late Adapter receipt. In particular, a
            // no-mutation busy/rejected response cannot resurrect the detached steer body, and an
            // unknown response cannot downgrade the already-proven delivery.
            settled.status = 'accepted';
            if (receipt.outcome === 'accepted' && receipt.nativeId) {
              settled.nativeId ??= receipt.nativeId;
            }
            settleAcceptedFallbackCycle();
            try { this.#save(); } catch { this.#state = before; }
            const authoritative = this.#deliveryReceipt(
              runRef.agentId, runRef.sessionId!, submissionId,
            );
            return authoritative ? this.#deliveryReceiptView(authoritative) : {
              status: 'accepted',
              ...(settled.nativeId === undefined ? {} : { nativeId: settled.nativeId }),
            };
          }
          if (receipt.outcome === 'accepted') {
            settled.status = 'accepted';
            settled.acceptedAt = now;
            settled.expiresAt = now + SEND_RETENTION_MS;
            if (receipt.nativeId) settled.nativeId = receipt.nativeId;
            settleAcceptedFallbackCycle();
          } else if (receipt.outcome === 'busy' || receipt.outcome === 'rejected') {
            const steerPlan = detached.steerDispatchPlan;
            this.#state.deliveryReceipts = (this.#state.deliveryReceipts ?? [])
              .filter((candidate) => candidate !== settled);
            detached.state = 'queued';
            delete detached.dispatchOrigin;
            if (detached.steerActionId && detached.steerBaseRevision && detached.steerAnchor) {
              detached.steerAttempts = [...(detached.steerAttempts ?? []), {
                actionId: detached.steerActionId,
                baseRevision: detached.steerBaseRevision,
                anchor: structuredClone(detached.steerAnchor),
                result: 'rejected' as const,
              }].slice(-8);
            }
            delete detached.steerActionId;
            delete detached.steerBaseRevision;
            delete detached.steerAnchor;
            delete detached.steerDispatchPlan;
            if (receipt.outcome === 'rejected') detached.autoDispatchBlockedReason = 'provider_rejected';
            else delete detached.autoDispatchBlockedReason;
            detached.revision = ++this.#state.ledgerRevision;
            detached.updatedAt = now;
            this.#state.submissions.push(detached);
            if (steerPlan?.kind === 'start-turn-fallback') {
              cycle.state = receipt.outcome === 'busy' ? 'awaiting_non_idle' : 'closed';
              cycle.activityEpoch = activity.epoch; cycle.baselineRevision = activity.revision;
              this.#setCycleCompletionBaseline(cycle, activity.completionToken);
              if (cycle.state === 'closed') delete cycle.ownerSubmissionId;
              cycle.revision += 1;
            }
          } else {
            settled.status = 'unknown';
            settled.expiresAt = now + SEND_RETENTION_MS;
            if (detached.steerDispatchPlan?.kind === 'start-turn-fallback') {
              cycle.state = 'unknown'; cycle.revision += 1;
            }
          }
          try {
            this.#save();
            if (receipt.outcome === 'busy' || receipt.outcome === 'rejected') {
              return {
                ...this.#submitReceipt(detached), nativeMutation: false,
              } as ConversationSubmitReceipt;
            }
            return {
              ...this.#deliveryReceiptView(settled),
              ...(receipt.outcome === 'unknown' ? { nativeMutation: 'unknown' as const } : {}),
            };
          } catch {
            this.#state = before;
            return { status: 'unknown', reason: 'temporarily_unavailable', nativeMutation: 'unknown' };
          }
        }
        if (settled) return this.#deliveryReceiptView(settled);
        return { status: 'unknown', reason: 'delivery_unconfirmed' } as ConversationSubmitReceipt;
      }
      const before = structuredClone(this.#state);
      const cycle = this.#cycle(runRef.agentId, runRef.sessionId!, activity);
      const now = this.#now();
      if (receipt.outcome === 'accepted') {
        current.dispatchOrigin = origin;
        delete current.autoDispatchBlockedReason;
        if (receipt.nativeId) current.nativeId = receipt.nativeId;
        if (origin !== 'steer' || current.steerDispatchPlan?.kind === 'start-turn-fallback') {
          if (cycle.activityEpoch !== activity.epoch) {
            cycle.state = 'unknown'; cycle.activityEpoch = activity.epoch;
            cycle.baselineRevision = activity.revision;
            this.#setCycleCompletionBaseline(cycle, activity.completionToken);
          } else if (cycle.baselineCompletionToken !== undefined
            && activity.completionToken !== undefined
            && activity.completionToken !== cycle.baselineCompletionToken
            && activity.activity === 'idle' && activity.activeTurn.state === 'none') {
            cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
            delete cycle.ownerSubmissionId;
          } else if (cycle.state === 'closed'
            && cycle.closedIdleRevision !== undefined
            && cycle.closedIdleRevision > cycle.baselineRevision) {
            // Activity may complete before the Adapter receipt. A late accepted receipt must not reopen
            // a cycle that already observed its baseline -> non-idle -> idle sequence.
          } else if (activity.revision > cycle.baselineRevision
            && activity.activity !== 'idle' && activity.activity !== 'unknown') {
            cycle.state = 'awaiting_idle'; cycle.nonIdleRevision = activity.revision;
          } else {
            cycle.state = 'awaiting_non_idle';
          }
          cycle.revision += 1;
        }
        if (cycle.ownerSubmissionId === current.clientRequestId) delete cycle.ownerSubmissionId;
        this.#settleAccepted(current, receipt.nativeId);
      } else if (receipt.outcome === 'busy' || receipt.outcome === 'rejected') {
        if (origin === 'direct' && receipt.outcome === 'rejected') {
          this.#state.submissions = this.#state.submissions.filter((candidate) => candidate !== current);
          cycle.state = 'closed'; delete cycle.ownerSubmissionId; cycle.revision += 1;
          try { this.#save(); } catch { this.#state = before; }
          return {
            status: 'rejected', reason: receipt.reason, nativeMutation: false,
          } as ConversationSubmitReceipt;
        }
        current.state = 'queued';
        delete current.dispatchOrigin;
        if (receipt.outcome === 'rejected') {
          current.autoDispatchBlockedReason = 'provider_rejected';
        } else delete current.autoDispatchBlockedReason;
        current.queueOrderKey ??= this.#queueOrderKey(now, ++this.#state.ledgerRevision);
        if (origin !== 'steer' || current.steerDispatchPlan?.kind === 'start-turn-fallback') {
          cycle.state = receipt.outcome === 'busy' ? 'awaiting_non_idle' : 'closed';
          cycle.activityEpoch = activity.epoch; cycle.baselineRevision = activity.revision;
          this.#setCycleCompletionBaseline(cycle, activity.completionToken);
          if (cycle.state === 'closed') delete cycle.ownerSubmissionId;
          cycle.revision += 1;
        }
      } else {
        current.state = 'unknown'; current.dispatchOrigin = origin;
        if (origin !== 'steer' || current.steerDispatchPlan?.kind === 'start-turn-fallback') {
          cycle.state = 'unknown'; cycle.revision += 1;
        }
      }
      if (receipt.outcome !== 'accepted') {
        current.revision = ++this.#state.ledgerRevision;
        current.updatedAt = now;
      }
      try {
        this.#save();
        return {
          ...(receipt.outcome === 'accepted'
            ? this.#deliveryReceiptView(this.#deliveryReceipt(
              runRef.agentId, runRef.sessionId!, submissionId,
            )!) : this.#submitReceipt(current)),
          ...(receipt.outcome === 'busy' || receipt.outcome === 'rejected'
            ? { nativeMutation: false as const }
            : receipt.outcome === 'unknown' ? { nativeMutation: 'unknown' as const }
              : {}),
        };
      } catch {
        this.#state = before;
        return {
          status: 'unknown', reason: 'temporarily_unavailable', nativeMutation: 'unknown',
        } as ConversationSubmitReceipt;
      }
    });
    this.#wake(sessionKey(runRef.agentId, runRef.sessionId));
    return result;
  }

  async #steer(run: AgentRunLease, itemId: string, request: Record<string, unknown>): Promise<unknown> {
    const actionId = bounded(request.actionId, 256) ? request.actionId : this.#newToken();
    if (run.ref.sessionId) {
      const settled = this.#deliveryReceipt(run.ref.agentId, run.ref.sessionId, itemId);
      if (settled?.steerActionId === actionId) {
        const anchor = isRecord(request.anchor) ? request.anchor : null;
        const sameAnchor = anchor?.viewId === settled.steerAnchor?.viewId
          && anchor?.afterItemId === settled.steerAnchor?.afterItemId;
        if (request.baseRevision !== settled.steerBaseRevision || !sameAnchor) {
          return {
            actionId, result: 'rejected' as const, nativeMutation: false as const, revision: 0,
          };
        }
        const receipt = this.#deliveryReceiptView(settled);
        return {
          actionId,
          result: receipt.status === 'accepted' ? 'accepted' as const : 'unknown' as const,
          nativeMutation: receipt.status === 'accepted' ? true as const : 'unknown' as const,
          revision: 0,
        };
      }
    }
    const rejected = () => {
      const current = run.ref.sessionId
        ? this.#submission(run.ref.agentId, run.ref.sessionId, itemId) : undefined;
      return {
        actionId, result: 'rejected' as const, nativeMutation: false as const,
        revision: current?.revision ?? 0,
        ...(current ? { submission: this.#snapshot(current) } : {}),
      };
    };
    let planned: PersistedConversationSubmission;
    let replacingRejectedAction = false;
    try {
      const adapter = this.#adapter(run.ref.agentId);
      if (!adapter.dispatchSteer || !run.ref.sessionId) return rejected();
      if (!Number.isSafeInteger(request.baseRevision) || Number(request.baseRevision) < 1
        || !isRecord(request.anchor) || !bounded(request.anchor.viewId, 1024)
        || (request.anchor.afterItemId !== undefined
          && !bounded(request.anchor.afterItemId, 1024))) return rejected();
      const existing = this.#submission(run.ref.agentId, run.ref.sessionId, itemId);
      if (existing?.steerActionId) {
        const sameAnchor = existing.steerAnchor?.viewId === request.anchor.viewId
          && existing.steerAnchor?.afterItemId === request.anchor.afterItemId;
        if (existing.steerActionId === actionId
          && (existing.steerBaseRevision !== request.baseRevision || !sameAnchor)) return rejected();
        if (existing.steerActionId !== actionId
          && existing.state !== 'queued') return rejected();
        replacingRejectedAction = existing.steerActionId !== actionId;
      }
      if (existing?.steerActionId === actionId) {
        const receipt = this.querySubmission(run, itemId, actionId);
        return {
          actionId,
          result: receipt.status === 'accepted' ? 'accepted' as const
            : receipt.status === 'unknown' ? 'unknown' as const : 'rejected' as const,
          nativeMutation: receipt.nativeMutation ?? (receipt.status === 'accepted' ? true : false),
          revision: receipt.submission?.revision ?? existing.revision,
          ...(receipt.submission ? { submission: receipt.submission } : {}),
        };
      }
      const activity = await this.#activitySource.read(run);
      planned = await this.#withWrite(() => {
        const item = this.#requireQueued(run, itemId);
        if (item.revision !== request.baseRevision) {
          throw new ConversationContractError('Conversation queue item changed', 'invalid_request');
        }
        if (replacingRejectedAction) {
          if (item.steerActionId && item.steerBaseRevision && item.steerAnchor) {
            item.steerAttempts = [...(item.steerAttempts ?? []), {
              actionId: item.steerActionId,
              baseRevision: item.steerBaseRevision,
              anchor: structuredClone(item.steerAnchor),
              result: 'rejected' as const,
            }].slice(-8);
          }
          delete item.steerActionId;
          delete item.steerBaseRevision;
          delete item.steerDispatchPlan;
          delete item.steerAnchor;
        }
        const cycle = this.#cycle(run.ref.agentId, run.ref.sessionId!, activity);
        let plan: ConversationSteerPlan | null = null;
        if (activity.activeTurn.state === 'active' && cycle.state !== 'closed'
          && cycle.activityEpoch === activity.epoch) {
          plan = {
            kind: 'steer-active-turn', activityEpoch: activity.epoch,
            activityRevision: activity.revision, nativeTurnId: activity.activeTurn.nativeTurnId,
          };
        } else if (activity.activity === 'idle' && activity.activeTurn.state === 'none'
          && cycle.state === 'closed') {
          plan = {
            kind: 'start-turn-fallback', activityEpoch: activity.epoch,
            activityRevision: activity.revision,
          };
        }
        if (!plan) throw new ConversationContractError('Conversation activity changed; message remains queued', 'invalid_request');
        const before = structuredClone(this.#state);
        item.state = 'steering'; item.dispatchOrigin = 'steer'; item.steerActionId = actionId;
        item.steerBaseRevision = request.baseRevision as number;
        Object.assign(item, this.#currentBaseline(run.ref.agentId, run.ref.sessionId!));
        delete item.autoDispatchBlockedReason;
        item.steerDispatchPlan = plan; item.lastRunId = run.ref.runId;
        if (isRecord(request.anchor)) {
          item.steerAnchor = {
            viewId: request.anchor.viewId as string,
            ...(bounded(request.anchor.afterItemId, 1024) ? { afterItemId: request.anchor.afterItemId } : {}),
          };
        } else item.steerAnchor = { viewId: 'current' };
        item.revision = ++this.#state.ledgerRevision; item.updatedAt = this.#now();
        if (plan.kind === 'start-turn-fallback') this.#claimCycle(cycle, item, activity);
        const detached = structuredClone(item);
        const now = this.#now();
        const delivery: PersistedConversationDeliveryReceipt = {
          agentId: item.agentId,
          sessionId: item.sessionId,
          clientRequestId: item.clientRequestId,
          payloadHash: item.payloadHash,
          ...(item.baseline === undefined ? {} : { baseline: structuredClone(item.baseline) }),
          steerActionId: actionId,
          steerBaseRevision: item.steerBaseRevision!,
          steerAnchor: structuredClone(item.steerAnchor!),
          steerDispatchPlan: structuredClone(item.steerDispatchPlan!),
          ...(item.steerAttempts === undefined ? {}
            : { steerAttempts: structuredClone(item.steerAttempts) }),
          acceptedAt: now,
          expiresAt: now + SEND_RETENTION_MS,
          status: 'dispatching',
        };
        this.#state.submissions = this.#state.submissions.filter((candidate) => candidate !== item);
        this.#state.deliveryReceipts ??= [];
        this.#state.deliveryReceipts.push(delivery);
        try { this.#save(); return detached; } catch { this.#state = before; throw new ConversationContractError('Conversation queue is temporarily unavailable'); }
      });
    } catch { return rejected(); }
    const receipt = await this.#dispatchClaim(run, planned.clientRequestId, 'steer', planned);
    return {
      actionId, result: receipt.status === 'accepted' ? 'accepted'
        : receipt.status === 'unknown' ? 'unknown' : 'rejected',
      nativeMutation: receipt.nativeMutation ?? (receipt.status === 'unknown'
        ? 'unknown' : receipt.status === 'rejected' ? false : true),
      revision: receipt.submission?.revision ?? planned.revision,
      ...(receipt.submission ? { submission: receipt.submission } : {}),
    };
  }

  #requireQueued(run: AgentRunLease, itemId: string): PersistedConversationSubmission {
    const item = run.ref.sessionId
      ? this.#submission(run.ref.agentId, run.ref.sessionId, itemId) : undefined;
    if (!item || item.state !== 'queued') {
      throw new ConversationContractError('Queued message is no longer pending', 'invalid_request');
    }
    return item;
  }

  #requireEditLease(run: AgentRunLease, itemId: string, token: string): EditLease {
    const owner = sessionKey(run.ref.agentId, run.ref.sessionId!);
    const lease = this.#editLeases.get(owner);
    if (!lease || lease.submissionId !== itemId || lease.token !== token || lease.expiresAt <= this.#now()) {
      this.#editLeases.delete(owner);
      throw new ConversationContractError('Queue edit is no longer active', 'invalid_request');
    }
    return lease;
  }

  async #mutateQueued(
    run: AgentRunLease,
    itemId: string,
    mutate: (item: PersistedConversationSubmission) => void,
  ): Promise<void> {
    await this.#withWrite(() => {
      const item = this.#requireQueued(run, itemId);
      const before = structuredClone(this.#state);
      mutate(item);
      try { this.#save(); } catch { this.#state = before; throw new ConversationContractError('Conversation queue is temporarily unavailable'); }
    });
    this.#wake(sessionKey(run.ref.agentId, run.ref.sessionId!));
  }

  async #observeActivity(run: AgentRunLease, activity: ConversationActivitySnapshot): Promise<void> {
    if (!run.ref.sessionId) return;
    const owner = sessionKey(run.ref.agentId, run.ref.sessionId);
    let changed = false;
    await this.#withWrite(() => {
      const cycle = this.#cycle(run.ref.agentId, run.ref.sessionId!, activity);
      const before = structuredClone(this.#state);
      if (cycle.state === 'unknown' && cycle.activityEpoch !== activity.epoch) {
        cycle.activityEpoch = activity.epoch;
        cycle.baselineRevision = activity.revision;
        this.#setCycleCompletionBaseline(cycle, activity.completionToken);
        delete cycle.nonIdleRevision;
        if (activity.activity === 'idle' && activity.activeTurn.state === 'none') {
          cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
          delete cycle.ownerSubmissionId;
        } else if (activity.activity !== 'unknown') {
          cycle.state = 'awaiting_idle'; cycle.nonIdleRevision = activity.revision;
        }
        cycle.revision += 1; changed = true;
      } else if (cycle.state === 'unknown' && cycle.ownerSubmissionId === undefined
        && cycle.activityEpoch === activity.epoch
        && activity.activity === 'idle' && activity.activeTurn.state === 'none') {
        cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
        cycle.revision += 1; changed = true;
      } else if (cycle.state === 'unknown' && cycle.activityEpoch === activity.epoch
        && activity.revision > cycle.baselineRevision
        && activity.activity !== 'idle' && activity.activity !== 'unknown') {
        cycle.state = 'awaiting_idle'; cycle.nonIdleRevision = activity.revision;
        cycle.revision += 1; changed = true;
      } else if (cycle.activityEpoch !== activity.epoch && cycle.state !== 'closed') {
        cycle.state = 'unknown'; cycle.activityEpoch = activity.epoch;
        cycle.baselineRevision = activity.revision;
        this.#setCycleCompletionBaseline(cycle, activity.completionToken);
        cycle.revision += 1; changed = true;
      } else if (cycle.state === 'closed' && activity.activity !== 'idle' && activity.activity !== 'unknown') {
        cycle.state = 'awaiting_idle'; cycle.activityEpoch = activity.epoch;
        cycle.baselineRevision = activity.revision; cycle.nonIdleRevision = activity.revision;
        this.#setCycleCompletionBaseline(cycle, activity.completionToken);
        cycle.revision += 1; changed = true;
      } else if ((cycle.state === 'dispatching' || cycle.state === 'awaiting_non_idle')
        && cycle.activityEpoch === activity.epoch
        && cycle.baselineCompletionToken !== undefined
        && activity.completionToken !== undefined
        && activity.completionToken !== cycle.baselineCompletionToken
        && activity.activity === 'idle' && activity.activeTurn.state === 'none') {
        cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
        delete cycle.ownerSubmissionId; cycle.revision += 1; changed = true;
      } else if ((cycle.state === 'dispatching' || cycle.state === 'awaiting_non_idle')
        && cycle.activityEpoch === activity.epoch && activity.revision > cycle.baselineRevision
        && activity.activity !== 'idle' && activity.activity !== 'unknown') {
        cycle.state = 'awaiting_idle'; cycle.nonIdleRevision = activity.revision;
        cycle.revision += 1; changed = true;
      } else if (cycle.state === 'awaiting_idle' && cycle.activityEpoch === activity.epoch
        && activity.activity === 'idle' && activity.revision > (cycle.nonIdleRevision ?? cycle.baselineRevision)) {
        cycle.state = 'closed'; cycle.closedIdleRevision = activity.revision;
        delete cycle.ownerSubmissionId; cycle.revision += 1; changed = true;
      }
      if (changed) {
        try { this.#save(); } catch { this.#state = before; changed = false; }
      }
    });
    if (changed) this.#wake(owner);
  }

  #wake(owner: string): void {
    const state = this.#dispatchers.get(owner) ?? { running: false, wakePending: false, timer: undefined };
    this.#dispatchers.set(owner, state);
    state.wakePending = true;
    if (state.running) return;
    state.running = true;
    queueMicrotask(() => { void this.#runDispatcher(owner, state); });
  }

  async #runDispatcher(owner: string, state: DispatcherState): Promise<void> {
    try {
      do {
        state.wakePending = false;
        const run = this.#lastRuns.get(owner);
        if (!run || run.signal.aborted || !run.ref.sessionId) break;
        if (this.#dispatchFences.has(run.ref.agentId)) break;
        const activity = await this.#activitySource.read(run);
        await this.#observeActivity(run, activity);
        const claimed = await this.#withWrite(() => {
          if (activity.activity !== 'idle' || activity.activeTurn.state !== 'none') return null;
          const cycle = this.#cycle(run.ref.agentId, run.ref.sessionId!, activity);
          if (cycle.state !== 'closed') return null;
          const editing = this.#editLeases.get(owner);
          if (editing && editing.expiresAt > this.#now()) return null;
          const head = this.#state.submissions.filter((item) => item.agentId === run.ref.agentId
            && item.sessionId === run.ref.sessionId && item.state === 'queued'
            && item.autoDispatchBlockedReason === undefined)
            .sort((a, b) => String(a.queueOrderKey).localeCompare(String(b.queueOrderKey)))[0];
          if (!head) return null;
          const before = structuredClone(this.#state);
          head.state = 'dispatching'; head.dispatchOrigin = 'queue'; head.lastRunId = run.ref.runId;
          Object.assign(head, this.#currentBaseline(run.ref.agentId, run.ref.sessionId!));
          head.revision = ++this.#state.ledgerRevision; head.updatedAt = this.#now();
          this.#claimCycle(cycle, head, activity);
          try { this.#save(); return head.clientRequestId; } catch { this.#state = before; return null; }
        });
        if (claimed) await this.#dispatchClaim(run, claimed, 'queue');
      } while (state.wakePending);
    } finally {
      state.running = false;
      const run = this.#lastRuns.get(owner);
      const [agentId, sessionId] = owner.split('\0');
      const hasPending = this.#state.submissions.some((item) => item.agentId === agentId
        && item.sessionId === sessionId && item.state === 'queued'
        && item.autoDispatchBlockedReason === undefined);
      const cycle = this.#state.cycles.find((item) => item.agentId === agentId && item.sessionId === sessionId);
      if (run && !run.signal.aborted && (hasPending || (cycle && cycle.state !== 'closed' && cycle.state !== 'unknown'))) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => { state.timer = undefined; this.#wake(owner); }, 300);
        state.timer.unref?.();
      }
      if (state.wakePending) this.#wake(owner);
    }
  }
}
