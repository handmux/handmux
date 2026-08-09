import { describe, expect, it } from 'vitest';
import {
  initialSupervisorComponentState,
  reduceSupervisorComponent,
  supervisorRestartDelay,
} from '../src/cli/supervisorState.js';

describe('Supervisor component state', () => {
  it('makes starting, readiness, exit and backoff explicit', () => {
    let state = initialSupervisorComponentState('server');
    state = reduceSupervisorComponent(state, { type: 'spawned', pid: 101, at: 1_000 });
    expect(state).toMatchObject({ phase: 'starting', pid: 101, restartAttempt: 0 });

    state = reduceSupervisorComponent(state, { type: 'exited', at: 1_100, error: 'exit 1' });
    expect(state).toMatchObject({
      phase: 'backoff', pid: null, restartAttempt: 1, restartAt: 1_600,
      readyAt: null, lastExitAt: 1_100, error: 'exit 1',
    });

    state = reduceSupervisorComponent(state, { type: 'spawned', pid: 102, at: 1_600 });
    state = reduceSupervisorComponent(state, { type: 'ready', at: 1_700 });
    expect(state).toMatchObject({
      phase: 'ready', pid: 102, restartAttempt: 0, restartAt: null, readyAt: 1_700,
    });
  });

  it('keeps Server and Tunnel retry attempts in independent failure domains', () => {
    let server = initialSupervisorComponentState('server');
    let tunnel = initialSupervisorComponentState('tunnel');
    server = reduceSupervisorComponent(server, { type: 'exited', at: 1_000 });
    server = reduceSupervisorComponent(server, { type: 'exited', at: 2_000 });
    tunnel = reduceSupervisorComponent(tunnel, { type: 'exited', at: 2_000 });

    expect(server).toMatchObject({ restartAttempt: 2, restartAt: 3_000 });
    expect(tunnel).toMatchObject({ restartAttempt: 1, restartAt: 2_500 });
  });

  it('caps exponential restart delay and rejects non-attempts', () => {
    expect(supervisorRestartDelay(0)).toBe(0);
    expect(supervisorRestartDelay(1)).toBe(500);
    expect(supervisorRestartDelay(2)).toBe(1_000);
    expect(supervisorRestartDelay(20)).toBe(15_000);
  });
});
