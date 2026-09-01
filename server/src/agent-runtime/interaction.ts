import { randomUUID } from 'node:crypto';
import { MemoryInteractionStateStore } from './interactionStore.js';
import type {
  InteractionStateStore,
  PersistedInteraction,
  PersistedInteractionState,
} from './interactionStore.js';
import type {
  AgentInteractionAdapterV1,
  InteractionAdapterEvent,
  InteractionAdapterPending,
  InteractionEvent,
  InteractionEventSink,
  InteractionFormField,
  InteractionLiveHandle,
  InteractionDetail,
  InteractionOption,
  InteractionReceipt,
  InteractionResponse,
  InteractionValue,
  PendingInteraction,
} from './interactionTypes.js';
import type { AgentRunLease, AgentRunRef, AgentRunRegistry } from './run.js';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const TYPES = new Set(['approval', 'select', 'multi_select', 'text', 'editor', 'form', 'local_only']);
const RECEIPTS = new Set(['accepted', 'already_resolved', 'stale_run', 'rejected', 'unknown']);
const REASONS = new Set([
  'invalid_request', 'invalid_value', 'local_only', 'stale_run', 'already_resolved',
  'provider_rejected', 'temporarily_unavailable', 'stream_reset',
]);
const INTENTS = new Set([
  'command_approval', 'file_approval', 'permission_approval', 'input_request',
]);
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PRUNED_PER_MUTATION = 256;
const MAX_OPEN_BUFFER = 1024;

export class InteractionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractionContractError';
  }
}

