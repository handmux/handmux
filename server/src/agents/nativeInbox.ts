import type {
  AgentRuntimeCapabilityContext,
} from '../agent-runtime/runtime.js';
import type { LivePane } from '../agent-runtime/adapter.js';
import type {
  InboxAvailability,
  InboxBaseline,
  InboxOperation,
  InboxRunProjector,
  InboxState,
} from '../agent-runtime/inboxTypes.js';
import type { AgentRunLease } from '../agent-runtime/run.js';

export interface NativeInboxRow {
  paneId: string;
  sessionId?: string;
  cursor: string;
  state: InboxState | null;
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId?: string;
  sourceOccurredAt?: number;
}

export interface NativeInboxSnapshot {
  availability: InboxAvailability;
  rows: NativeInboxRow[];
  message?: string;
}

export interface NativeInboxSource {
  read(panes: readonly LivePane[]): Promise<NativeInboxSnapshot>;
}

export interface NativeInboxCoordinatorOptions {
  agentId: string;
  sourceId: string;
  context: AgentRuntimeCapabilityContext;
  source: NativeInboxSource;
  pollMs?: number;
}

interface TrackedPane {
  lease: AgentRunLease;
  projector: InboxRunProjector;
  row: NativeInboxRow;
}

function operation(sourceId: string, row: NativeInboxRow): InboxOperation {
  const base = {
    source: { sourceId, cursor: row.cursor },
    ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
    ...(row.correlationId === undefined ? {} : { correlationId: row.correlationId }),
    ...(row.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: row.sourceOccurredAt }),
  };
  return row.state === null
    ? { kind: 'clear', ...base }
    : {
      kind: 'set', state: row.state, ...base,
      message: row.message ?? null,
      reason: row.reason ?? null,
    };
}

function baseline(sourceId: string, tracked: TrackedPane): InboxBaseline | null {
  const row = tracked.row;
  if (row.state === null) return null;
  return {
    run: tracked.lease.ref,
    source: { sourceId, cursor: row.cursor },
    state: row.state,
    ...(row.message === undefined ? {} : { message: row.message }),
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.correlationId === undefined ? {} : { correlationId: row.correlationId }),
    ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
    ...(row.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: row.sourceOccurredAt }),
  };
}

function validRow(row: NativeInboxRow, panes: ReadonlyMap<string, LivePane>): boolean {
  return panes.has(row.paneId) && row.cursor.length > 0 && row.cursor.length <= 4096
    && (row.sessionId === undefined || (row.sessionId.length > 0 && row.sessionId.length <= 1024))
    && (row.correlationId === undefined
      || (row.correlationId.length > 0 && row.correlationId.length <= 256))
    && (row.eventId === undefined || (row.eventId.length > 0 && row.eventId.length <= 256))
    && ((row.state !== 'waiting' && row.state !== 'done' && row.state !== 'error')
      || row.eventId !== undefined);
}

// Temporary built-in migration coordinator. It consumes provider-normalized pane rows, while Runtime owns
// verified attachments and Inbox Core owns ordering, acceptedAt, persistence, and unread semantics.
export class NativeInboxCoordinator {
  readonly #agentId: string;
  readonly #sourceId: string;
  readonly #context: AgentRuntimeCapabilityContext;
  readonly #source: NativeInboxSource;
  readonly #pollMs: number;
  readonly #tracked = new Map<string, TrackedPane>();
  #timer: NodeJS.Timeout | undefined;
  #tail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #baselineReady = false;
  #availability: InboxAvailability | undefined;
  #availabilityMessage: string | undefined;

  constructor({
    agentId, sourceId, context, source, pollMs = 500,
  }: NativeInboxCoordinatorOptions) {
    if (!agentId || !sourceId || !context || !source || typeof source.read !== 'function'
      || !Number.isSafeInteger(pollMs) || pollMs < 100) {
      throw new TypeError('Native Inbox coordinator requires a source and bounded poll interval');
    }
    this.#agentId = agentId;
    this.#sourceId = sourceId;
    this.#context = context;
    this.#source = source;
    this.#pollMs = pollMs;
  }

