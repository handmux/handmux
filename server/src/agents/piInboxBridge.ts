import type {
  BridgeDurableReplay,
  BridgeDurableReplayResult,
  BridgeEventEnvelope,
  BridgeHostChannelHandle,
  BridgeHostEvent,
  LocalAgentBridgeHost,
} from '../agent-runtime/bridgeTypes.js';
import type {
  InboxAvailability,
  InboxBaseline,
  InboxOperation,
  InboxOrderedProjector,
  InboxRestoreResult,
  InboxRunProjector,
  InboxState,
} from '../agent-runtime/inboxTypes.js';
import type { AgentRunLease, AgentRunRef } from '../agent-runtime/run.js';

const STATES = new Set<InboxState>(['working', 'waiting', 'done', 'error']);
const AVAILABILITIES = new Set<InboxAvailability>(['ready', 'degraded', 'unavailable']);
const EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export interface PiInboxBridgeItem {
  state: InboxState;
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId?: string;
  sourceOccurredAt?: number;
}

export interface PiInboxBridgeSnapshot {
  availability: InboxAvailability;
  current?: PiInboxBridgeItem;
  message?: string;
}

export type PiInboxBridgeOperation =
  | {
    kind: 'set';
    state: InboxState;
    message?: string | null;
    reason?: string | null;
    correlationId?: string;
    eventId?: string;
    sourceOccurredAt?: number;
  }
  | {
    kind: 'clear';
    correlationId?: string;
    eventId?: string;
    sourceOccurredAt?: number;
  }
  | {
    kind: 'superseded' | 'gap';
    eventId: string;
    sourceOccurredAt?: number;
  };

export interface PiInboxBridgeBinding {
  readonly run: AgentRunRef;
  close(): void;
}

export interface BridgeInboxCoordinatorOptions {
  host: LocalAgentBridgeHost;
  projector: InboxOrderedProjector;
  agentId?: string;
  sourceId?: string;
  label?: string;
}

export type PiInboxBridgeCoordinatorOptions = Omit<
  BridgeInboxCoordinatorOptions,
  'agentId' | 'label'
>;

export class PiInboxBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiInboxBridgeError';
  }
}

interface ParsedSnapshot {
  result: InboxRestoreResult;
  current: PiInboxBridgeItem | undefined;
}

interface BridgeInboxControlOperation {
  kind: 'superseded' | 'gap';
  source: { sourceId: string; cursor: string };
  eventId: string;
  sourceOccurredAt?: number;
}

type ParsedBridgeInboxOperation = InboxOperation | BridgeInboxControlOperation;

function isControlOperation(
  operation: ParsedBridgeInboxOperation,
): operation is BridgeInboxControlOperation {
  return operation.kind === 'superseded' || operation.kind === 'gap';
}

interface RuntimeBinding {
  lease: AgentRunLease;
  projector: InboxRunProjector;
  exposed: PiInboxBridgeBinding;
  phase: 'opening' | 'prebaseline' | 'live' | 'closed';
  baselineSequence: number;
  baseline: ParsedSnapshot | undefined;
  baselineReady: boolean;
  handle: BridgeHostChannelHandle | undefined;
  buffered: BridgeHostEvent[];
  tail: Promise<void>;
  abort: AbortController;
  detachAbort: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown, max: number, nullable = false): boolean {
  return value === undefined || (nullable && value === null)
    || (typeof value === 'string' && value.length > 0 && value.length <= max);
}

function optionalEventId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && EVENT_ID_RE.test(value));
}

function optionalTime(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function copyRun(ref: AgentRunRef): AgentRunRef {
  return {
    agentId: ref.agentId,
    paneId: ref.paneId,
    runId: ref.runId,
    ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
  };
}

function sameRun(first: AgentRunRef, second: AgentRunRef): boolean {
  return first.agentId === second.agentId
    && first.paneId === second.paneId
    && first.runId === second.runId
    && first.sessionId === second.sessionId;
}

function parseItem(value: unknown): PiInboxBridgeItem | null {
  if (!isRecord(value) || typeof value.state !== 'string' || !STATES.has(value.state as InboxState)
    || !optionalText(value.message, 4096) || !optionalText(value.reason, 1024)
    || !optionalText(value.correlationId, 256) || !optionalEventId(value.eventId)
    || !optionalTime(value.sourceOccurredAt)) return null;
  return {
    state: value.state as InboxState,
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(value.eventId === undefined ? {} : { eventId: value.eventId as string }),
    ...(value.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: value.sourceOccurredAt as number }),
  };
}