interface LiveState {
  run: AgentRunLease;
  adapter: AgentInteractionAdapterV1;
  sink: InteractionEventSink;
  phase: 'buffering' | 'live' | 'closed';
  revision: number;
  sourceCursor: string;
  seenCursors: Set<string>;
  pendingBySource: Map<string, PersistedInteraction>;
  buffered: InteractionAdapterEvent[];
  openingFailure: InteractionContractError | undefined;
  tail: Promise<void>;
  nativeHandle: { close(): void | Promise<void> } | undefined;
  detachAbort: () => void;
  closed: Promise<void>;
  resolveClosed: () => void;
  exposed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function copyRun(run: AgentRunRef): AgentRunRef {
  return {
    agentId: run.agentId, paneId: run.paneId, runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  };
}

function options(value: unknown): InteractionOption[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const normalized: InteractionOption[] = [];
  const ids = new Set<string>();
  for (const option of value) {
    if (!isRecord(option) || !bounded(option.id, 256) || !bounded(option.label, 1024)
      || (option.description !== undefined && !bounded(option.description, 4096))
      || ids.has(option.id)) return null;
    ids.add(option.id);
    normalized.push({
      id: option.id, label: option.label,
      ...(option.description === undefined ? {} : { description: option.description as string }),
    });
  }
  return normalized;
}

function details(value: unknown): InteractionDetail[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const normalized: InteractionDetail[] = [];
  for (const detail of value) {
    if (!isRecord(detail) || !['text', 'code', 'path'].includes(String(detail.type))
      || !bounded(detail.text, 64 * 1024)
      || (detail.kind !== undefined
        && !['reason', 'command', 'working_directory', 'context'].includes(String(detail.kind)))) return null;
    normalized.push({
      type: detail.type as InteractionDetail['type'], text: detail.text,
      ...(detail.kind === undefined ? {} : {
        kind: detail.kind as NonNullable<InteractionDetail['kind']>,
      }),
    });
  }
  return normalized;
}

function fields(value: unknown): InteractionFormField[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const normalized: InteractionFormField[] = [];
  const ids = new Set<string>();
  for (const field of value) {
    if (!isRecord(field) || !bounded(field.id, 256) || !ID_RE.test(field.id)
      || ids.has(field.id) || !['text', 'secret', 'select'].includes(String(field.type))
      || !bounded(field.prompt, 16 * 1024)
      || (field.label !== undefined && !bounded(field.label, 1024))
      || (field.allowOther !== undefined && typeof field.allowOther !== 'boolean')) return null;
    const normalizedOptions = options(field.options);
    if (normalizedOptions === null || ((field.type === 'select') !== (normalizedOptions !== undefined))
      || (field.type !== 'select' && field.allowOther !== undefined)) return null;
    ids.add(field.id);
    normalized.push({
      id: field.id, type: field.type as InteractionFormField['type'], prompt: field.prompt,
      ...(field.label === undefined ? {} : { label: field.label as string }),
      ...(normalizedOptions === undefined ? {} : { options: normalizedOptions }),
      ...(field.allowOther === undefined ? {} : { allowOther: field.allowOther }),
    });
  }
  return normalized;
}

function pending(value: unknown): InteractionAdapterPending | null {
  if (!isRecord(value) || !bounded(value.id, 256) || !ID_RE.test(value.id)
    || !bounded(value.prompt, 16 * 1024) || typeof value.type !== 'string'
    || !TYPES.has(value.type) || (value.correlationId !== undefined
      && !bounded(value.correlationId, 256))
    || (value.intent !== undefined && !INTENTS.has(String(value.intent)))) return null;
  const normalizedOptions = options(value.options);
  const normalizedDetails = details(value.details);
  const normalizedFields = fields(value.fields);
  if (normalizedOptions === null || normalizedDetails === null || normalizedFields === null) return null;
  const requiresOptions = ['approval', 'select', 'multi_select'].includes(value.type);
  const requiresFields = value.type === 'form';
  if (requiresOptions !== (normalizedOptions !== undefined)
    || requiresFields !== (normalizedFields !== undefined)) return null;
  return {
    id: value.id,
    type: value.type as InteractionAdapterPending['type'],
    prompt: value.prompt,
    ...(value.intent === undefined ? {} : {
      intent: value.intent as NonNullable<InteractionAdapterPending['intent']>,
    }),
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(normalizedOptions === undefined ? {} : { options: normalizedOptions }),
    ...(normalizedDetails === undefined ? {} : { details: normalizedDetails }),
    ...(normalizedFields === undefined ? {} : { fields: normalizedFields }),
  };
}

function receipt(value: unknown): InteractionReceipt | null {
  if (!isRecord(value) || typeof value.status !== 'string' || !RECEIPTS.has(value.status)
    || (value.reason !== undefined && !REASONS.has(String(value.reason)))) return null;
  return {
    status: value.status as InteractionReceipt['status'],
    ...(value.reason === undefined ? {} : {
      reason: value.reason as NonNullable<InteractionReceipt['reason']>,
    }),
  };
}

function isDispatching(record: PersistedInteraction): boolean {
  return record.state === 'dispatching';
}

function responseValue(value: unknown, interaction: InteractionAdapterPending): InteractionValue | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const ids = new Set(interaction.options?.map((option) => option.id) ?? []);
  if (interaction.type === 'approval' && value.type === 'approval'
    && bounded(value.optionId, 256) && ids.has(value.optionId)) {
    return { type: 'approval', optionId: value.optionId };
  }
  if ((interaction.type === 'select' || interaction.type === 'multi_select')
    && value.type === 'selection' && Array.isArray(value.optionIds)
    && value.optionIds.every((id) => bounded(id, 256) && ids.has(id))
    && new Set(value.optionIds).size === value.optionIds.length
    && (interaction.type === 'multi_select' || value.optionIds.length === 1)) {
    return { type: 'selection', optionIds: [...value.optionIds] as string[] };
  }
  if ((interaction.type === 'text' || interaction.type === 'editor')
    && value.type === 'text' && typeof value.text === 'string'
    && value.text.length <= 256 * 1024) return { type: 'text', text: value.text };
  if (interaction.type === 'form' && value.type === 'form' && isRecord(value.answers)) {
    const fieldIds = interaction.fields?.map((field) => field.id) ?? [];
    const answerIds = Object.keys(value.answers);
    if (answerIds.length !== fieldIds.length || answerIds.some((id) => !fieldIds.includes(id))) return null;
    const answers: Record<string, string> = {};
    for (const id of fieldIds) {
      const answer = value.answers[id];
      if (typeof answer !== 'string' || answer.length === 0 || answer.length > 256 * 1024) return null;
      const field = interaction.fields?.find((candidate) => candidate.id === id);
      if (!field || (field.type === 'select'
        && !field.options?.some((option) => option.id === answer) && !field.allowOther)) return null;
      answers[id] = answer;
    }
    return { type: 'form', answers };
  }
  return null;
}

