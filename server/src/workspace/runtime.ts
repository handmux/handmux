import crypto from 'node:crypto';
import { buildRestorePlan } from './planner.js';
import { executeRestore, type RestoreResult } from './restore.js';
import {
  createOperationManager,
  normalizeRestoreRequest,
  type RestoreOperation,
  type RestoreRequest,
} from './operations.js';
import {
  buildRecoveryMapping,
  type RecoveryMapping,
  type RecoveryMappingAddition,
} from './mapping.js';
import type { createWorkspaceStore, WorkspaceRecovery } from './store.js';
import type {
  WorkspaceCheckpoint,
  WorkspaceSnapshot,
} from './schema.js';

type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
type ExecutorOptions = Parameters<typeof executeRestore>[0];
type ExecutorResult = Awaited<ReturnType<typeof executeRestore>>;
type RuntimeRestoreResult = Omit<ExecutorResult, 'mapping'> & {
  mapping: RecoveryMapping | null;
  warnings?: string[];
};
type MappingKind = keyof RecoveryMappingAddition['runtime'];
type LiveTopology = Pick<WorkspaceSnapshot, 'tmuxVersion' | 'active' | 'sessions' | 'windows'> & {
  status: 'ok' | 'empty';
  error?: unknown;
};
type RuntimeTmux = ExecutorOptions['tmux'] & {
  captureTopology(options?: { readOnly?: boolean }): Promise<LiveTopology | { status: string; error?: unknown }>;
};
interface RuntimeLock {
  tryAcquire(owner: { operationId: string }): Promise<{ release(): Promise<void> } | null>;
  withLock<T>(owner: { operationId: string }, fn: () => T | Promise<T>): Promise<T>;
}
interface ReconcileResult { status: string; [key: string]: unknown }
interface RuntimeCheckpointer {
  start?(): unknown | Promise<unknown>;
  health?(): RuntimeHealth;
  stop(): unknown;
  requestReconcile(): unknown;
  confirmEmpty(): unknown;
  reconcile(cause?: string): Promise<ReconcileResult>;
}
interface RuntimeHealth { status: 'starting' | 'ready' | 'degraded'; detail: string | null }
interface WorkspaceRuntimeOptions {
  store: WorkspaceStore;
  tmux: RuntimeTmux;
  lock: RuntimeLock;
  checkpointer: RuntimeCheckpointer;
  now?: () => number;
  randomUUID?: () => string;
  planner?: typeof buildRestorePlan;
  executor?: typeof executeRestore;
  agents?: ExecutorOptions['agents'];
  access?: ExecutorOptions['access'];
  home?: string;
  restoreGuardAttempts?: number;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function unwrapCheckpoint(result: unknown): { checkpoint: WorkspaceCheckpoint; warnings: string[] } {
  const record = recordOf(result);
  if (record?.status !== 'ok' || !record.value) {
    const detail = typeof record?.error === 'string' ? record.error : `checkpoint is ${String(record?.status || 'unavailable')}`;
    throw new Error(detail);
  }
  const warnings = [record.warning, ...(Array.isArray(record.warnings) ? record.warnings : [])]
    .filter((warning): warning is string => typeof warning === 'string' && Boolean(warning));
  return { checkpoint: record.value as WorkspaceCheckpoint, warnings };
}

async function readCheckpoint(
  store: WorkspaceStore,
  checkpointId: string,
): Promise<{ checkpoint: WorkspaceCheckpoint; warnings: string[] }> {
  return unwrapCheckpoint(checkpointId === 'latest'
    ? await store.readLatestCheckpoint()
    : await store.readCheckpoint(checkpointId));
}

async function readRecovery(
  store: WorkspaceStore,
  checkpointId: string,
  historical: boolean,
): Promise<WorkspaceRecovery | null> {
  const result = await store.readRecovery(checkpointId);
  if (result.status === 'ok') return result.value;
  if (historical && result.status === 'missing') return null;
  throw new Error(result.status === 'corrupt' ? result.error : `recovery state is ${result.status}`);
}

async function captureLive(tmux: RuntimeTmux): Promise<LiveTopology> {
  const live = await tmux.captureTopology({ readOnly: true });
  if (live.status === 'ok') return live as LiveTopology;
  if (live.status === 'empty') return { ...live, sessions: [], windows: [] } as LiveTopology;
  throw new Error(typeof live.error === 'string' ? live.error : 'current tmux topology is unavailable');
}

function blankMapping(): RecoveryMappingAddition {
  return {
    names: {},
    runtime: { sessions: {}, windows: {}, panes: {} },
    logical: { sessions: {}, windows: {}, panes: {} },
  };
}

function mapRuntime(
  mapping: RecoveryMappingAddition,
  kind: MappingKind,
  source: unknown,
  logical: unknown,
  runtime: string,
): void {
  if (typeof source === 'string' && source) mapping.runtime[kind][source] = runtime;
  if (typeof logical === 'string' && logical) mapping.logical[kind][logical] = runtime;
}

function mappingForAlreadyPresent(
  checkpoint: WorkspaceCheckpoint,
  live: LiveTopology,
  results: RestoreResult[],
): RecoveryMappingAddition {
  const mapping = blankMapping();
  const resolved = new Set(results.filter((row) => row.status === 'already-present').map((row) => row.logicalId));
  const liveSessions = new Map(live.sessions.map((session) => [session.id, session]));
  const liveWindows = new Map(live.windows.map((window) => [window.id, window]));
  const sourceWindows = new Map(checkpoint.windows.map((window) => [window.id, window]));
  for (const source of checkpoint.sessions) {
    if (!resolved.has(source.id)) continue;
    const actual = liveSessions.get(source.id);
    if (!actual) continue;
    mapping.names[source.name] = actual.name;
    mapRuntime(mapping, 'sessions', source.runtimeId, source.id, actual.runtimeId);
    for (const link of source.windowLinks) {
      const sourceWindow = sourceWindows.get(link.windowId);
      const actualWindow = liveWindows.get(link.windowId);
      if (!sourceWindow || !actualWindow) continue;
      mapRuntime(mapping, 'windows', sourceWindow.runtimeId, sourceWindow.id, actualWindow.runtimeId);
      const actualPanes = new Map(actualWindow.panes.map((pane) => [pane.id, pane]));
      for (const sourcePane of sourceWindow.panes) {
        const actualPane = actualPanes.get(sourcePane.id);
        if (actualPane) mapRuntime(mapping, 'panes', sourcePane.runtimeId, sourcePane.id, actualPane.runtimeId);
      }
    }
  }
  return mapping;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]));
}

