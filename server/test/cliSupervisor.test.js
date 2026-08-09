import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { browserPublicOriginEnv, supervise } from '../src/cli/supervisor.js';
import { tmpHome } from './tmphome.js';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {}
}

describe('browser public origin supervisor environment', () => {
  it('passes previewDomain to the server process', () => {
    expect(browserPublicOriginEnv({
      previewDomain: 'handmux.example.com:30443',
      publicUrl: 'https://handmux.example/app',
    })).toEqual({
      HANDMUX_PREVIEW_DOMAIN: 'handmux.example.com:30443',
      HANDMUX_PUBLIC_URL: 'https://handmux.example/app',
    });
    expect(browserPublicOriginEnv({ previewDomain: null })).toEqual({});
  });
});

describe('Supervisor process state wiring', () => {
  it('clears Server readiness immediately on exit and restarts with its own backoff', async () => {
    const children = [];
    const readiness = [];
    const timers = [];
    let clock = 1_000;
    const spawnChild = vi.fn(() => {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    });
    const probeServerReady = vi.fn(() => new Promise((resolve) => readiness.push(resolve)));
    const processRef = {
      pid: 50,
      env: {},
      execPath: '/usr/bin/node',
      stdout: { write: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      exit: vi.fn(),
    };
    const { state } = supervise({
      tunnel: 'none', port: 19_999, host: '127.0.0.1', token: 'secret', shortcuts: [],
    }, {
      home: tmpHome('hm-supervisor-'), processRef, spawnChild, probeServerReady,
      now: () => clock,
      setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
      log: { warn: vi.fn() },
    });

    expect(state).toMatchObject({
      ready: false,
      serverPid: 100,
      components: {
        server: { phase: 'starting', restartAttempt: 0 },
        tunnel: { phase: 'ready', restartAttempt: 0 },
      },
    });
    readiness[0](true);
    await Promise.resolve();
    expect(state).toMatchObject({ ready: true, components: { server: { phase: 'ready' } } });

    clock = 1_100;
    children[0].emit('exit', 1, null);
    expect(state).toMatchObject({
      ready: false,
      serverPid: null,
      components: {
        server: { phase: 'backoff', restartAttempt: 1, restartAt: 1_600 },
        tunnel: { phase: 'ready', restartAttempt: 0 },
      },
    });
    expect(timers.at(-1).delay).toBe(500);

    clock = 1_600;
    timers.at(-1).fn();
    expect(state).toMatchObject({
      ready: false,
      serverPid: 101,
      components: { server: { phase: 'starting', restartAttempt: 1 } },
    });
    readiness[1](true);
    await Promise.resolve();
    expect(state).toMatchObject({
      ready: true,
      components: { server: { phase: 'ready', restartAttempt: 0 } },
    });
  });
});
