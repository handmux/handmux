import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyClaude } from '../../src/agents/claude.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
  ReadonlyPaneSource,
} from '../../src/agent-runtime/adapter.js';
import type { AgentAttachmentCandidate } from '../../src/agent-runtime/run.js';
import { LocalConnectorBridgeClient } from '../bridgeClient.js';

interface ClaudeHookEvent {
  version: 1;
  type: 'event' | 'gap';
  agent?: 'claude';
  eventId: string;
  sequence?: number;
  paneId: string;
  src?: string;
  sessionId?: string;
  sourceOccurredAt?: number;
  process?: ClaudeHookProcessFingerprint;
  payload?: Record<string, unknown>;
}

interface ClaudeHookProcessFingerprint {
  pid: number;
  startedAt: number;
  tty: string;
}

interface ClaudeHookStateRow {
  ts: number;
  src: string;
  agent?: 'claude';
  sequence?: number;
  process?: ClaudeHookProcessFingerprint;
  payload: Record<string, unknown>;
}

interface InboxProjection {
  operation: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

interface TrackedClient {
  signature: string;
  client: LocalConnectorBridgeClient;
}

export interface ClaudeHookBridgeConnectorOptions {
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
  logger?: (message: string, error?: unknown) => void;
  createClient?: (options: ConstructorParameters<typeof LocalConnectorBridgeClient>[0]) => LocalConnectorBridgeClient;
}

const EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseProcessFingerprint(value: unknown): ClaudeHookProcessFingerprint | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
    || value.startedAt < 0 || !bounded(value.tty, 1024)) return null;
  return {
    pid: Number(value.pid),
    startedAt: value.startedAt,
    tty: value.tty,
  };
}

function normalizedTty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/dev/') ? value : `/dev/${value}`;
}

function matchesSourceProcess(
  source: ClaudeHookProcessFingerprint | undefined,
  current: ForegroundProcessIdentity,
): boolean {
  if (!source) return true; // additive field: accept records produced by an older installed Hook
  return source.pid === current.pid
    && source.startedAt === current.startedAt
    && normalizedTty(source.tty) === normalizedTty(current.tty);
}

function optionalSession(payload: Record<string, unknown>, explicit?: string): string | undefined {
  if (bounded(explicit, 1024)) return explicit;
  return bounded(payload.session_id, 1024) ? payload.session_id : undefined;
}

function message(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function canonicalState(kind: string): 'working' | 'waiting' | 'done' | 'error' | null {
  if (kind === 'working' || kind === 'compacting') return 'working';
  if (kind === 'permission') return 'waiting';
  if (kind === 'done') return 'done';
  if (kind === 'error') return 'error';
  return null;
}

export function projectClaudeHookInbox({
  eventId,
  src,
  sourceOccurredAt,
  payload,
}: {
  eventId?: string;
  src: string;
  sourceOccurredAt?: number;
  payload: Record<string, unknown>;
}): InboxProjection {
  const classified = classifyClaude(src, payload);
  const state = classified ? canonicalState(classified.kind) : null;
  const safeEventId = eventId && EVENT_ID_RE.test(eventId) ? eventId : undefined;
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

function parseEvent(value: unknown): ClaudeHookEvent | null {
  if (!isRecord(value) || value.version !== 1 || (value.type !== 'event' && value.type !== 'gap')
    || (value.agent !== undefined && value.agent !== 'claude')
    || !bounded(value.eventId, 256) || !EVENT_ID_RE.test(value.eventId)
    || !bounded(value.paneId, 256)
    || (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0))
    || (value.src !== undefined && !bounded(value.src, 64))
    || (value.sessionId !== undefined && !bounded(value.sessionId, 1024))
    || (value.sourceOccurredAt !== undefined
      && (typeof value.sourceOccurredAt !== 'number' || !Number.isFinite(value.sourceOccurredAt)))
    || (value.process !== undefined && parseProcessFingerprint(value.process) === null)
    || (value.payload !== undefined && !isRecord(value.payload))) return null;
  return {
    ...value,
    ...(value.process === undefined ? {} : { process: parseProcessFingerprint(value.process)! }),
  } as unknown as ClaudeHookEvent;
}

function readHookState(file: string): Map<string, ClaudeHookStateRow> {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(value)) return new Map();
    return new Map(Object.entries(value).flatMap(([paneId, raw]) => {
      const row = isRecord(raw) ? raw : null;
      const payload = isRecord(row?.payload) ? row.payload : null;
      if (!bounded(paneId, 256) || !row || !payload || !bounded(row.src, 64)
        || (row.agent !== undefined && row.agent !== 'claude')) return [];
      const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : 0;
      const sequence = Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0
        ? Number(row.sequence) : undefined;
      const process = row.process === undefined ? undefined : parseProcessFingerprint(row.process);
      if (process === null) return [];
      return [[paneId, {
        ts,
        src: row.src,
        ...(row.agent === 'claude' ? { agent: 'claude' as const } : {}),
        payload,
        ...(sequence === undefined ? {} : { sequence }),
        ...(process === undefined ? {} : { process }),
      } satisfies ClaudeHookStateRow]];
    }));
  } catch { return new Map(); }
}