function parseSnapshot(
  value: unknown,
  availability: 'ready' | 'unavailable',
  run: AgentRunRef,
  sourceId: string,
  sequence: number,
  label = 'Pi',
): ParsedSnapshot {
  if (availability === 'unavailable') {
    return {
      current: undefined,
      result: { availability: 'unavailable', message: `${label} Inbox snapshot is unavailable` },
    };
  }
  if (!isRecord(value) || typeof value.availability !== 'string'
    || !AVAILABILITIES.has(value.availability as InboxAvailability)
    || !optionalText(value.message, 1024)) {
    throw new PiInboxBridgeError(`${label} Inbox Bridge returned an invalid snapshot`);
  }
  const snapshotAvailability = value.availability as InboxAvailability;
  if (snapshotAvailability === 'unavailable' && value.current !== undefined) {
    throw new PiInboxBridgeError(`Unavailable ${label} Inbox snapshot cannot contain current state`);
  }
  const current = value.current === undefined ? undefined : parseItem(value.current);
  if (value.current !== undefined && !current) {
    throw new PiInboxBridgeError(`${label} Inbox Bridge snapshot contains an invalid current state`);
  }
  const baseline: InboxBaseline[] = current ? [{
    run: copyRun(run),
    source: { sourceId, cursor: `bridge:${sequence}` },
    ...current,
  }] : [];
  return {
    current: current ?? undefined,
    result: {
      availability: snapshotAvailability,
      ...(snapshotAvailability === 'unavailable' ? {} : { snapshot: baseline }),
      ...(value.message === undefined ? {} : { message: value.message as string }),
    },
  };
}

function parseOperation(
  envelope: BridgeEventEnvelope,
  sourceId: string,
): ParsedBridgeInboxOperation | null {
  const value = envelope.payload;
  if (!isRecord(value)
    || (value.kind !== 'set' && value.kind !== 'clear'
      && value.kind !== 'superseded' && value.kind !== 'gap')
    || !optionalText(value.correlationId, 256) || !optionalEventId(value.eventId)
    || !optionalTime(value.sourceOccurredAt)
    || (envelope.eventId !== undefined && value.eventId !== undefined
      && envelope.eventId !== value.eventId)) return null;
  const eventId: string | undefined = typeof value.eventId === 'string'
    ? value.eventId : envelope.eventId;
  const base = {
    source: { sourceId, cursor: `bridge:${envelope.sequence}` },
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(value.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: value.sourceOccurredAt as number }),
  };
  if (value.kind === 'superseded' || value.kind === 'gap') {
    if (!eventId) return null;
    return { kind: value.kind, ...base, eventId };
  }
  if (value.kind === 'clear') return { kind: 'clear', ...base };
  if (typeof value.state !== 'string' || !STATES.has(value.state as InboxState)
    || !optionalText(value.message, 4096, true) || !optionalText(value.reason, 1024, true)) return null;
  const state = value.state as InboxState;
  if ((state === 'waiting' || state === 'done' || state === 'error') && eventId === undefined) return null;
  return {
    kind: 'set',
    state,
    ...base,
    ...(value.message === undefined ? {} : { message: value.message as string | null }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string | null }),
  };
}

