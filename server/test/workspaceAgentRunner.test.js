import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentRunner,
  launchAgentRequest,
  launchPreparedAgentRequest,
  publishAgentReadiness,
  validateAgentRequest,
  validatePreparedAgentRequest,
  waitForAgentExecutable,
} from '../src/workspace/agentRunner.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function childProcess() {
  const child = new EventEmitter();
  child.once = child.once.bind(child);
  return child;
}

describe('workspace agent runner', () => {
  it('validates the allowlist again and passes checkpoint session id only as a spawn argv token', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const launched = launchAgentRequest({ cmd: 'claude', args: ['--resume', ID] }, { spawn, readinessMs: 50 });
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(50);
    expect(await launched.ready).toEqual({ status: 'ready' });
    expect(spawn).toHaveBeenCalledWith('claude', ['--resume', ID], expect.objectContaining({ shell: false, stdio: 'inherit' }));
    child.emit('exit', 0, null);
    expect(await launched.completion).toEqual({ code: 0, signal: null });
    vi.useRealTimers();
  });

  it.each([
    [{ cmd: 'claude', args: ['--resume', `${ID}; touch /tmp/x`] }],
    [{ cmd: 'codex', args: ['resume', '../bad'] }],
    [{ cmd: 'sh', args: ['-c', 'anything'] }],
  ])('rejects unsafe persisted requests before spawn', (request) => {
    expect(() => validateAgentRequest(request)).toThrow(/unsafe agent request/i);
  });

  it.each([
    '/usr/local/bin:relative/bin',
    '/usr/local/bin::/usr/bin',
    '/usr/local/bin\n/usr/bin',
    `/${'x'.repeat(32_768)}`,
  ])('rejects an unsafe prepared PATH snapshot: %s', (pathEnv) => {
    expect(() => validatePreparedAgentRequest({
      paneId: '%7', cmd: 'codex', args: ['resume', ID], pathEnv,
    }, 'darwin')).toThrow(/unsafe agent PATH snapshot/i);
  });

  it('persists the Server PATH at prepare and uses it even when the pane runner PATH differs', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'handmux-agent-runner-'));
    const serverPath = '/usr/local/bin:/usr/bin:/bin';
    try {
      const runner = createAgentRunner({ home, pathEnv: serverPath, platform: 'darwin' });
      await runner.prepare({
        paneId: '%7', cmd: 'codex', args: ['resume', ID], pathEnv: '/untrusted/request/path',
      });
      const requestFile = path.join(home, '.handmux', 'workspaces', 'agent-runs', '7.request.json');
      const prepared = JSON.parse(await fsp.readFile(requestFile, 'utf8'));
      expect(prepared.pathEnv).toBe(serverPath);

      vi.useFakeTimers();
      const child = childProcess();
      const spawn = vi.fn(() => child);
      const launched = launchPreparedAgentRequest(prepared, {
        spawn,
        env: { PATH: '/usr/bin', HOME: '/pane-home' },
        platform: 'darwin',
        readinessMs: 10,
      });
      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(10);
      expect(await launched.ready).toEqual({ status: 'ready' });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(['codex', 'resume', ID]),
        expect.objectContaining({
          shell: false,
          env: expect.objectContaining({ PATH: serverPath, HOME: '/pane-home' }),
        }),
      );
      child.emit('exit', 0, null);
      await launched.completion;
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it('reports binary absence and immediate nonzero exit before readiness', async () => {
    for (const trigger of ['error', 'exit']) {
      vi.useFakeTimers();
      const child = childProcess();
      const launched = launchAgentRequest({ cmd: 'codex', args: ['resume', ID] }, { spawn: () => child, readinessMs: 100 });
      if (trigger === 'error') child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
      else child.emit('exit', 127, null);
      await expect(launched.ready).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/not found|exited 127/i) });
      vi.useRealTimers();
    }
  });

  it('kills and awaits an already-spawned child when readiness status persistence fails', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    child.kill = vi.fn((signal) => { child.emit('exit', null, signal); return true; });
    const launched = launchAgentRequest({ cmd: 'claude', args: ['--resume', ID] }, { spawn: () => child, readinessMs: 10 });
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(10);

    await expect(publishAgentReadiness(launched, async () => { throw new Error('status disk full'); }))
      .rejects.toThrow(/status disk full/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(launched.completion).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    vi.useRealTimers();
  });

  it('reports request cleanup failures instead of silently retaining a replayable resume request', async () => {
    const fs = {
      unlink: vi.fn(async () => { throw Object.assign(new Error('request cleanup EACCES'), { code: 'EACCES' }); }),
    };
    const runner = createAgentRunner({ home: '/safe-home', fs });

    await expect(runner.cancel('%7')).rejects.toThrow(/cleanup EACCES/i);
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('waits through a short executable replacement without consulting a shell', async () => {
    let now = 0;
    const checks = vi.fn(async () => now >= 250);
    const waits = [];

    await expect(waitForAgentExecutable('codex', {
      available: checks,
      now: () => now,
      wait: async (ms) => { waits.push(ms); now += ms; },
      timeoutMs: 800,
      pollMs: 100,
    })).resolves.toEqual({ status: 'ready' });

    expect(waits).toEqual([100, 100, 100]);
    expect(checks).toHaveBeenCalledTimes(4);
  });

  it('bounds a truly missing executable with one clear startup result', async () => {
    let now = 0;
    const waits = [];

    await expect(waitForAgentExecutable('claude', {
      available: async () => false,
      now: () => now,
      wait: async (ms) => { waits.push(ms); now += ms; },
      timeoutMs: 250,
      pollMs: 100,
    })).resolves.toEqual({
      status: 'failed',
      error: 'claude executable unavailable after startup wait',
    });

    expect(waits).toEqual([100, 100, 50]);
  });
});