function signature(paneId: string, sessionId: string | undefined, process: ForegroundProcessIdentity): string {
  return JSON.stringify({ paneId, sessionId, pid: process.pid, startedAt: process.startedAt, tty: process.tty });
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gapKey(file: string, event: ClaudeHookEvent): string {
  return JSON.stringify({
    marker: path.basename(file),
    paneId: event.paneId,
    sessionId: event.sessionId ?? null,
    process: event.process ?? null,
    eventId: event.eventId,
  });
}

function candidate(
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
    attachmentId: `claude-hook:${digest(JSON.stringify({ paneId, process: processRef }))}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    process: processRef,
  };
}

function looksLikeClaude(pane: LivePane, foreground: ForegroundProcessIdentity): boolean {
  if (pane.currentCommand === 'claude') return true;
  if (!/^\d+[._]\d+[._]\d+$/.test(pane.currentCommand)) return false;
  return typeof foreground.executable === 'string' && /claude/.test(foreground.executable);
}

// Bridges the existing async Claude Hooks without ever blocking Claude itself. Hook subprocesses only
// commit files; this coordinator owns socket lifetime, per-session replacement and durable acknowledgements.
export class ClaudeHookBridgeConnector {
  readonly #socketPath: string;
  readonly #credentialFile: string;
  readonly #stateDirectory: string;
  readonly #hookStateFile: string;
  readonly #eventDirectory: string;
  readonly #panes: ReadonlyPaneSource;
  readonly #process: ProcessContext;
  readonly #pollMs: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #logger: NonNullable<ClaudeHookBridgeConnectorOptions['logger']>;
  readonly #createClient: NonNullable<ClaudeHookBridgeConnectorOptions['createClient']>;
  readonly #clients = new Map<string, TrackedClient>();
  readonly #confirmedGaps = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #tail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor({
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
  }: ClaudeHookBridgeConnectorOptions) {
    if (![socketPath, credentialFile, stateDirectory, hookStateFile, eventDirectory].every(path.isAbsolute)
      || !panes || !process || !Number.isSafeInteger(pollMs) || pollMs < 50
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0
      || !Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs) {
      throw new TypeError('Claude Hook Bridge Connector requires private paths and Runtime identity sources');
    }
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
    this.#logger = logger;
    this.#createClient = createClient;
  }

  start(): void {
    if (this.#closed) throw new Error('Claude Hook Bridge Connector is closed');
    if (this.#started) return;
    this.#started = true;
    this.#poll();
  }

  reconcile(): Promise<void> {
    const pending = this.#tail.then(() => this.#reconcile());
    this.#tail = pending.catch((error) => {
      this.#logger('Claude Hook Bridge reconciliation failed', error);
    });
    return pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const tracked of this.#clients.values()) tracked.client.close();
    this.#clients.clear();
    await this.#tail.catch(() => {});
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

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    let panes: readonly LivePane[];
    try { panes = await this.#panes.list(); } catch { return; }
    const paneMap = new Map(panes.map((pane) => [pane.paneId, pane]));
    const identities = new Map<string, Promise<ForegroundProcessIdentity | null>>();
    const identity = (pane: LivePane): Promise<ForegroundProcessIdentity | null> => {
      let pending = identities.get(pane.paneId);
      if (!pending) {
        pending = this.#process.inspectForeground(pane);
        identities.set(pane.paneId, pending);
      }
      return pending;
    };

    const events: Array<{ file: string; event: ClaudeHookEvent }> = [];
    for (const eventFile of this.#eventFiles()) {
      let event: ClaudeHookEvent | null = null;
      try {
        const stat = fs.lstatSync(eventFile);
        if (stat.isFile()) event = parseEvent(JSON.parse(fs.readFileSync(eventFile, 'utf8')) as unknown);
      } catch { /* partial/removed file */ }
      if (event) events.push({ file: eventFile, event });
    }

    const state = readHookState(this.#hookStateFile);
    const gaps = new Map<string, { event: ClaudeHookEvent; key: string }>();
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
      if (!matchesSourceProcess(event.process, foreground)) {
        this.#logger('Discarding stale Claude Hook event after pane process replacement', {
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
    const persistedSnapshots = new Map<string, boolean>();
    for (const [paneId, row] of state) {
      const pane = paneMap.get(paneId);
      const foreground = pane ? await identity(pane) : null;
      if (!pane || !foreground) continue;
      if (!matchesSourceProcess(row.process, foreground)) continue;
      currentStatePanes.add(paneId);
      const sessionId = optionalSession(row.payload);
      const eventId = row.sequence === undefined ? undefined : `claude-hook-${row.sequence}`;
      const projection = projectClaudeHookInbox({
        ...(eventId === undefined ? {} : { eventId }),
        src: row.src,
        sourceOccurredAt: row.ts,
        payload: row.payload,
      });
      const snapshot = gaps.has(paneId) ? {
        ...projection.snapshot,
        availability: 'degraded',
        message: 'Claude Hook event history is incomplete',
      } : projection.snapshot;
      persistedSnapshots.set(
        paneId,
        this.#client(paneId, sessionId, foreground).setSnapshot('inbox', snapshot),
      );
    }

    const liveClaudePanes = new Set(currentStatePanes);
    for (const pane of panes) {
      if (currentStatePanes.has(pane.paneId)) continue;
      const foreground = await identity(pane);
      if (!foreground || !looksLikeClaude(pane, foreground)) continue;
      liveClaudePanes.add(pane.paneId);
      const gap = gaps.get(pane.paneId)?.event;
      const sessionId = gap ? optionalSession(gap.payload ?? {}, gap.sessionId) : undefined;
      persistedSnapshots.set(
        pane.paneId,
        this.#client(pane.paneId, sessionId, foreground).setSnapshot('inbox', gap ? {
          availability: 'degraded',
          message: 'Claude Hook event history is incomplete',
        } : { availability: 'ready' }),
      );
    }

    for (const { file: eventFile, event } of events) {
      const gap = event.type === 'gap' ? gaps.get(event.paneId) : undefined;
      if (event.type === 'gap' && gap?.event !== event) continue;
      const pane = paneMap.get(event.paneId);
      const foreground = pane ? await identity(pane) : null;
      if (!pane || !foreground) continue;
      if (!matchesSourceProcess(event.process, foreground)) {
        this.#logger('Discarding stale Claude Hook event after pane process replacement', {
          eventId: event.eventId,
          paneId: event.paneId,
        });
        try { fs.unlinkSync(eventFile); } catch { /* concurrently removed */ }
        continue;
      }
      const payload = event.payload ?? {};
      const sessionId = optionalSession(payload, event.sessionId);
      const client = this.#client(event.paneId, sessionId, foreground);
      if (event.type === 'gap' && persistedSnapshots.get(event.paneId) !== true) continue;
      if (event.type === 'gap' && gap && this.#confirmedGaps.has(gap.key)) continue;
      const projection = event.type === 'gap' ? {
        operation: { kind: 'gap', eventId: event.eventId },
      } : projectClaudeHookInbox({
          eventId: event.eventId,
          src: event.src ?? '',
          ...(event.sourceOccurredAt === undefined ? {} : {
            sourceOccurredAt: event.sourceOccurredAt,
          }),
          payload,
        });
      let operation: Record<string, unknown> = projection.operation;
      const latest = state.get(event.paneId);
      const latestSession = latest ? optionalSession(latest.payload) : undefined;
      if (event.type === 'event' && operation.kind === 'set' && operation.state === 'waiting'
        && event.sequence !== undefined && latest?.sequence !== undefined
        && latest.sequence > event.sequence && latestSession === sessionId) {
        operation = {
          kind: 'superseded',
          eventId: event.eventId,
          ...(event.sourceOccurredAt === undefined ? {} : { sourceOccurredAt: event.sourceOccurredAt }),
        };
      }
      if (!client.publishDurable('inbox', event.eventId, operation)) {
        this.#logger('Claude Hook event remains queued because Connector durable state could not be persisted', {
          eventId: event.eventId,
          paneId: event.paneId,
        });
        continue;
      }
      try {
        await client.waitForDurableAck('inbox', event.eventId);
        if (event.type === 'gap' && gap) this.#confirmedGaps.add(gap.key);
        else fs.unlinkSync(eventFile);
      } catch (error) {
        if (!this.#closed) throw error;
        return;
      }
    }

    for (const [paneId, tracked] of [...this.#clients]) {
      if (liveClaudePanes.has(paneId)) continue;
      tracked.client.close();
      this.#clients.delete(paneId);
    }
  }

  #client(
    paneId: string,
    sessionId: string | undefined,
    foreground: ForegroundProcessIdentity,
  ): LocalConnectorBridgeClient {
    const nextSignature = signature(paneId, sessionId, foreground);
    const current = this.#clients.get(paneId);
    if (current?.signature === nextSignature) return current.client;
    current?.client.close();
    const stateFile = path.join(this.#stateDirectory, `${digest(nextSignature)}.json`);
    const client = this.#createClient({
      adapterId: 'claude',
      socketPath: this.#socketPath,
      credentialFile: this.#credentialFile,
      stateFile,
      candidate: candidate(paneId, sessionId, foreground),
      generation: { id: `claude-session:${digest(sessionId ?? nextSignature)}`, replace: true },
      retryDelayMs: this.#retryDelayMs,
      maxRetryDelayMs: this.#maxRetryDelayMs,
      logger: this.#logger,
    });
    this.#clients.set(paneId, { signature: nextSignature, client });
    client.start();
    return client;
  }
}
