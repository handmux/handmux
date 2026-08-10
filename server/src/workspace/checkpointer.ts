import { captureWorkspace } from './capture.js';
import { detectEnvironmentChange } from './environment.js';
import { fingerprintSnapshot } from './schema.js';
import type { CodexDiscovery, TmuxCaptureAdapter, WorkspaceCaptureResult } from './capture.js';
import type { EnvironmentIdentity, ObservedEnvironment } from './environment.js';
import type { WorkspaceSnapshot } from './schema.js';

type ReconcileCause = 'timer' | 'start' | 'event' | 'confirmed-empty' | 'shutdown' | string;
type ReconcileResult = { status: string; snapshot?: WorkspaceSnapshot; [key: string]: unknown };
interface LockHandle { release(): Promise<void> }
interface WriterLock { tryAcquire(options: { operationId: string }): Promise<LockHandle | null> }
type LiveReadResult =
  | { status: 'ok'; value: WorkspaceSnapshot }
  | { status: 'empty' }
  | { status: 'corrupt'; error?: string };
interface CheckpointerStore {
  readLive(): Promise<LiveReadResult>;
  writeLive(snapshot: WorkspaceSnapshot): Promise<unknown>;
  archiveEnvironment(options: {
    endedReason: 'boot-changed' | 'tmux-changed';
    detectedAt: string;
  }): Promise<{ status: string; [key: string]: unknown }>;
}
type TimerHandle = unknown;
type SetTimer = (callback: () => void, delay: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;
export interface WorkspaceCheckpointerHealth {
  status: 'starting' | 'ready' | 'degraded';
  detail: string | null;
}

export interface CheckpointerOptions {
  store: CheckpointerStore;
  observeEnvironment(): Promise<ObservedEnvironment | null | undefined>;
  lock: WriterLock;
  capture(environment: EnvironmentIdentity): Promise<WorkspaceCaptureResult>;
  setInterval?: SetTimer;
  clearInterval?: ClearTimer;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
  now?: () => number;
}

function sameSnapshot(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return fingerprintSnapshot(left) === fingerprintSnapshot(right);
}

function snapshotEnvironment(observed: Exclude<ObservedEnvironment, { status: 'unknown' }>): EnvironmentIdentity {
  return {
    id: observed.id,
    bootIdentity: observed.bootIdentity,
    tmuxServerId: observed.tmuxServerId,
  };
}

async function reconcileOnce(
  deps: Required<CheckpointerOptions> & { scheduleRetry?: () => void },
  cause: ReconcileCause,
): Promise<ReconcileResult> {
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

    const current = 'current' in change ? change.current : observed;
    const captured = await deps.capture(snapshotEnvironment(current));
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
  setInterval = globalThis.setInterval as SetTimer,
  clearInterval = globalThis.clearInterval as ClearTimer,
  setTimeout = globalThis.setTimeout as SetTimer,
  clearTimeout = globalThis.clearTimeout as ClearTimer,
  now = Date.now,
  ...rest
}: CheckpointerOptions) {
  const deps: Required<CheckpointerOptions> & { scheduleRetry?: () => void } = {
    ...rest, now, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  let interval: TimerHandle | null = null;
  let debounce: TimerHandle | null = null;
  let running: Promise<ReconcileResult> | null = null;
  let pendingConfirmation: {
    promise: Promise<ReconcileResult>;
    resolve: (result: ReconcileResult | PromiseLike<ReconcileResult>) => void;
    reject: (reason?: unknown) => void;
  } | null = null;
  let stopping = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let lastResult: ReconcileResult | null = null;
  let lastError: string | null = null;

  function launch(cause: ReconcileCause): Promise<ReconcileResult> {
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

  function confirmEmpty(): Promise<ReconcileResult> {
    if (stopping || stopped) return Promise.resolve({ status: 'stopped' });
    if (!running) return launch('confirmed-empty');
    if (!pendingConfirmation) {
      let resolve!: (result: ReconcileResult | PromiseLike<ReconcileResult>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<ReconcileResult>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      pendingConfirmation = { promise, resolve, reject };
    }
    return pendingConfirmation.promise;
  }

  function reconcile(cause: ReconcileCause = 'timer'): Promise<ReconcileResult> {
    if (cause === 'confirmed-empty') return confirmEmpty();
    if (stopping || stopped) return Promise.resolve({ status: 'stopped' });
    return running || launch(cause);
  }

  function requestReconcile(): void {
    if (stopping || stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      reconcile('event').catch(() => {});
    }, 2_000);
  }
  deps.scheduleRetry = requestReconcile;
  const outstanding = (): Promise<ReconcileResult> | null => (
    running ?? pendingConfirmation?.promise ?? null
  );

  return {
    reconcile,
    health(): WorkspaceCheckpointerHealth {
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
        let pending = outstanding();
        while (pending) {
          await pending.catch(() => {});
          pending = outstanding();
        }
        await launch('shutdown').catch(() => {});
        pending = outstanding();
        while (pending) {
          await pending.catch(() => {});
          pending = outstanding();
        }
        stopped = true;
      })();
      return stopPromise;
    },
  };
}

export function createWorkspaceBackground({
  store, tmux, observeEnvironment, lock, stateFile, getCodexApp = () => null, codexSessions, now = Date.now,
}: {
  store: CheckpointerStore;
  tmux: TmuxCaptureAdapter;
  observeEnvironment: () => Promise<ObservedEnvironment | null | undefined>;
  lock: WriterLock;
  stateFile: string;
  getCodexApp?: () => CodexDiscovery | null | undefined;
  codexSessions?: string;
  now?: () => number;
}) {
  return createCheckpointer({
    store,
    observeEnvironment,
    lock,
    now,
    capture: (environment) => captureWorkspace({
      tmux, stateFile, environment, codexApp: getCodexApp() ?? undefined, codexSessions, now,
    }),
  });
}

export function createGracefulShutdown({ events, workspace, browser, server }: {
  events: { stop(): unknown | Promise<unknown> };
  workspace: { stop(): unknown | Promise<unknown> };
  browser?: { close(): unknown | Promise<unknown> } | null;
  server: { close(): unknown };
}): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return function shutdown(): Promise<void> {
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