// Owns only Bridge source ordering and semantic arbitration. Bridge sequence remains a source cursor;
// Inbox Core allocates the public run-scoped sequence and authoritative acceptedAt.
export class BridgeInboxCoordinator {
  readonly #host: LocalAgentBridgeHost;
  readonly #projector: InboxOrderedProjector;
  readonly #agentId: string;
  readonly #sourceId: string;
  readonly #label: string;
  readonly #bindings = new Map<string, RuntimeBinding>();
  #stopConsumer: (() => void) | undefined;
  #restoreTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor({
    host,
    projector,
    agentId = 'pi',
    sourceId = 'pi.bridge.inbox',
    label = 'Pi',
  }: BridgeInboxCoordinatorOptions) {
    this.#host = host;
    this.#projector = projector;
    this.#agentId = agentId;
    this.#sourceId = sourceId;
    this.#label = label;
  }

  start(): void {
    if (this.#closed) throw new PiInboxBridgeError(`${this.#label} Inbox Bridge coordinator is closed`);
    if (this.#stopConsumer) return;
    this.#stopConsumer = this.#host.consumeDurableReplays(
      'inbox',
      (replay) => this.#consumeDurable(replay),
    );
  }

  async bind(lease: AgentRunLease): Promise<PiInboxBridgeBinding> {
    if (this.#closed || lease.signal.aborted || lease.ref.agentId !== this.#agentId) {
      throw new PiInboxBridgeError(`${this.#label} Inbox Bridge requires a live run lease`);
    }
    this.start();
    const existing = this.#bindings.get(lease.ref.runId);
    if (existing) {
      if (existing.lease !== lease || existing.phase === 'closed') {
        throw new PiInboxBridgeError(`${this.#label} Inbox Bridge runId is already bound to another lease`);
      }
      return existing.exposed;
    }

    const binding = {} as RuntimeBinding;
    const exposed: PiInboxBridgeBinding = Object.freeze({
      run: copyRun(lease.ref),
      close: () => this.#closeBinding(binding),
    });
    Object.assign(binding, {
      lease,
      projector: this.#projector.forRun(lease),
      exposed,
      phase: 'opening',
      baselineSequence: 0,
      baseline: undefined,
      baselineReady: false,
      handle: undefined,
      buffered: [],
      tail: Promise.resolve(),
      abort: new AbortController(),
      detachAbort: () => {},
    } satisfies RuntimeBinding);
    const onAbort = (): void => this.#closeBinding(binding);
    lease.signal.addEventListener('abort', onAbort, { once: true });
    binding.detachAbort = () => lease.signal.removeEventListener('abort', onAbort);
    this.#bindings.set(lease.ref.runId, binding);

    try {
      const handle = await this.#host.openChannel(lease, 'inbox', async (event) => {
        if (binding.phase === 'closed') return;
        if (binding.phase !== 'live') {
          binding.buffered.push(event);
          return;
        }
        try {
          await this.#enqueue(binding, () => this.#processHostEvent(binding, event));
        } catch (error) {
          this.#closeBinding(binding);
          throw error;
        }
      });
      binding.handle = handle;
      binding.baselineSequence = handle.streamSequence;
      binding.baseline = parseSnapshot(
        handle.snapshot,
        handle.snapshotAvailability,
        lease.ref,
        this.#sourceId,
        handle.streamSequence,
        this.#label,
      );
      binding.phase = 'prebaseline';
      await this.#host.drainDurable(lease.ref, 'inbox', handle.streamSequence, {
        signal: binding.abort.signal,
      });
      if (lease.signal.aborted || this.#bindings.get(lease.ref.runId) !== binding) {
        throw new PiInboxBridgeError(`${this.#label} Inbox Bridge binding closed during restore`);
      }
      binding.baselineReady = true;
      await this.#restoreBindings();

      const buffered = binding.buffered.splice(0);
      let initialization = binding.tail;
      for (const event of buffered) {
        initialization = initialization.then(() => this.#processHostEvent(binding, event));
      }
      binding.tail = initialization.catch(() => {});
      binding.phase = 'live';
      await initialization;
      return exposed;
    } catch (error) {
      this.#closeBinding(binding);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopConsumer?.();
    this.#stopConsumer = undefined;
    for (const binding of [...this.#bindings.values()]) this.#closeBinding(binding);
  }

  async #consumeDurable(replay: BridgeDurableReplay): Promise<BridgeDurableReplayResult> {
    const operation = parseOperation(replay.event, this.#sourceId);
    if (!operation) return 'invalid';
    if (isControlOperation(operation)) {
      return replay.runStatus === 'current' ? 'accepted' : 'invalid';
    }
    if (replay.runStatus === 'revoked') {
      if (operation.kind !== 'set' || (operation.state !== 'done' && operation.state !== 'error')
        || !operation.eventId) return 'invalid';
      const result = await this.#projector.submitTerminalReplay({
        run: replay.run,
        source: operation.source,
        state: operation.state,
        eventId: operation.eventId,
        ...(typeof operation.message === 'string' ? { message: operation.message } : {}),
        ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}),
        ...(operation.correlationId === undefined ? {} : { correlationId: operation.correlationId }),
        ...(operation.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: operation.sourceOccurredAt }),
      });
      return this.#replayResult(result.accepted, result.reason);
    }

    const binding = this.#bindings.get(replay.run.runId);
    if (!binding || !sameRun(binding.lease.ref, replay.run) || binding.phase === 'opening'
      || binding.phase === 'closed') return 'retry';
    if (binding.phase === 'prebaseline') {
      if (replay.event.sequence > binding.baselineSequence) return 'retry';
      if (operation.kind === 'set' && operation.state === 'waiting'
        && binding.baseline?.result.availability === 'ready') {
        const current = binding.baseline.current;
        if (!current || current.state !== 'waiting' || current.eventId !== operation.eventId) return 'invalid';
      }
    }
    const result = await binding.projector.submit(operation);
    return this.#replayResult(result.accepted, result.reason);
  }

  #replayResult(accepted: boolean, reason: string | undefined): BridgeDurableReplayResult {
    if (accepted) return 'accepted';
    if (reason === 'persistence_failed' || reason === 'stale_lease') return 'retry';
    return 'invalid';
  }

  #enqueue(binding: RuntimeBinding, operation: () => Promise<void>): Promise<void> {
    const pending = binding.tail.then(operation);
    binding.tail = pending.catch(() => {});
    return pending;
  }

  #restore(result: () => InboxRestoreResult): Promise<void> {
    const pending = this.#restoreTail.then(() => this.#projector.restore(result()).then(() => undefined));
    this.#restoreTail = pending.catch(() => {});
    return pending;
  }

  #restoreBindings(): Promise<void> {
    return this.#restore(() => {
      const bindings = [...this.#bindings.values()].filter((binding) => binding.phase !== 'closed');
      const available = bindings.filter((binding) => (
        binding.baselineReady && binding.baseline?.result.availability !== 'unavailable'
      ));
      const pending = bindings.filter((binding) => !binding.baselineReady || !binding.baseline);
      const unavailable = bindings.filter((binding) => (
        binding.baselineReady && binding.baseline?.result.availability === 'unavailable'
      ));
      if ((pending.length || unavailable.length) && available.length === 0) {
        return {
          availability: 'unavailable',
          message: unavailable[0]?.baseline?.result.message
            ?? `${this.#label} Inbox baseline is still restoring`,
        };
      }
      const baselines = available.map((binding) => binding.baseline!);
      const degraded = baselines.find((baseline) => baseline.result.availability === 'degraded');
      return {
        availability: degraded || pending.length || unavailable.length ? 'degraded' : 'ready',
        snapshot: baselines.flatMap((baseline) => baseline.result.snapshot ?? []),
        ...((degraded?.result.message ?? unavailable[0]?.baseline?.result.message) === undefined
          ? {} : { message: degraded?.result.message ?? unavailable[0]!.baseline!.result.message }),
      };
    });
  }

  async #processHostEvent(binding: RuntimeBinding, event: BridgeHostEvent): Promise<void> {
    if (binding.phase === 'closed') return;
    if (event.type === 'gap') {
      await this.#restore(() => ({
        availability: 'unavailable',
        message: `${this.#label} Inbox stream gap after Bridge sequence ${event.afterSequence}`,
      }));
      this.#closeBinding(binding);
      throw new PiInboxBridgeError(`${this.#label} Inbox Bridge stream continuity was lost`);
    }
    if (event.type === 'snapshot') {
      const snapshot = parseSnapshot(
        event.value,
        'ready',
        binding.lease.ref,
        this.#sourceId,
        event.sequence,
        this.#label,
      );
      binding.baseline = snapshot;
      binding.baselineReady = true;
      await this.#restoreBindings();
      return;
    }
    const operation = parseOperation(event.event, this.#sourceId);
    if (!operation) throw new PiInboxBridgeError(`${this.#label} Inbox Bridge returned an invalid live event`);
    if (isControlOperation(operation)) return;
    const result = await binding.projector.submit(operation);
    if (!result.accepted) {
      throw new PiInboxBridgeError(`${this.#label} Inbox live operation rejected: ${result.reason ?? 'unknown'}`);
    }
  }

  #closeBinding(binding: RuntimeBinding): void {
    if (!binding || binding.phase === 'closed') return;
    binding.phase = 'closed';
    binding.abort.abort('binding_closed');
    binding.detachAbort();
    binding.handle?.close();
    binding.buffered = [];
    if (this.#bindings.get(binding.lease.ref.runId) === binding) {
      this.#bindings.delete(binding.lease.ref.runId);
      if (!this.#closed) void this.#restoreBindings().catch(() => {});
    }
  }
}

export class PiInboxBridgeCoordinator extends BridgeInboxCoordinator {
  constructor(options: PiInboxBridgeCoordinatorOptions) {
    super({ ...options, agentId: 'pi', label: 'Pi' });
  }
}
