import { createHash } from 'node:crypto';
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
import type { AgentAttachmentCandidate, AgentRunLease } from '../agent-runtime/run.js';

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
  attachmentId: string;
  row: NativeInboxRow;
}

function attachmentId(sourceId: string, candidate: Omit<AgentAttachmentCandidate, 'attachmentId'>): string {
  return `${sourceId}:${createHash('sha256').update(JSON.stringify({
    paneId: candidate.paneId, process: candidate.process,
  })).digest('hex')}`;
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
    const tracked = [...this.#tracked.values()];
    this.#tracked.clear();
    await Promise.all(tracked.map((entry) => (
      this.#context.runControl.revoke(entry.lease, 'adapter_stopped').catch(() => {})
    )));
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
    // entry must not outlive that lease: retaining it makes this loop skip re-attach forever, then feeds a
    // revoked run into Inbox.restore() and blocks every healthy pane in the same provider snapshot.
    for (const [paneId, tracked] of [...this.#tracked]) {
      if (!tracked.lease.signal.aborted
        && this.#context.runs.resolve(tracked.lease.ref) === tracked.lease) continue;
      this.#tracked.delete(paneId);
      topologyChanged = true;
    }
    for (const [paneId, tracked] of [...this.#tracked]) {
      if (rows.has(paneId)) continue;
      this.#tracked.delete(paneId);
      await this.#context.runControl.revoke(tracked.lease, 'adapter_stopped').catch(() => {});
      topologyChanged = true;
    }

    let attachmentError: string | undefined;
    for (const row of rows.values()) {
      try {
        const pane = paneMap.get(row.paneId)!;
        const process = await this.#context.process.inspectForeground(pane);
        if (!process) throw new Error(`${this.#agentId} foreground process is unavailable`);
        const candidateBase = {
          paneId: row.paneId,
          ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
          process: {
            pid: process.pid,
            ...(process.startedAt === undefined ? {} : { startedAt: process.startedAt }),
            ...(process.tty === undefined ? (pane.tty === undefined ? {} : { tty: pane.tty }) : { tty: process.tty }),
          },
        };
        const nextAttachmentId = attachmentId(this.#sourceId, candidateBase);
        const candidate: AgentAttachmentCandidate = { ...candidateBase, attachmentId: nextAttachmentId };
        let tracked = this.#tracked.get(row.paneId);
        if (!tracked) {
          const lease = await this.#context.runControl.attach(candidate);
          tracked = {
            lease, projector: this.#context.inbox.forRun(lease),
            attachmentId: nextAttachmentId, row,
          };
          this.#tracked.set(row.paneId, tracked);
          topologyChanged = true;
        } else if (tracked.attachmentId !== nextAttachmentId) {
          const lease = await this.#context.runControl.attach(candidate);
          tracked = {
            lease, projector: this.#context.inbox.forRun(lease),
            attachmentId: nextAttachmentId, row,
          };
          this.#tracked.set(row.paneId, tracked);
          topologyChanged = true;
        } else if (tracked.lease.ref.sessionId !== undefined && row.sessionId !== undefined
          && tracked.lease.ref.sessionId !== row.sessionId) {
          const lease = await this.#context.runControl.replace(tracked.lease, candidate, 'session_replaced');
          tracked = {
            lease, projector: this.#context.inbox.forRun(lease),
            attachmentId: nextAttachmentId, row,
          };
          this.#tracked.set(row.paneId, tracked);
          topologyChanged = true;
        } else if (tracked.lease.ref.sessionId === undefined && row.sessionId !== undefined) {
          await this.#context.runControl.associateSession(tracked.lease, row.sessionId);
          topologyChanged = true;
        }
      } catch (error) {
        // One transient/invalid pane must not suppress every other pane from the same provider. Keep any
        // previously verified row, exclude only the failed newcomer from this cycle, and retry next poll.
        rows.delete(row.paneId);
        attachmentError ??= error instanceof Error ? error.message : String(error);
      }
    }

    const effectiveAvailability = attachmentError ? 'degraded' : snapshot.availability;
    const effectiveMessage = attachmentError ?? snapshot.message;
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