function publicPending(record: PersistedInteraction): PendingInteraction {
  const value = record.pending;
  return {
    id: record.publicInteractionId,
    runId: record.run.runId,
    type: value.type,
    prompt: value.prompt,
    resolutionToken: record.resolutionToken,
    ...(value.intent === undefined ? {} : { intent: value.intent }),
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId }),
    ...(value.options === undefined ? {} : { options: structuredClone(value.options) }),
    ...(value.details === undefined ? {} : { details: structuredClone(value.details) }),
    ...(value.fields === undefined ? {} : { fields: structuredClone(value.fields) }),
  };
}

function validRun(value: unknown): value is AgentRunRef {
  return isRecord(value) && bounded(value.agentId, 64) && bounded(value.paneId, 256)
    && bounded(value.runId, 256)
    && (value.sessionId === undefined || bounded(value.sessionId, 1024));
}

function parseState(raw: unknown, now: number): PersistedInteractionState {
  if (raw === null || raw === undefined) return { version: 1, interactions: [] };
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.interactions)) {
    throw new InteractionContractError('Unsupported or corrupt Interaction state');
  }
  const publicIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const interactions: PersistedInteraction[] = [];
  for (const value of raw.interactions) {
    if (!isRecord(value) || !bounded(value.agentId, 64) || !validRun(value.run)
      || value.run.agentId !== value.agentId || !bounded(value.sourceInteractionId, 256)
      || !bounded(value.publicInteractionId, 1024) || !bounded(value.resolutionToken, 1024)
      || !['pending', 'dispatching', 'resolved'].includes(String(value.state))
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
      throw new InteractionContractError('Corrupt Interaction record');
    }
    const normalizedPending = pending(value.pending);
    const normalizedReceipt = value.receipt === undefined ? undefined : receipt(value.receipt);
    if (!normalizedPending || normalizedReceipt === null
      || (value.state === 'resolved' && !normalizedReceipt)
      || (value.state !== 'resolved' && value.receipt !== undefined)) {
      throw new InteractionContractError('Corrupt Interaction payload or receipt');
    }
    const sourceKey = `${value.agentId}\0${value.run.runId}\0${value.sourceInteractionId}`;
    if (publicIds.has(value.publicInteractionId) || sourceKeys.has(sourceKey)) {
      throw new InteractionContractError('Duplicate Interaction identity');
    }
    publicIds.add(value.publicInteractionId);
    sourceKeys.add(sourceKey);
    if (value.state === 'resolved' && value.updatedAt + RESOLVED_RETENTION_MS <= now) continue;
    interactions.push({
      agentId: value.agentId,
      run: copyRun(value.run),
      sourceInteractionId: value.sourceInteractionId,
      publicInteractionId: value.publicInteractionId,
      resolutionToken: value.resolutionToken,
      pending: normalizedPending,
      state: value.state as PersistedInteraction['state'],
      ...(normalizedReceipt === undefined ? {} : { receipt: normalizedReceipt }),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  }
  return { version: 1, interactions };
}

export interface InteractionServiceOptions {
  runs: AgentRunRegistry;
  adapters: Readonly<Record<string, AgentInteractionAdapterV1>>;
  store?: InteractionStateStore;
  now?: () => number;
  newToken?: () => string;
}

export class InteractionService {
  readonly #runs: AgentRunRegistry;
  readonly #adapters: ReadonlyMap<string, AgentInteractionAdapterV1>;
  readonly #store: InteractionStateStore;
  readonly #now: () => number;
  readonly #newToken: () => string;
  readonly #open = new Map<string, LiveState>();
  readonly #issued = new Set<string>();
  readonly #terminalPersistenceFailures = new Set<string>();
  #state: PersistedInteractionState;
  #writeTail: Promise<void> = Promise.resolve();

  constructor({
    runs,
    adapters,
    store = new MemoryInteractionStateStore(),
    now = Date.now,
    newToken = randomUUID,
  }: InteractionServiceOptions) {
    if (!runs || !isRecord(adapters) || Object.keys(adapters).length === 0) {
      throw new TypeError('InteractionService requires a run registry and adapters');
    }
    const map = new Map<string, AgentInteractionAdapterV1>();
    for (const [agentId, adapter] of Object.entries(adapters)) {
      if (!bounded(agentId, 64) || !adapter || adapter.apiVersion !== 1
        || typeof adapter.observeNative !== 'function'
        || typeof adapter.dispatchResponse !== 'function') {
        throw new TypeError(`Invalid Interaction adapter: ${agentId}`);
      }
      map.set(agentId, adapter);
    }
    this.#runs = runs;
    this.#adapters = map;
    this.#store = store;
    this.#now = now;
    this.#newToken = newToken;
    this.#state = parseState(store.load(), now());
    let changed = false;
    for (const record of this.#state.interactions) {
      if (isDispatching(record)) {
        record.state = 'resolved';
        record.receipt = { status: 'unknown', reason: 'temporarily_unavailable' };
        record.updatedAt = now();
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  async open(run: AgentRunLease, sink: InteractionEventSink): Promise<InteractionLiveHandle> {
    this.#requireRun(run);
    if (typeof sink !== 'function' || this.#open.has(run.ref.runId)) {
      throw new InteractionContractError('Invalid or duplicate Interaction open');
    }
    const adapter = this.#adapter(run.ref.agentId);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const state: LiveState = {
      run, adapter, sink, phase: 'buffering', revision: 0, sourceCursor: '',
      seenCursors: new Set(), pendingBySource: new Map(), buffered: [],
      openingFailure: undefined,
      tail: Promise.resolve(), nativeHandle: undefined, detachAbort: () => {},
      closed, resolveClosed, exposed: false,
    };
    const onAbort = (): void => {
      void this.#enqueue(state, () => this.#cancelRevoked(state)).catch(() => {});
    };
    run.signal.addEventListener('abort', onAbort, { once: true });
    state.detachAbort = () => run.signal.removeEventListener('abort', onAbort);
    this.#open.set(run.ref.runId, state);
    try {
      const nativeHandle = await adapter.observeNative(run, (event) => this.#accept(state, event));
      state.nativeHandle = nativeHandle;
      this.#throwOpeningFailure(state);
      if (run.signal.aborted || this.#runs.resolve(run.ref) !== run || state.phase === 'closed') {
        throw new InteractionContractError('Interaction run was revoked during open');
      }
      const checkpoint = nativeHandle.checkpoint;
      if (!isRecord(checkpoint) || !bounded(checkpoint.sourceCursor, 1024)
        || !Array.isArray(checkpoint.pending)) {
        throw new InteractionContractError('Interaction adapter returned an invalid checkpoint');
      }
      const baseline = checkpoint.pending.map((item) => pending(item));
      if (baseline.some((item) => item === null)
        || new Set(baseline.map((item) => item!.id)).size !== baseline.length) {
        throw new InteractionContractError('Interaction checkpoint contains invalid pending items');
      }
      state.sourceCursor = checkpoint.sourceCursor;
      state.seenCursors.add(checkpoint.sourceCursor);
      await this.#withWrite(() => {
        const sourceIds = new Set(baseline.map((item) => item!.id));
        for (const record of this.#recordsFor(run.ref)) {
          if (record.state === 'pending' && !sourceIds.has(record.sourceInteractionId)) {
            record.state = 'resolved';
            record.receipt = { status: 'already_resolved', reason: 'already_resolved' };
            record.updatedAt = this.#now();
          }
        }
        for (const item of baseline as InteractionAdapterPending[]) {
          let record = this.#recordBySource(run.ref, item.id);
          if (!record) {
            record = this.#createRecord(run.ref, item);
            this.#state.interactions.push(record);
          } else if (record.state === 'pending') {
            record.pending = item;
            record.updatedAt = this.#now();
          }
          if (record.state === 'pending') state.pendingBySource.set(item.id, record);
        }
        this.#save();
      });
      this.#throwOpeningFailure(state);
      const exposed: InteractionLiveHandle = Object.freeze({
        revision: state.revision,
        pending: [...state.pendingBySource.values()].map(publicPending),
        closed: state.closed,
        close: () => this.#close(state),
      });
      state.exposed = true;
      setTimeout(() => { this.#flush(state); }, 0).unref?.();
      return exposed;
    } catch (error) {
      await this.#close(state);
      throw error;
    }
  }

  async respond(run: AgentRunLease, request: InteractionResponse): Promise<InteractionReceipt> {
    try { this.#requireRun(run); } catch { return { status: 'stale_run' }; }
    if (!isRecord(request) || !bounded(request.interactionId, 1024)
      || !bounded(request.resolutionToken, 1024)) return { status: 'rejected', reason: 'invalid_request' };
    const record = this.#state.interactions.find((item) => (
      item.publicInteractionId === request.interactionId && item.run.runId === run.ref.runId
        && item.agentId === run.ref.agentId
    ));
    if (!record || record.resolutionToken !== request.resolutionToken) {
      return { status: 'rejected', reason: 'invalid_request' };
    }
    if (record.state === 'dispatching'
      && this.#terminalPersistenceFailures.has(record.publicInteractionId)) {
      return { status: 'unknown', reason: 'temporarily_unavailable' };
    }
    if (record.state !== 'dispatching') {
      this.#terminalPersistenceFailures.delete(record.publicInteractionId);
    }
    if (record.state !== 'pending') return record.receipt ?? { status: 'already_resolved' };
    if (record.pending.type === 'local_only') return { status: 'rejected', reason: 'local_only' };
    const value = responseValue(request.value, record.pending);
    if (!value) return { status: 'rejected', reason: 'invalid_value' };

    let claimed = false;
    try {
      claimed = await this.#withWrite(() => {
        if (record.state !== 'pending') return false;
        record.state = 'dispatching';
        record.updatedAt = this.#now();
        try {
          this.#save();
        } catch (error) {
          record.state = 'pending';
          throw error;
        }
        return true;
      });
    } catch {
      return { status: 'unknown', reason: 'temporarily_unavailable' };
    }
    if (!claimed) return record.receipt ?? { status: 'already_resolved' };

    let result: InteractionReceipt;
    try {
      result = await this.#raceAbort(run, this.#adapter(run.ref.agentId).dispatchResponse(run, {
        interactionId: record.sourceInteractionId,
        value,
      }));
    } catch {
      result = { status: 'unknown', reason: 'temporarily_unavailable' };
    }
    const normalized = receipt(result) ?? { status: 'unknown', reason: 'temporarily_unavailable' as const };
    try {
      const finalized = await this.#finalizeResponse(run, record, normalized);
      this.#terminalPersistenceFailures.delete(record.publicInteractionId);
      return finalized;
    } catch {
      if (isDispatching(record)) {
        this.#terminalPersistenceFailures.add(record.publicInteractionId);
        return { status: 'unknown', reason: 'temporarily_unavailable' };
      }
      return normalized;
    }
  }

  async shutdown(): Promise<void> {
    const states = [...this.#open.values()];
    await Promise.all(states.map(async (state) => {
      if (!state.run.signal.aborted) return this.#close(state);
      await state.closed;
    }));
    await this.#writeTail.catch(() => {});
  }

  #adapter(agentId: string): AgentInteractionAdapterV1 {
    const adapter = this.#adapters.get(agentId);
    if (!adapter) throw new InteractionContractError(`Interaction adapter is unavailable: ${agentId}`);
    return adapter;
  }

  #requireRun(run: AgentRunLease): void {
    if (!run || run.signal.aborted || this.#runs.resolve(run.ref) !== run) {
      throw new InteractionContractError('Interaction operation requires a live run lease');
    }
  }

  #token(prefix: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = `${prefix}:${this.#newToken()}`;
      if (bounded(token, 1024) && !this.#issued.has(token)
        && !this.#state.interactions.some((record) => (
          record.publicInteractionId === token || record.resolutionToken === token
        ))) {
        this.#issued.add(token);
        return token;
      }
    }
    throw new InteractionContractError(`Unable to allocate Interaction ${prefix}`);
  }

  #createRecord(run: AgentRunRef, item: InteractionAdapterPending): PersistedInteraction {
    const now = this.#now();
    return {
      agentId: run.agentId,
      run: copyRun(run),
      sourceInteractionId: item.id,
      publicInteractionId: this.#token('interaction'),
      resolutionToken: this.#token('resolution'),
      pending: structuredClone(item),
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  }

  #recordsFor(run: AgentRunRef): PersistedInteraction[] {
    return this.#state.interactions.filter((record) => (
      record.agentId === run.agentId && record.run.runId === run.runId
    ));
  }

  #recordBySource(run: AgentRunRef, sourceId: string): PersistedInteraction | undefined {
    return this.#recordsFor(run).find((record) => record.sourceInteractionId === sourceId);
  }

  #accept(state: LiveState, event: InteractionAdapterEvent): Promise<void> {
    if (state.phase === 'closed') return Promise.resolve();
    if (state.openingFailure) return Promise.reject(state.openingFailure);
    let cloned: InteractionAdapterEvent;
    try { cloned = structuredClone(event); } catch {
      const failure = new InteractionContractError('Interaction event is not cloneable');
      if (state.phase === 'buffering') state.openingFailure = failure;
      else this.#triggerFailClosed(state);
      return Promise.reject(failure);
    }
    if (state.phase === 'buffering') {
      if (state.buffered.length >= MAX_OPEN_BUFFER) {
        state.openingFailure = new InteractionContractError('Interaction open buffer is full');
        return Promise.reject(state.openingFailure);
      }
      state.buffered.push(cloned);
      return Promise.resolve();
    }
    return this.#enqueue(state, () => this.#process(state, cloned));
  }

  #enqueue(state: LiveState, operation: () => Promise<void>): Promise<void> {
    const pendingOperation = state.tail.then(operation);
    state.tail = pendingOperation.catch(async () => {
      try { await this.#failClosed(state); } catch { /* Callback keeps the original contract error. */ }
    });
    return pendingOperation;
  }

  #flush(state: LiveState): void {
    if (state.phase !== 'buffering') return;
    state.phase = 'live';
    if (state.openingFailure) {
      state.buffered = [];
      this.#triggerFailClosed(state);
      return;
    }
    for (const event of state.buffered.splice(0)) {
      void this.#accept(state, event).catch(() => { this.#triggerFailClosed(state); });
    }
  }

  #throwOpeningFailure(state: LiveState): void {
    if (state.openingFailure) throw state.openingFailure;
  }

  #triggerFailClosed(state: LiveState): void {
    void this.#failClosed(state).catch(() => {});
  }

  async #process(state: LiveState, event: InteractionAdapterEvent): Promise<void> {
    if (!isRecord(event) || !bounded(event.sourceCursor, 1024)
      || state.seenCursors.has(event.sourceCursor)) {
      throw new InteractionContractError('Interaction source cursor is invalid or duplicate');
    }
    state.seenCursors.add(event.sourceCursor);
    state.sourceCursor = event.sourceCursor;
    if (event.type === 'opened') {
      const item = pending(event.interaction);
      if (!item) throw new InteractionContractError('Interaction opened payload is invalid');
      let record = this.#recordBySource(state.run.ref, item.id);
      if (record && record.state !== 'pending') {
        throw new InteractionContractError('Resolved native interaction id was reused');
      }
      await this.#withWrite(() => {
        if (!record) {
          record = this.#createRecord(state.run.ref, item);
          this.#state.interactions.push(record);
        } else {
          record.pending = item;
          record.updatedAt = this.#now();
        }
        this.#save();
      });
      state.pendingBySource.set(item.id, record!);
      await this.#emit(state, {
        type: 'opened', revision: ++state.revision, interaction: publicPending(record!),
      });
      return;
    }
    if (event.type !== 'resolved' && event.type !== 'cancelled') {
      throw new InteractionContractError('Unknown Interaction adapter event');
    }
    if (!bounded(event.interactionId, 256)
      || (event.type === 'cancelled' && event.reason !== undefined && !REASONS.has(event.reason))) {
      throw new InteractionContractError('Interaction terminal payload is invalid');
    }
    const record = state.pendingBySource.get(event.interactionId);
    if (!record) throw new InteractionContractError('Interaction terminal event targets unknown pending item');
    await this.#withWrite(() => {
      record.state = 'resolved';
      record.receipt = event.type === 'resolved'
        ? { status: 'already_resolved', reason: 'already_resolved' }
        : { status: 'rejected', reason: event.reason ?? 'provider_rejected' };
      record.updatedAt = this.#now();
      this.#save();
    });
    state.pendingBySource.delete(event.interactionId);
    await this.#emit(state, event.type === 'resolved'
      ? { type: 'resolved', revision: ++state.revision, interactionId: record.publicInteractionId }
      : {
        type: 'cancelled', revision: ++state.revision, interactionId: record.publicInteractionId,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
  }

  async #finalizeResponse(
    run: AgentRunLease,
    record: PersistedInteraction,
    result: InteractionReceipt,
  ): Promise<InteractionReceipt> {
    const live = this.#open.get(run.ref.runId);
    const finish = async (): Promise<void> => {
      let finalized = false;
      await this.#withWrite(() => {
        if (record.state !== 'dispatching') return;
        if (result.status === 'rejected' && !run.signal.aborted
          && this.#runs.resolve(run.ref) === run) {
          const before = { state: record.state, updatedAt: record.updatedAt } as const;
          record.state = 'pending';
          record.updatedAt = this.#now();
          try { this.#save(); } catch (error) {
            record.state = before.state;
            record.updatedAt = before.updatedAt;
            throw error;
          }
          return;
        }
        const before = {
          state: record.state, receipt: record.receipt, updatedAt: record.updatedAt,
        } as const;
        record.state = 'resolved';
        record.receipt = result;
        record.updatedAt = this.#now();
        try { this.#save(); } catch (error) {
          record.state = before.state;
          if (before.receipt === undefined) delete record.receipt;
          else record.receipt = before.receipt;
          record.updatedAt = before.updatedAt;
          throw error;
        }
        finalized = true;
      });
      if (!finalized || !live || !live.exposed || live.phase === 'closed') return;
      live.pendingBySource.delete(record.sourceInteractionId);
      if (result.status === 'accepted' || result.status === 'already_resolved') {
        await this.#emit(live, {
          type: 'resolved', revision: ++live.revision, interactionId: record.publicInteractionId,
        });
      } else {
        await this.#emit(live, {
          type: 'cancelled', revision: ++live.revision, interactionId: record.publicInteractionId,
          reason: result.reason ?? 'temporarily_unavailable',
        });
      }
    };
    if (live) await this.#enqueue(live, finish);
    else await finish();
    return result;
  }

  async #raceAbort(run: AgentRunLease, operation: Promise<InteractionReceipt>): Promise<InteractionReceipt> {
    if (run.signal.aborted) return { status: 'stale_run' };
    return new Promise((resolve, reject) => {
      const abort = (): void => resolve({ status: 'stale_run' });
      run.signal.addEventListener('abort', abort, { once: true });
      operation.then(
        (value) => { run.signal.removeEventListener('abort', abort); resolve(value); },
        (error: unknown) => { run.signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }

  async #cancelRevoked(state: LiveState): Promise<void> {
    if (state.phase === 'closed') return;
    const records = [...state.pendingBySource.values()];
    try {
      await this.#withWrite(() => {
        const before = records.map((record) => ({
          record, state: record.state, receipt: record.receipt, updatedAt: record.updatedAt,
        }));
        for (const record of records) {
          record.state = 'resolved';
          record.receipt = { status: 'stale_run', reason: 'stale_run' };
          record.updatedAt = this.#now();
        }
        try {
          if (records.length) this.#save();
        } catch (error) {
          for (const item of before) {
            item.record.state = item.state;
            if (item.receipt === undefined) delete item.record.receipt;
            else item.record.receipt = item.receipt;
            item.record.updatedAt = item.updatedAt;
          }
          throw error;
        }
      });
      if (state.exposed) {
        for (const record of records) {
          await this.#emit(state, {
            type: 'cancelled', revision: ++state.revision,
            interactionId: record.publicInteractionId, reason: 'stale_run',
          });
        }
      }
    } finally {
      await this.#close(state);
    }
  }

  async #failClosed(state: LiveState): Promise<void> {
    if (state.phase === 'closed') return;
    const records = [...state.pendingBySource.values()];
    try {
      await this.#withWrite(() => {
        const before = records.map((record) => ({
          record, state: record.state, receipt: record.receipt, updatedAt: record.updatedAt,
        }));
        for (const record of records) {
          record.state = 'resolved';
          record.receipt = { status: 'unknown', reason: 'stream_reset' };
          record.updatedAt = this.#now();
        }
        try {
          if (records.length) this.#save();
        } catch (error) {
          for (const item of before) {
            item.record.state = item.state;
            if (item.receipt === undefined) delete item.record.receipt;
            else item.record.receipt = item.receipt;
            item.record.updatedAt = item.updatedAt;
          }
          throw error;
        }
      });
      if (state.exposed) {
        for (const record of records) {
          try {
            await this.#emit(state, {
              type: 'cancelled', revision: ++state.revision,
              interactionId: record.publicInteractionId, reason: 'stream_reset',
            });
          } catch { break; }
        }
      }
    } finally {
      await this.#close(state);
    }
  }

  async #emit(state: LiveState, event: InteractionEvent): Promise<void> {
    if (state.exposed && state.phase !== 'closed') await state.sink(structuredClone(event));
  }

  async #close(state: LiveState): Promise<void> {
    if (state.phase === 'closed') return;
    state.phase = 'closed';
    state.detachAbort();
    state.buffered = [];
    if (this.#open.get(state.run.ref.runId) === state) this.#open.delete(state.run.ref.runId);
    try { await state.nativeHandle?.close(); } catch { /* best effort */ }
    state.resolveClosed();
  }

  async #withWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await operation(); } finally { release(); }
  }

  #save(): void {
    const before = this.#state.interactions;
    const now = this.#now();
    let pruned = 0;
    this.#state.interactions = before.filter((record) => {
      if (pruned >= MAX_PRUNED_PER_MUTATION || record.state !== 'resolved'
        || record.updatedAt + RESOLVED_RETENTION_MS > now) return true;
      pruned += 1;
      return false;
    });
    try {
      this.#store.save(structuredClone(this.#state));
    } catch (error) {
      this.#state.interactions = before;
      throw error;
    }
  }
}
