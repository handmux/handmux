import crypto from 'node:crypto';
import { buildRestorePlan } from './planner.js';
import { executeRestore } from './restore.js';
import { createOperationManager, normalizeRestoreRequest } from './operations.js';

function unwrapCheckpoint(result) {
  if (result?.status !== 'ok' || !result.value) {
    throw new Error(result?.error || `checkpoint is ${result?.status || 'unavailable'}`);
  }
  return { checkpoint: result.value, warnings: [result.warning, ...(result.warnings || [])].filter(Boolean) };
}

async function readCheckpoint(store, checkpointId) {
  return unwrapCheckpoint(checkpointId === 'latest'
    ? await store.readLatestCheckpoint()
    : await store.readCheckpoint(checkpointId));
}

async function readRecovery(store, checkpointId, historical) {
  const result = await store.readRecovery(checkpointId);
  if (result.status === 'ok') return result.value;
  if (historical && result.status === 'missing') return null;
  throw new Error(result.error || `recovery state is ${result.status}`);
}

async function captureLive(tmux) {
  const live = await tmux.captureTopology();
  if (live?.status === 'ok') return live;
  if (live?.status === 'empty') return { ...live, sessions: [], windows: [] };
  throw new Error(live?.error || 'current tmux topology is unavailable');
}

function blankMapping() {
  return {
    names: {},
    runtime: { sessions: {}, windows: {}, panes: {} },
    logical: { sessions: {}, windows: {}, panes: {} },
  };
}

function mappingPayload(mapping) {
  return {
    names: { ...(mapping?.names || {}) },
    runtime: {
      sessions: { ...(mapping?.runtime?.sessions || {}) },
      windows: { ...(mapping?.runtime?.windows || {}) },
      panes: { ...(mapping?.runtime?.panes || {}) },
    },
    logical: {
      sessions: { ...(mapping?.logical?.sessions || {}) },
      windows: { ...(mapping?.logical?.windows || {}) },
      panes: { ...(mapping?.logical?.panes || {}) },
    },
  };
}

function mergeMapping(target, source) {
  const value = mappingPayload(source);
  Object.assign(target.names, value.names);
  for (const kind of ['sessions', 'windows', 'panes']) {
    Object.assign(target.runtime[kind], value.runtime[kind]);
    Object.assign(target.logical[kind], value.logical[kind]);
  }
}

function mapRuntime(mapping, kind, source, logical, runtime) {
  if (typeof source === 'string' && source) mapping.runtime[kind][source] = runtime;
  if (typeof logical === 'string' && logical) mapping.logical[kind][logical] = runtime;
}

function mappingForAlreadyPresent(checkpoint, live, results) {
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

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

function hasMapping(mapping) {
  return Object.keys(mapping.names).length > 0
    || ['sessions', 'windows', 'panes'].some((kind) => Object.keys(mapping.runtime[kind]).length > 0);
}

function cumulativeMapping(checkpointId, previous, additions, now) {
  const combined = blankMapping();
  mergeMapping(combined, previous);
  for (const addition of additions) mergeMapping(combined, addition);
  if (!hasMapping(combined)) return null;
  const identity = { checkpointId, ...combined };
  const id = crypto.createHash('sha256').update(JSON.stringify(sorted(identity))).digest('hex');
  return { id, checkpointId, restoredAt: new Date(now()).toISOString(), ...combined };
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
} = {}) {
  const operations = createOperationManager({ store, now, randomUUID });

  async function planRestore(requestInput = {}) {
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

  async function getRestorePlan(request = {}) {
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

  async function performRestore(operationId, request, onProgress) {
    let result;
    let restoreError;
    try {
      result = await lock.withLock({ operationId }, async () => {
        // The preview may be stale by now. Capture and plan again while holding the writer lock so a name
        // created after preview receives the next non-destructive `-restored` suffix.
        const state = await planRestore(request);
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
        const mapping = cumulativeMapping(state.checkpoint.id, state.recovery?.mapping, [
          restored.mapping,
          mappingForAlreadyPresent(state.checkpoint, state.live, restored.results),
        ], now);
        if (mapping && typeof store.mergeRecoveryMapping === 'function') {
          await store.mergeRecoveryMapping(state.checkpoint.id, mapping);
        }
        // Persist migration data before resolving pending ids. If the second write fails, retry planning
        // still sees the session and will recognize it as already-present instead of losing its mapping.
        if (resolvedIds.length > 0) await store.resolveSessions(state.checkpoint.id, resolvedIds);
        return { ...restored, mapping };
      });
    } catch (error) {
      restoreError = error;
    }
    let reconcileError;
    try {
      await checkpointer.reconcile('restore-complete');
    } catch (error) {
      reconcileError = error;
    }
    if (restoreError) throw restoreError;
    if (reconcileError) {
      result = {
        ...result,
        warnings: [...(result.warnings || []), `live reconcile failed: ${reconcileError?.message || String(reconcileError)}`],
      };
    }
    return result;
  }

  return {
    start: () => Promise.all([operations.interruptOrphans(), checkpointer.start()]),
    stop: () => checkpointer.stop(),
    requestReconcile: () => checkpointer.requestReconcile(),
    confirmEmpty: () => checkpointer.confirmEmpty(),
    listCheckpoints: () => store.listCheckpoints(),
    getRestorePlan,
    startRestore: (request = {}) => operations.start(request, ({ operationId, request: normalized, onProgress }) => (
      performRestore(operationId, normalized, onProgress)
    )),
    getOperation: (id) => operations.get(id),
    restoreNow: (request = {}) => operations.run(request, ({ operationId, request: normalized, onProgress }) => (
      performRestore(operationId, normalized, onProgress)
    )),
  };
}
