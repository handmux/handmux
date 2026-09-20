// The generic Hook → LocalAgentBridge → Inbox Connector. Every Agent whose native lifecycle is delivered
// as filesystem Hooks (Claude Code, CodeBuddy) drives the same async pipeline, so the pipeline is written
// ONCE here and the provider supplies only a profile:
//
//   - agentId / label / attachmentPrefix       identity of the records this connector publishes
//   - eventPrefix                              the prefix the shared writer stamps on the spool it reads
//   - acceptsAgent(agent)                      which provider marking a row or spool event may carry
//   - resolvePaneProcess(pane, context)        the pane's provider process (the lease anchor)
//   - matchesAgentPane(pane, foreground)       the legacy-record fallback when no fingerprint was recorded
//   - project({eventId, src, …})               the provider's src+payload → Inbox projection
//   - nativeTail                               OPTIONAL out-of-band reconciliation (Claude only today)
//
// The Connector never blocks the provider: Hook subprocesses only commit files, while this owns socket
// lifetime, per-session replacement, and durable acknowledgements.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LocalConnectorBridgeClient } from './bridgeClient.js';
import {
  HOOK_EVENT_ID_RE,
  canonicalInboxState,
  matchesHookProcess,
  parseHookBridgeEvent,
  readHookStateRows,
} from '../src/agents/hookEvents.js';
import type { AgentHookClassification, HookBridgeEvent } from '../src/agents/hookEvents.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
  ReadonlyPaneSource,
} from '../src/agent-runtime/adapter.js';
import type { AgentAttachmentCandidate } from '../src/agent-runtime/run.js';