  start(): () => Promise<void> {
    if (this.#closed) throw new Error('Native Inbox coordinator is closed');
    if (!this.#started) {
      this.#started = true;
      this.#poll();
    }
    return () => this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#tail.catch(() => {});
    this.#tracked.clear();
  }

  reconcile(): Promise<void> {
    const pending = this.#tail.then(() => this.#reconcile());
    this.#tail = pending.catch(() => {});
    return pending;
  }

  #poll(): void {
    if (this.#closed) return;
    void this.reconcile().catch((error) => {
      this.#context.health.report({
        capability: 'inbox', availability: 'degraded',
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => this.#poll(), this.#pollMs);
      this.#timer.unref?.();
    });
  }

  async #reconcile(): Promise<void> {
    if (this.#closed || this.#context.signal.aborted) return;
    let panes: readonly LivePane[];
    let snapshot: NativeInboxSnapshot;
    try {
      panes = await this.#context.panes.list();
      snapshot = await this.#source.read(panes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#availability !== 'unavailable' || this.#availabilityMessage !== message) {
        await this.#context.inbox.restore({ availability: 'unavailable', message });
        this.#availability = 'unavailable';
        this.#availabilityMessage = message;
      }
      this.#baselineReady = false;
      throw error;
    }
    const paneMap = new Map(panes.map((pane) => [pane.paneId, pane]));
    if (!['ready', 'degraded', 'unavailable'].includes(snapshot.availability)
      || !Array.isArray(snapshot.rows) || snapshot.rows.some((row) => !validRow(row, paneMap))
      || new Set(snapshot.rows.map((row) => row.paneId)).size !== snapshot.rows.length) {
      throw new Error(`${this.#agentId} Inbox source returned an invalid snapshot`);
    }
    if (snapshot.availability === 'unavailable') {
      if (this.#availability !== 'unavailable' || this.#availabilityMessage !== snapshot.message) {
        await this.#context.inbox.restore({
          availability: 'unavailable',
          ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
        });
        this.#availability = 'unavailable';
        this.#availabilityMessage = snapshot.message;
      }
      this.#baselineReady = false;
      return;
    }

    let topologyChanged = !this.#baselineReady;
    const rows = new Map(snapshot.rows.map((row) => [row.paneId, structuredClone(row)]));
    // Root Runtime independently revokes a run when its foreground-process proof changes. A coordinator
    // entry must not outlive that lease: retaining it feeds a revoked run into Inbox.restore() and blocks
    // every healthy pane in the same provider snapshot.
    for (const [paneId, tracked] of [...this.#tracked]) {
      if (!tracked.lease.signal.aborted
        && this.#context.runs.resolve(tracked.lease.ref) === tracked.lease) continue;
      this.#tracked.delete(paneId);
      topologyChanged = true;
    }
    for (const [paneId] of [...this.#tracked]) {
      if (rows.has(paneId)) continue;
      this.#tracked.delete(paneId);
      topologyChanged = true;
    }

    let associationError: string | undefined;
    for (const row of rows.values()) {
      try {
        let lease = this.#context.currentRunForPane(row.paneId);
        if (!lease || lease.ref.agentId !== this.#agentId
          || this.#context.runs.resolve(lease.ref) !== lease) {
          // A stale socket/source row is not process ownership evidence. Runtime will retry process
          // discovery independently; until then this row must not create or degrade a run.
          rows.delete(row.paneId);
          continue;
        }
        if (row.sessionId !== undefined && lease.ref.sessionId === undefined) {
          await this.#context.runControl.associateSession(lease, row.sessionId);
          topologyChanged = true;
        } else if (row.sessionId !== undefined && lease.ref.sessionId !== row.sessionId) {
          lease = await this.#context.runControl.replaceSession(lease, row.sessionId);
          topologyChanged = true;
        }
        let tracked = this.#tracked.get(row.paneId);
        if (!tracked || tracked.lease !== lease) {
          tracked = {
            lease, projector: this.#context.inbox.forRun(lease),
            row,
          };
          this.#tracked.set(row.paneId, tracked);
          topologyChanged = true;
        }
      } catch (error) {
        // One stale run/session association must not suppress every other pane from the same provider.
        // Keep any previously projected row and retry after Runtime has reconciled process ownership.
        rows.delete(row.paneId);
        associationError ??= error instanceof Error ? error.message : String(error);
      }
    }

    const effectiveAvailability = associationError ? 'degraded' : snapshot.availability;
    const effectiveMessage = associationError ?? snapshot.message;
    const availabilityChanged = this.#availability !== effectiveAvailability
      || this.#availabilityMessage !== effectiveMessage;
    const restoreNeeded = topologyChanged || availabilityChanged;
    if (restoreNeeded) {
      const baselines = [...this.#tracked.values()].flatMap((tracked) => {
        const value = baseline(this.#sourceId, tracked);
        return value ? [value] : [];
      });
      await this.#context.inbox.restore({
        availability: effectiveAvailability,
        snapshot: baselines,
        ...(effectiveMessage === undefined ? {} : { message: effectiveMessage }),
      });
      this.#baselineReady = true;
    }
    for (const row of rows.values()) {
      const tracked = this.#tracked.get(row.paneId)!;
      if (tracked.row.cursor === row.cursor) continue;
      const result = await tracked.projector.submit(operation(this.#sourceId, row));
      if (!result.accepted && result.reason !== 'duplicate_source' && result.reason !== 'duplicate_event') {
        throw new Error(`${this.#agentId} Inbox projection failed: ${result.reason ?? 'unknown'}`);
      }
      tracked.row = row;
    }
    this.#availability = effectiveAvailability;
    this.#availabilityMessage = effectiveMessage;
    this.#context.health.report({
      capability: 'inbox', availability: effectiveAvailability,
      ...(effectiveMessage === undefined ? {} : { message: effectiveMessage }),
      lastSuccessAt: Date.now(),
    });
  }
}