interface RestoreGuard {
  topologyFingerprint: string;
  identities: {
    sessions: string[][];
    windows: string[][];
    panes: string[][];
  };
}

function restoreGuard(live: LiveTopology): RestoreGuard {
  const topology = {
    status: live.status,
    tmuxVersion: live.tmuxVersion || null,
    active: live.active || null,
    sessions: live.sessions || [],
    windows: live.windows || [],
  };
  return {
    topologyFingerprint: crypto.createHash('sha256').update(JSON.stringify(sorted(topology))).digest('hex'),
    identities: {
      sessions: (live.sessions || []).map(({ id, runtimeId, name }) => [id, runtimeId, name]).sort(),
      windows: (live.windows || []).map(({ id, runtimeId, name }) => [id, runtimeId, name]).sort(),
      panes: (live.windows || []).flatMap((window) => (window.panes || []).map(({ id, runtimeId }) => [id, runtimeId])).sort(),
    },
  };
}

function sameRestoreGuard(left: RestoreGuard, right: RestoreGuard): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createWorkspaceRuntime({
  store,
  tmux,
  lock,
  checkpointer,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  planner = buildRestorePlan,
  executor = executeRestore,
  agents,
  access,
  home,
  restoreGuardAttempts = 3,
}: WorkspaceRuntimeOptions) {
  const operations = createOperationManager({
    store,
    now,
    randomUUID,
    tryAcquireOperationLock: (owner) => lock.tryAcquire(owner),
  });
  let startPromise: Promise<[number | undefined, unknown]> | null = null;
  let startupHealth: RuntimeHealth = { status: 'starting', detail: 'workspace-starting' };

  async function resolveOperationRequest(requestInput: unknown = {}): Promise<RestoreRequest> {
    const request = normalizeRestoreRequest(requestInput);
    if (request.checkpointId !== 'latest') return request;
    const { checkpoint } = unwrapCheckpoint(await store.readLatestCheckpoint());
    return { ...request, checkpointId: checkpoint.id };
  }

  async function planRestore(requestInput: unknown = {}) {
    const request = normalizeRestoreRequest(requestInput);
    const { checkpoint, warnings } = await readCheckpoint(store, request.checkpointId);
    const recovery = await readRecovery(store, checkpoint.id, request.historical);
    const live = await captureLive(tmux);
    const plan = planner(checkpoint, live, {
      sessionNames: request.sessions,
      recovery,
      historical: request.historical,
      warnings,
    });
    return { request, checkpoint, recovery, live, plan };
  }

  async function guardedPlanRestore(requestInput: unknown = {}) {
    const request = normalizeRestoreRequest(requestInput);
    const { checkpoint, warnings } = await readCheckpoint(store, request.checkpointId);
    const recovery = await readRecovery(store, checkpoint.id, request.historical);
    let live = await captureLive(tmux);
    for (let attempt = 0; attempt < restoreGuardAttempts; attempt += 1) {
      const plan = planner(checkpoint, live, {
        sessionNames: request.sessions,
        recovery,
        historical: request.historical,
        warnings,
      });
      const before = restoreGuard(live);
      const verified = await captureLive(tmux);
      if (sameRestoreGuard(before, restoreGuard(verified))) {
        return { request, checkpoint, recovery, live: verified, plan };
      }
      live = verified;
    }
    throw new Error(`tmux topology changed during restore planning ${restoreGuardAttempts} times; retry restore`);
  }

  async function getRestorePlan(request: unknown = {}) {
    await start();
    const state = await planRestore(request);
    const serverNow = new Date(now()).toISOString();
    const promptEligible = Boolean(
      !state.request.historical
      && state.recovery
      && state.recovery.resolvedAt === null
      && state.recovery.pendingSessionIds.length > 0
      && Date.parse(state.recovery.expiresAt) > now(),
    );
    return Object.freeze({ ...state.plan, mapping: state.recovery?.mapping || null, serverNow, promptEligible });
  }

  async function getProtectionStatus(): Promise<{
    status: 'protected' | 'unprotected' | 'degraded';
    lastSuccessfulCaptureAt: string | null;
    errorCode: string | null;
  }> {
    let live: Awaited<ReturnType<WorkspaceStore['readLive']>>;
    try {
      live = await store.readLive();
    } catch {
      return { status: 'degraded', lastSuccessfulCaptureAt: null, errorCode: 'live-unavailable' };
    }
    if (live.status === 'ok') {
      return { status: 'protected', lastSuccessfulCaptureAt: live.value.capturedAt || null, errorCode: null };
    }
    if (live.status === 'empty') {
      return { status: 'unprotected', lastSuccessfulCaptureAt: null, errorCode: null };
    }
    return {
      status: 'degraded',
      lastSuccessfulCaptureAt: null,
      errorCode: live.status === 'corrupt' ? 'live-corrupt' : 'live-unavailable',
    };
  }

  async function performRestore(
    operationId: string,
    request: RestoreRequest,
    onProgress: (progress: { completed: number; total: number; result?: unknown }) => Promise<void>,
    onRunning: () => Promise<RestoreOperation>,
    onTerminal: (value: unknown) => Promise<RestoreOperation>,
  ): Promise<RuntimeRestoreResult> {
    let result: RuntimeRestoreResult | undefined;
    let restoreError: unknown;
    try {
      result = await lock.withLock({ operationId }, async () => {
        try {
          await onRunning();
          // The preview may be stale by now. Capture and plan again while holding the writer lock so a name
          // created after preview receives the next non-destructive `-restored` suffix.
          const state = await guardedPlanRestore(request);
          const restored = await executor({
            plan: state.plan,
            checkpoint: state.checkpoint,
            tmux,
            agents,
            onProgress,
            access,
            home,
          });
          const resolvedIds = restored.results
            .filter((row) => row.status === 'restored' || row.status === 'already-present')
            .map((row) => row.logicalId);
          const mapping = buildRecoveryMapping(state.checkpoint.id, state.recovery?.mapping, [
            restored.mapping,
            mappingForAlreadyPresent(state.checkpoint, state.live, restored.results),
          ], now);
          if (mapping && typeof store.mergeRecoveryMapping === 'function') {
            await store.mergeRecoveryMapping(state.checkpoint.id, mapping);
          }
          // Persist migration data before resolving pending ids. If the second write fails, retry planning
          // still sees the session and will recognize it as already-present instead of losing its mapping.
          if (resolvedIds.length > 0) await store.resolveSessions(state.checkpoint.id, resolvedIds);
          const lockedResult: RuntimeRestoreResult = { ...restored, mapping };
          await onTerminal(lockedResult);
          return lockedResult;
        } catch (error) {
          await onTerminal(error);
          throw error;
        }
      });
    } catch (error) {
      restoreError = error;
    }
    let reconcileWarning;
    try {
      const reconciled = await checkpointer.reconcile('restore-complete');
      if (!['written', 'unchanged'].includes(reconciled?.status)) {
        reconcileWarning = `live reconcile ${reconciled?.status || 'unknown'}; workspace protection may be degraded`;
      }
    } catch (error) {
      reconcileWarning = `live reconcile failed: ${errorMessage(error)}`;
    }
    if (restoreError) throw restoreError;
    const completed = result;
    if (!completed) throw new Error('restore completed without a result');
    if (reconcileWarning) {
      result = {
        ...completed,
        warnings: [...(completed.warnings || []), reconcileWarning],
      };
    }
    return result ?? completed;
  }

  async function startOnce(): Promise<[number | undefined, unknown]> {
    let interrupted: number | undefined;
    let sweepError: unknown;
    try {
      interrupted = await operations.interruptOrphans();
    } catch (error) {
      sweepError = error;
    }
    let started: unknown;
    let startError: unknown;
    try {
      started = await checkpointer.start?.();
    } catch (error) {
      startError = error;
    }
    if (sweepError && startError) {
      const sweepMessage = sweepError instanceof Error ? sweepError.message : String(sweepError);
      const startMessage = startError instanceof Error ? startError.message : String(startError);
      throw new AggregateError([sweepError, startError], `${sweepMessage}; workspace protection start failed: ${startMessage}`);
    }
    if (sweepError) throw sweepError;
    if (startError) throw startError;
    return [interrupted, started];
  }

  function start(): Promise<[number | undefined, unknown]> {
    if (!startPromise) {
      startupHealth = { status: 'starting', detail: 'workspace-starting' };
      startPromise = startOnce().then((result) => {
        startupHealth = { status: 'ready', detail: null };
        return result;
      }).catch((error) => {
        startupHealth = { status: 'degraded', detail: 'workspace-start-failed' };
        startPromise = null;
        throw error;
      });
    }
    return startPromise;
  }

  return {
    start,
    health: () => (startupHealth.status === 'ready'
      ? (checkpointer.health?.() || startupHealth)
      : startupHealth),
    stop: () => checkpointer.stop(),
    requestReconcile: () => checkpointer.requestReconcile(),
    confirmEmpty: () => checkpointer.confirmEmpty(),
    listCheckpoints: () => store.listCheckpoints(),
    getProtectionStatus,
    getRestorePlan,
    startRestore: async (request = {}) => operations.start(await resolveOperationRequest(request), ({ operationId, request: normalized, onProgress, onRunning, onTerminal }) => (
      performRestore(operationId, normalized, onProgress, onRunning, onTerminal)
    ), { deferRunning: true }),
    getOperation: (id: string) => operations.get(id),
    restoreNow: async (request = {}) => operations.run(await resolveOperationRequest(request), ({ operationId, request: normalized, onProgress, onRunning, onTerminal }) => (
      performRestore(operationId, normalized, onProgress, onRunning, onTerminal)
    ), { deferRunning: true }),
  };
}