export interface HookInboxProjection {
  operation: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export interface HookBridgeProjectionInput {
  eventId?: string;
  src: string;
  sourceOccurredAt?: number;
  payload: Record<string, unknown>;
}

// The out-of-band native state a provider can consult besides its Hook records. Structurally satisfied by
// ClaudeNativeTailReader; a provider without such a source simply omits it.
export interface HookBridgeNativeTail {
  read(
    payload: Record<string, unknown>,
    after: number,
    now: number,
    process: { pid: number; startedAt?: number } | undefined,
    src: string,
  ): {
    status?: 'idle' | 'busy' | 'waiting' | 'unknown';
    settled?: string | null;
    statusEventId?: string;
  };
  retain(sessionIds: ReadonlySet<string>): void;
  clear(): void;
}

export interface HookBridgeProfile {
  agentId: string;
  label: string;
  attachmentPrefix: string;
  // The event-ID prefix the SHARED writer stamps on this Agent's durable spool records. It is NOT always the
  // Agent's own id, and the two must agree: the Inbox coordinator compares the latest-state snapshot's event
  // identity against the spool event's to decide whether a durable edge is this pane's current state or
  // already-superseded history — a mismatch makes every live completion look like history and silently
  // drops its notification. Keep each profile's value in step with server/hooks/handmux-write.cjs.
  eventPrefix: string;
  acceptsAgent(agent: unknown): boolean;
  matchesAgentPane(pane: LivePane, foreground: ForegroundProcessIdentity): boolean;
  project(input: HookBridgeProjectionInput): HookInboxProjection;
  // Providers whose process is NOT the pane's foreground leaf (an ambiguous launcher with transient tool
  // children) must resolve their own anchor row here; the default is the single foreground leaf.
  resolvePaneProcess?(
    pane: LivePane,
    context: ProcessContext,
  ): Promise<ForegroundProcessIdentity | null>;
  nativeTail?: HookBridgeNativeTail;
}

export interface HookBridgeConnectorOptions {
  profile: HookBridgeProfile;
  socketPath: string;
  credentialFile: string;
  stateDirectory: string;
  hookStateFile: string;
  eventDirectory: string;
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  pollMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  // Retention for Hook source files that never get acknowledged (see #pruneSpool).
  spoolMaxFiles?: number;
  spoolRetentionMs?: number;
  logger?: (message: string, error?: unknown) => void;
  createClient?: (options: ConstructorParameters<typeof LocalConnectorBridgeClient>[0]) => LocalConnectorBridgeClient;
}

const DEFAULT_SPOOL_MAX_FILES = 2_000;
const DEFAULT_SPOOL_RETENTION_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

// The provider-neutral Inbox projection: classify a Hook edge, then emit the one ordered operation plus the
// recoverable snapshot that describes the same moment. `null` classification clears the run's Inbox item
// (the pane stays present through process identity); a state with no event ID can never notify.
export function projectHookInbox({
  classify,
  eventId,
  src,
  sourceOccurredAt,
  payload,
}: HookBridgeProjectionInput & {
  classify(src: string, payload: Record<string, unknown>): AgentHookClassification | null | undefined;
}): HookInboxProjection {
  const classified = classify(src, payload);
  const state = classified ? canonicalInboxState(classified.kind) : null;
  const safeEventId = eventId && HOOK_EVENT_ID_RE.test(eventId) ? eventId : undefined;
  const occurred = typeof sourceOccurredAt === 'number' && Number.isFinite(sourceOccurredAt)
    ? sourceOccurredAt : undefined;
  const base = {
    ...(safeEventId === undefined ? {} : { eventId: safeEventId }),
    ...(occurred === undefined ? {} : { sourceOccurredAt: occurred }),
  };
  if (!state) {
    return {
      operation: { kind: 'clear', ...base },
      snapshot: { availability: 'ready' },
    };
  }
  const text = message(classified?.msg);
  const item = {
    state,
    ...(text === undefined ? {} : { message: text }),
    ...((state === 'waiting' || state === 'done' || state === 'error') && safeEventId
      ? { eventId: safeEventId } : {}),
    ...(occurred === undefined ? {} : { sourceOccurredAt: occurred }),
  };
  return {
    operation: {
      kind: 'set',
      ...item,
      ...(state === 'working' && safeEventId ? { eventId: safeEventId } : {}),
    },
    snapshot: { availability: 'ready', current: item },
  };
}

interface TrackedClient {
  signature: string;
  client: LocalConnectorBridgeClient;
}

function optionalSession(payload: Record<string, unknown>, explicit?: string): string | undefined {
  if (typeof explicit === 'string' && explicit.length > 0 && explicit.length <= 1024) return explicit;
  const value = payload.session_id;
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : undefined;
}

// The per-connection identity: a new session, or a new process generation on the same pane, is a different
// bridge client (and a different local state file). The Agent is deliberately absent — each Connector owns
// its own state directory, so including it would only rename every existing Claude client's file.
function signature(
  paneId: string,
  sessionId: string | undefined,
  process: ForegroundProcessIdentity,
): string {
  return JSON.stringify({
    paneId, sessionId, pid: process.pid, startedAt: process.startedAt, tty: process.tty,
  });
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// A gap marker is per pane+session+process generation: confirming it must not swallow the next session's
// gap on the same reused pane.
function gapKey(file: string, event: {
  paneId: string; sessionId?: string; eventId: string;
  process?: { pid: number; startedAt: number; tty: string };
}): string {
  return JSON.stringify({
    marker: path.basename(file),
    paneId: event.paneId,
    sessionId: event.sessionId ?? null,
    process: event.process ?? null,
    eventId: event.eventId,
  });
}

function candidate(
  profile: HookBridgeProfile,
  paneId: string,
  sessionId: string | undefined,
  process: ForegroundProcessIdentity,
): AgentAttachmentCandidate {
  const processRef = {
    pid: process.pid,
    ...(process.startedAt === undefined ? {} : { startedAt: process.startedAt }),
    ...(process.tty === undefined ? {} : { tty: process.tty }),
  };
  return {
    paneId,
    attachmentId: `${profile.attachmentPrefix}:${digest(JSON.stringify({ paneId, process: processRef }))}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    process: processRef,
  };
}

export class HookBridgeConnector {
  readonly #profile: HookBridgeProfile;
  readonly #socketPath: string;
  readonly #credentialFile: string;
  readonly #stateDirectory: string;
  readonly #hookStateFile: string;
  readonly #eventDirectory: string;
  readonly #panes: ReadonlyPaneSource;
  readonly #process: ProcessContext;
  readonly #pollMs: number;
  readonly #spoolMaxFiles: number;
  readonly #spoolRetentionMs: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #logger: NonNullable<HookBridgeConnectorOptions['logger']>;
  readonly #createClient: NonNullable<HookBridgeConnectorOptions['createClient']>;
  readonly #clients = new Map<string, TrackedClient>();
  readonly #confirmedGaps = new Set<string>();
  readonly #pendingAcks = new Map<string, {
    promise: Promise<void>;
    client: LocalConnectorBridgeClient;
    process: ForegroundProcessIdentity;
    sessionId: string | undefined;
  }>();
  #timer: NodeJS.Timeout | undefined;
  #tail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor({
    profile,
    socketPath,
    credentialFile,
    stateDirectory,
    hookStateFile,
    eventDirectory,
    panes,
    process,
    pollMs = 250,
    retryDelayMs = 100,
    maxRetryDelayMs = 5_000,
    logger = () => {},
    createClient = (options) => new LocalConnectorBridgeClient(options),
    spoolMaxFiles = DEFAULT_SPOOL_MAX_FILES,
    spoolRetentionMs = DEFAULT_SPOOL_RETENTION_MS,
  }: HookBridgeConnectorOptions) {
    if (!profile || !profile.agentId || !profile.attachmentPrefix
      || ![socketPath, credentialFile, stateDirectory, hookStateFile, eventDirectory].every(path.isAbsolute)
      || !panes || !process || !Number.isSafeInteger(pollMs) || pollMs < 50
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0
      || !Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs
      || !Number.isSafeInteger(spoolMaxFiles) || spoolMaxFiles <= 0
      || !Number.isSafeInteger(spoolRetentionMs) || spoolRetentionMs <= 0) {
      throw new TypeError(`${profile?.label ?? 'Hook'} Hook Bridge Connector requires private paths and Runtime identity sources`);
    }
    this.#profile = profile;
    this.#socketPath = socketPath;
    this.#credentialFile = credentialFile;
    this.#stateDirectory = stateDirectory;
    this.#hookStateFile = hookStateFile;
    this.#eventDirectory = eventDirectory;
    this.#panes = panes;
    this.#process = process;
    this.#pollMs = pollMs;
    this.#retryDelayMs = retryDelayMs;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#spoolMaxFiles = spoolMaxFiles;
    this.#spoolRetentionMs = spoolRetentionMs;
    this.#logger = logger;
    this.#createClient = createClient;
  }

  start(): void {
    if (this.#closed) throw new Error(`${this.#profile.label} Hook Bridge Connector is closed`);
    if (this.#started) return;
    this.#started = true;
    this.#poll();
  }

  reconcile(): Promise<void> {
    const pending = this.#tail.then(() => this.#reconcile());
    this.#tail = pending.catch((error) => {
      this.#logger(`${this.#profile.label} Hook Bridge reconciliation failed`, error);
    });
    return pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#profile.nativeTail?.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const tracked of this.#clients.values()) tracked.client.close();
    this.#clients.clear();
    await this.#tail.catch(() => {});
    for (const tracked of this.#clients.values()) tracked.client.close();
    this.#clients.clear();
    await Promise.allSettled([...this.#pendingAcks.values()].map((pending) => pending.promise));
  }

  #poll(): void {
    if (this.#closed) return;
    void this.reconcile().catch(() => {}).finally(() => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => this.#poll(), this.#pollMs);
      this.#timer.unref?.();
    });
  }

  #eventFiles(): string[] {
    try {
      return fs.readdirSync(this.#eventDirectory)
        .filter((name) => /^(event-\d+-\d+|gap-[a-f0-9]+)\.json$/.test(name))
        .sort((first, second) => {
          const firstGap = first.startsWith('gap-');
          const secondGap = second.startsWith('gap-');
          return firstGap === secondGap ? first.localeCompare(second) : firstGap ? -1 : 1;
        })
        .map((name) => path.join(this.#eventDirectory, name));
    } catch { return []; }
  }

  // Retention for Hook source files that never reach an acknowledgement: a pane that is gone, a client
  // that never drains, or a durable publish that keeps failing leaves its file behind, and every poll
  // re-reads it — an observed 170k files over nine days. Files are listed oldest-first, so a cap drops
  // the stuck ones and an age window only ever expires files no one is waiting on. `gap-*` markers are
  // not touched: they are bounded by pane/session and carry a degradation signal until confirmed.
  #pruneSpool(files: string[]): string[] {
    const events = files.filter((file) => path.basename(file).startsWith('event-'));
    if (events.length === 0) return files;
    const now = Date.now();
    const dropped = new Set<string>();
    for (const [index, file] of events.entries()) {
      const beyondCap = this.#spoolMaxFiles > 0 && index < events.length - this.#spoolMaxFiles;
      let expired = false;
      try { expired = now - fs.statSync(file).mtimeMs > this.#spoolRetentionMs; } catch { /* removed */ }
      if (beyondCap || expired) dropped.add(file);
    }
    if (dropped.size === 0) return files;
    for (const file of dropped) { try { fs.unlinkSync(file); } catch { /* concurrently removed */ } }
    this.#logger?.(
      `Dropped ${this.#profile.label} Hook source files that could not be delivered`,
      { dropped: dropped.size, remaining: events.length - dropped.size },
    );
    return files.filter((file) => !dropped.has(file));
  }

  // The pane's provider process — the lease anchor the Connector publishes and the identity every recorded
  // Hook edge must belong to. Profiles that prove a non-leaf anchor override it; the rest use the leaf.
  #inspectPane(pane: LivePane): Promise<ForegroundProcessIdentity | null> {
    return this.#profile.resolvePaneProcess
      ? this.#profile.resolvePaneProcess(pane, this.#process)
      : this.#process.inspectForeground(pane);
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    const profile = this.#profile;
    let panes: readonly LivePane[];
    try { panes = await this.#panes.list(); } catch { return; }
    const paneMap = new Map(panes.map((pane) => [pane.paneId, pane]));
    const identities = new Map<string, Promise<ForegroundProcessIdentity | null>>();
    const identity = (pane: LivePane): Promise<ForegroundProcessIdentity | null> => {
      let pending = identities.get(pane.paneId);
      if (!pending) {
        pending = this.#inspectPane(pane);
        identities.set(pane.paneId, pending);
      }
      return pending;
    };

    const events: Array<{ file: string; event: HookBridgeEvent }> = [];
    for (const eventFile of this.#pruneSpool(this.#eventFiles())) {
      let event: HookBridgeEvent | null = null;
      try {
        const stat = fs.lstatSync(eventFile);
        if (stat.isFile()) {
          event = parseHookBridgeEvent(
            JSON.parse(fs.readFileSync(eventFile, 'utf8')) as unknown,
            (agent) => profile.acceptsAgent(agent),
          );
        }
      } catch { /* partial/removed file */ }
      if (event) events.push({ file: eventFile, event });
    }

    const state = readHookStateRows(this.#hookStateFile, (agent) => profile.acceptsAgent(agent));
    for (const [paneId, pending] of this.#pendingAcks) {
      const pane = paneMap.get(paneId);
      const foreground = pane ? await identity(pane) : null;
      const latest = state.get(paneId);
      const latestSession = latest ? optionalSession(latest.payload) : undefined;
      const replacedSession = foreground && latest?.process && matchesHookProcess(latest.process, foreground)
        && latestSession && pending.sessionId && latestSession !== pending.sessionId;
      if (replacedSession || !pane || (foreground && (foreground.pid !== pending.process.pid
        || (foreground.startedAt !== undefined && pending.process.startedAt !== undefined
          && foreground.startedAt !== pending.process.startedAt)
        || (foreground.tty !== undefined && pending.process.tty !== undefined
          && foreground.tty !== pending.process.tty)))) pending.client.close();
    }

    const gaps = new Map<string, { event: HookBridgeEvent; key: string }>();
    const activeGapKeys = new Set(events.flatMap(({ file, event }) => (
      event.type === 'gap' ? [gapKey(file, event)] : []
    )));
    for (const key of this.#confirmedGaps) {
      if (!activeGapKeys.has(key)) this.#confirmedGaps.delete(key);
    }
    for (const { file: eventFile, event } of events) {
      if (event.type !== 'gap') continue;
      const pane = paneMap.get(event.paneId);
      const foreground = pane ? await identity(pane) : null;
      if (!pane || !foreground) continue;
      if (!event.process && !profile.matchesAgentPane(pane, foreground)) continue;
      if (!matchesHookProcess(event.process, foreground)) {
        this.#logger(`Discarding stale ${profile.label} Hook event after pane process replacement`, {
          eventId: event.eventId,
          paneId: event.paneId,
        });
        try { fs.unlinkSync(eventFile); } catch { /* concurrently removed */ }
        continue;
      }
      const latest = state.get(event.paneId);
      const latestSession = latest ? optionalSession(latest.payload) : undefined;
      const gapSession = optionalSession(event.payload ?? {}, event.sessionId);
      if (latestSession && gapSession && latestSession !== gapSession) {
        try { fs.unlinkSync(eventFile); } catch { /* replaced session already retired the gap */ }
        continue;
      }
      gaps.set(event.paneId, { event, key: gapKey(eventFile, event) });
    }

    const currentStatePanes = new Set<string>();
    const currentNativeSessions = new Set<string>();
    const persistedSnapshots = new Map<string, boolean>();
    for (const [paneId, row] of state) {
      const pane = paneMap.get(paneId);
      const foreground = pane ? await identity(pane) : null;
      if (!pane || !foreground) continue;
      if (!row.process && !profile.matchesAgentPane(pane, foreground)) continue;
      if (!matchesHookProcess(row.process, foreground)) continue;
      currentStatePanes.add(paneId);
      // A cancelled old-session ACK settles asynchronously; switch clients once it has released the pane.
      const sessionId = optionalSession(row.payload);
      if (sessionId && row.src !== 'end') currentNativeSessions.add(sessionId);
      const pending = this.#pendingAcks.get(paneId);
      if (pending && pending.sessionId !== sessionId) continue;
      const eventId = row.sequence === undefined ? undefined : `${profile.eventPrefix}-${row.sequence}`;
      const projection = profile.project({
        ...(eventId === undefined ? {} : { eventId }),
        src: row.src,
        sourceOccurredAt: row.ts,
        payload: row.payload,
      });
      if (row.src !== 'end') {
        const native = profile.nativeTail?.read(row.payload, row.ts, Date.now(), row.process, row.src);
        if (native?.settled) projection.snapshot = { availability: 'ready' };
        else if (native?.status === 'busy' || native?.status === 'waiting') {
          projection.snapshot = { availability: 'ready', current: {
            state: native.status === 'busy' ? 'working' : 'waiting',
            eventId: native.statusEventId,
          } };
        } else if (native?.status === 'unknown') projection.snapshot = { availability: 'unavailable' };
      }
      const snapshot = gaps.has(paneId) && projection.snapshot.availability !== 'unavailable' ? {
        ...projection.snapshot,
        availability: 'degraded',
        message: `${profile.label} Hook event history is incomplete`,
      } : projection.snapshot;
      persistedSnapshots.set(
        paneId,
        this.#client(paneId, sessionId, foreground).setSnapshot('inbox', {
          ...snapshot,
          ...(row.process && row.sequence !== undefined ? { sourceSequence: row.sequence } : {}),
        }),
      );
    }

    profile.nativeTail?.retain(currentNativeSessions);

    const liveAgentPanes = new Set(currentStatePanes);
    for (const pane of panes) {
      if (currentStatePanes.has(pane.paneId)) continue;
      const foreground = await identity(pane);
      if (!foreground || !profile.matchesAgentPane(pane, foreground)) continue;
      liveAgentPanes.add(pane.paneId);
      if (this.#pendingAcks.has(pane.paneId)) continue;
      const gap = gaps.get(pane.paneId)?.event;
      const sessionId = gap ? optionalSession(gap.payload ?? {}, gap.sessionId) : undefined;
      persistedSnapshots.set(
        pane.paneId,
        this.#client(pane.paneId, sessionId, foreground).setSnapshot('inbox', gap ? {
          availability: 'degraded',
          message: `${profile.label} Hook event history is incomplete`,
        } : { availability: 'ready' }),
      );
    }

    for (const { file: eventFile, event } of events) {
      const gap = event.type === 'gap' ? gaps.get(event.paneId) : undefined;
      if (event.type === 'gap' && gap?.event !== event) continue;
      const pane = paneMap.get(event.paneId);
      const foreground = pane ? await identity(pane) : null;
      if (!pane || !foreground) continue;
      if (!event.process && !profile.matchesAgentPane(pane, foreground)) continue;
      // A disconnected/rejected pane must not suspend the shared poller or another pane's events.
      // Keep one acknowledgement in flight per pane to retain its lifecycle ordering.
      if (this.#pendingAcks.has(event.paneId)) continue;
      if (!matchesHookProcess(event.process, foreground)) {
        this.#logger(`Discarding stale ${profile.label} Hook event after pane process replacement`, {
          eventId: event.eventId,
          paneId: event.paneId,
        });
        try { fs.unlinkSync(eventFile); } catch { /* concurrently removed */ }
        continue;
      }
      const payload = event.payload ?? {};
      const sessionId = optionalSession(payload, event.sessionId);
      const latest = state.get(event.paneId);
      const latestSession = latest ? optionalSession(latest.payload) : undefined;
      // A current pane session must never be replaced just to replay another session's old queue.
      // Retain that session's source and original durable payload for a legitimate future resume.
      if (latest?.process && matchesHookProcess(latest.process, foreground)
        && latestSession && sessionId && latestSession !== sessionId) continue;
      const client = this.#client(event.paneId, sessionId, foreground);
      if (event.type === 'gap' && persistedSnapshots.get(event.paneId) !== true) continue;
      if (event.type === 'gap' && gap && this.#confirmedGaps.has(gap.key)) continue;
      const projection = event.type === 'gap' ? {
        operation: { kind: 'gap', eventId: event.eventId },
      } : profile.project({
          eventId: event.eventId,
          src: event.src ?? '',
          ...(event.sourceOccurredAt === undefined ? {} : {
            sourceOccurredAt: event.sourceOccurredAt,
          }),
          payload,
        });
      const operation: Record<string, unknown> = projection.operation;
      const restoredAck = client.resumePersistedDurable('inbox', event.eventId);
      if (!restoredAck && !client.publishDurable('inbox', event.eventId, operation)) {
        this.#logger(`${profile.label} Hook event remains queued because Connector durable state could not be persisted`, {
          eventId: event.eventId,
          paneId: event.paneId,
        });
        continue;
      }
      const pending = (restoredAck ?? client.waitForDurableAck('inbox', event.eventId)).then(() => {
        if (event.type === 'gap' && gap) this.#confirmedGaps.add(gap.key);
        else fs.unlinkSync(eventFile);
      }).catch((error: unknown) => {
        if (!this.#closed) {
          this.#logger(`${profile.label} Hook acknowledgement interrupted; source event remains queued`, error);
        }
      }).finally(() => { this.#pendingAcks.delete(event.paneId); });
      this.#pendingAcks.set(event.paneId, { promise: pending, client, process: foreground, sessionId });
    }

    for (const [paneId, tracked] of [...this.#clients]) {
      if (liveAgentPanes.has(paneId)) continue;
      tracked.client.close();
      this.#clients.delete(paneId);
    }
  }

  #client(
    paneId: string,
    sessionId: string | undefined,
    foreground: ForegroundProcessIdentity,
  ): LocalConnectorBridgeClient {
    const profile = this.#profile;
    const nextSignature = signature(paneId, sessionId, foreground);
    const current = this.#clients.get(paneId);
    if (current?.signature === nextSignature) return current.client;
    current?.client.close();
    const stateFile = path.join(this.#stateDirectory, `${digest(nextSignature)}.json`);
    const client = this.#createClient({
      adapterId: profile.agentId,
      snapshotBeforeDurable: true,
      socketPath: this.#socketPath,
      credentialFile: this.#credentialFile,
      stateFile,
      candidate: candidate(profile, paneId, sessionId, foreground),
      generation: { id: `${profile.agentId}-session:${digest(sessionId ?? nextSignature)}`, replace: true },
      retryDelayMs: this.#retryDelayMs,
      maxRetryDelayMs: this.#maxRetryDelayMs,
      logger: this.#logger,
    });
    this.#clients.set(paneId, { signature: nextSignature, client });
    client.start();
    return client;
  }
}
