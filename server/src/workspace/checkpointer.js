import { captureWorkspace } from './capture.js';
import { detectEnvironmentChange } from './environment.js';
import { fingerprintSnapshot } from './schema.js';

function sameSnapshot(left, right) {
  return fingerprintSnapshot(left) === fingerprintSnapshot(right);
}

function snapshotEnvironment(observed) {
  return {
    id: observed.id,
    bootIdentity: observed.bootIdentity,
    tmuxServerId: observed.tmuxServerId,
  };
}

async function reconcileOnce(deps, cause) {
  const handle = await deps.lock.tryAcquire({ operationId: `checkpointer:${cause}` });
  if (!handle) return { status: 'locked' };
  try {
    const observed = await deps.observeEnvironment();
    if (!observed || observed.status === 'unknown') return { status: 'unknown' };

    const live = await deps.store.readLive();
    if (live.status === 'corrupt') return live;
    const previous = live.status === 'ok' ? live.value.environment : null;
    let change = detectEnvironmentChange(previous, observed);
    if (cause === 'confirmed-empty' && observed.status === 'absent') {
      change = { status: 'same', reason: 'same', current: observed };
    }
    if (change.status === 'unknown') return change;

    // An absent tmux server only ends a known live generation. An already-empty generation remains
    // unknown unless a Handmux deletion explicitly confirms it.
    if (observed.status === 'absent' && cause !== 'confirmed-empty' && change.status !== 'changed') {
      return { status: 'unknown' };
    }

    const captured = await deps.capture(snapshotEnvironment(change.current ?? observed));
    if (captured.status === 'changed-during-capture') {
      deps.scheduleRetry?.();
      return captured;
    }
    if (captured.status !== 'ok' && captured.status !== 'empty') return captured;
    if (captured.status === 'empty' && cause !== 'confirmed-empty' && observed.status !== 'present' && change.status !== 'changed') {
      return { status: 'unknown' };
    }
    if (change.status === 'changed') {
      const archived = await deps.store.archiveEnvironment({
        endedReason: change.reason,
        detectedAt: new Date(deps.now()).toISOString(),
      });
      if (archived.status !== 'ok' && archived.status !== 'empty') return archived;
    }
    if (live.status === 'ok' && sameSnapshot(live.value, captured.snapshot)) return { status: 'unchanged' };
    await deps.store.writeLive(captured.snapshot);
    return { status: 'written', snapshot: captured.snapshot };
  } finally {
    await handle.release();
  }
}

export function createCheckpointer({
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  now = Date.now,
  ...rest
} = {}) {
  const deps = { ...rest, now, setInterval, clearInterval, setTimeout, clearTimeout };
  let interval = null;
  let debounce = null;
  let running = null;
  let pendingConfirmation = null;
  let stopping = false;
  let stopped = false;
  let stopPromise = null;
  let lastResult = null;
  let lastError = null;

  function launch(cause) {
    const current = reconcileOnce(deps, cause);
    running = current;
    const settled = () => {
      if (running !== current) return;
      running = null;
      if (pendingConfirmation) {
        const pending = pendingConfirmation;
        pendingConfirmation = null;
        launch('confirmed-empty').then(pending.resolve, pending.reject);
      }
    };
    current.then((result) => {
      lastResult = result;
      lastError = null;
      settled();
    }, () => {
      lastError = 'workspace-reconcile-failed';
      settled();
    });
    return current;
  }

  function confirmEmpty() {
    if (stopping || stopped) return Promise.resolve({ status: 'stopped' });
    if (!running) return launch('confirmed-empty');
    if (!pendingConfirmation) {
      let resolve;
      let reject;
      const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      pendingConfirmation = { promise, resolve, reject };
    }
    return pendingConfirmation.promise;
  }

  function reconcile(cause = 'timer') {
    if (cause === 'confirmed-empty') return confirmEmpty();
    if (stopping || stopped) return Promise.resolve({ status: 'stopped' });
    return running || launch(cause);
  }

  function requestReconcile() {
    if (stopping || stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      reconcile('event').catch(() => {});
    }, 2_000);
  }
  deps.scheduleRetry = requestReconcile;

  return {
    reconcile,
    health() {
      if (stopping || stopped) return { status: 'degraded', detail: 'workspace-stopped' };
      if (lastError) return { status: 'degraded', detail: lastError };
      if (!lastResult) return { status: 'starting', detail: 'workspace-reconcile-starting' };
      if (lastResult.status === 'written' || lastResult.status === 'unchanged') {
        return { status: 'ready', detail: null };
      }
      if (lastResult.status === 'locked') {
        return { status: 'ready', detail: 'workspace-writer-locked' };
      }
      return { status: 'degraded', detail: `workspace-${lastResult.status || 'unknown'}` };
    },
    start() {
      if (stopping || stopped) return Promise.resolve({ status: 'stopped' });
      if (!interval) interval = setInterval(() => { reconcile('timer').catch(() => {}); }, 60_000);
      return reconcile('start');
    },
    requestReconcile,
    confirmEmpty,
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        if (interval) clearInterval(interval);
        if (debounce) clearTimeout(debounce);
        interval = null;
        debounce = null;
        while (running || pendingConfirmation) {
          await (running || pendingConfirmation.promise).catch(() => {});
        }
        await launch('shutdown').catch(() => {});
        while (running || pendingConfirmation) {
          await (running || pendingConfirmation.promise).catch(() => {});
        }
        stopped = true;
      })();
      return stopPromise;
    },
  };
}

export function createWorkspaceBackground({
  store, tmux, observeEnvironment, lock, stateFile, getCodexApp = () => null, codexSessions, now = Date.now,
} = {}) {
  return createCheckpointer({
    store,
    observeEnvironment,
    lock,
    now,
    capture: (environment) => captureWorkspace({
      tmux, stateFile, environment, codexApp: getCodexApp(), codexSessions, now,
    }),
  });
}

export function createGracefulShutdown({ events, workspace, browser, server }) {
  let closing = null;
  return function shutdown() {
    if (!closing) {
      closing = (async () => {
        try {
          await events.stop();
        } finally {
          try {
            await workspace.stop();
          } finally {
            try { await browser?.close(); } finally { server.close(); }
          }
        }
      })();
    }
    return closing;
  };
}
