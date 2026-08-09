export type SupervisorComponentName = 'server' | 'tunnel';
export type SupervisorComponentPhase = 'stopped' | 'starting' | 'ready' | 'backoff';

export interface SupervisorComponentState {
  name: SupervisorComponentName;
  phase: SupervisorComponentPhase;
  pid: number | null;
  restartAttempt: number;
  restartAt: number | null;
  startedAt: number | null;
  readyAt: number | null;
  lastExitAt: number | null;
  error: string | null;
}

export type SupervisorComponentEvent =
  | { type: 'spawned'; pid: number | null; at: number }
  | { type: 'ready'; at: number }
  | { type: 'exited'; at: number; error?: string | null }
  | { type: 'stopped'; at: number };

export interface SupervisorBackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

export function supervisorRestartDelay(
  restartAttempt: number,
  { baseMs = 500, maxMs = 15_000 }: SupervisorBackoffOptions = {},
): number {
  if (!Number.isSafeInteger(restartAttempt) || restartAttempt <= 0) return 0;
  return Math.min(baseMs * (2 ** Math.min(restartAttempt - 1, 30)), maxMs);
}

export function initialSupervisorComponentState(
  name: SupervisorComponentName,
): SupervisorComponentState {
  return {
    name,
    phase: 'stopped',
    pid: null,
    restartAttempt: 0,
    restartAt: null,
    startedAt: null,
    readyAt: null,
    lastExitAt: null,
    error: null,
  };
}

export function reduceSupervisorComponent(
  state: SupervisorComponentState,
  event: SupervisorComponentEvent,
  backoff?: SupervisorBackoffOptions,
): SupervisorComponentState {
  if (event.type === 'spawned') {
    return {
      ...state,
      phase: 'starting',
      pid: event.pid,
      restartAt: null,
      startedAt: event.at,
      readyAt: null,
      error: null,
    };
  }
  if (event.type === 'ready') {
    return {
      ...state,
      phase: 'ready',
      restartAttempt: 0,
      restartAt: null,
      readyAt: event.at,
      error: null,
    };
  }
  if (event.type === 'exited') {
    const restartAttempt = state.restartAttempt + 1;
    return {
      ...state,
      phase: 'backoff',
      pid: null,
      restartAttempt,
      restartAt: event.at + supervisorRestartDelay(restartAttempt, backoff),
      readyAt: null,
      lastExitAt: event.at,
      error: event.error ?? null,
    };
  }
  return {
    ...state,
    phase: 'stopped',
    pid: null,
    restartAt: null,
    readyAt: null,
    error: null,
  };
}
