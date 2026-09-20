import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceLock } from '../src/workspace/lock.js';

const homes = [];

async function lockPath() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-lock-'));
  homes.push(home);
  return path.join(home, 'workspace.lock');
}

async function seedLock(dir, owner, ageMs = 0) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner));
  if (ageMs) {
    const at = new Date(Date.now() - ageMs);
    await fs.utimes(dir, at, at);
  }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe('workspace filesystem lock', () => {
  it('uses atomic mkdir so only one concurrent contender acquires it', async () => {
    const dir = await lockPath();
    const first = createWorkspaceLock({ dir, pid: 101, isProcessAlive: () => true });
    const second = createWorkspaceLock({ dir, pid: 202, isProcessAlive: () => true });

    const handles = await Promise.all([
      first.tryAcquire({ operationId: 'capture-a' }),
      second.tryAcquire({ operationId: 'capture-b' }),
    ]);

    expect(handles.filter(Boolean)).toHaveLength(1);
    await handles.find(Boolean).release();
  });

  it('never reclaims an old lock whose PID is still alive', async () => {
    const dir = await lockPath();
    await seedLock(dir, { pid: 404, startedAt: '2026-07-20T00:00:00.000Z', operationId: 'restore-live' }, 60_000);
    const lock = createWorkspaceLock({ dir, staleGraceMs: 1_000, isProcessAlive: (pid) => pid === 404 });

    expect(await lock.tryAcquire({ operationId: 'capture' })).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')).operationId).toBe('restore-live');
  });

  it('reclaims a dead PID only after the stale grace has elapsed', async () => {
    const dir = await lockPath();
    const now = Date.parse('2026-07-20T00:00:10.000Z');
    await seedLock(dir, {
      pid: 505,
      startedAt: new Date(now - 500).toISOString(),
      operationId: 'recent-dead',
      token: '10000000-0000-4000-8000-000000000001',
    });
    const lock = createWorkspaceLock({ dir, pid: 606, now: () => now, staleGraceMs: 1_000, isProcessAlive: () => false });

    expect(await lock.tryAcquire({ operationId: 'capture' })).toBeNull();
    await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({
      pid: 505,
      startedAt: new Date(now - 2_000).toISOString(),
      operationId: 'stale-dead',
      token: '10000000-0000-4000-8000-000000000001',
    }));
    const handle = await lock.tryAcquire({ operationId: 'capture' });
    expect(handle).toBeTruthy();
    expect(handle.owner).toMatchObject({ pid: 606, operationId: 'capture' });
    await handle.release();
  });

  it('lets only one contender rename an observed stale token and keeps its tombstone', async () => {
    const dir = await lockPath();
    const staleToken = '10000000-0000-4000-8000-000000000001';
    await seedLock(dir, {
      pid: 505,
      startedAt: '2026-07-20T00:00:00.000Z',
      operationId: 'stale-restore',
      token: staleToken,
    });
    let ownerReads = 0;
    let releaseReads;
    const bothRead = new Promise((resolve) => { releaseReads = resolve; });
    const gatedFs = new Proxy(fs, {
      get(object, property) {
        if (property !== 'readFile') return Reflect.get(object, property);
        return async (file, ...args) => {
          const value = await object.readFile(file, ...args);
          if (file === path.join(dir, 'owner.json') && ++ownerReads <= 2) {
            if (ownerReads === 2) releaseReads();
            await bothRead;
          }
          return value;
        };
      },
    });
    const options = {
      dir,
      fs: gatedFs,
      now: () => Date.parse('2026-07-20T00:01:00.000Z'),
      staleGraceMs: 1_000,
      isProcessAlive: () => false,
    };
    const first = createWorkspaceLock({ ...options, pid: 601 });
    const second = createWorkspaceLock({ ...options, pid: 602 });

    const handles = await Promise.all([
      first.tryAcquire({ operationId: 'capture-a' }),
      second.tryAcquire({ operationId: 'capture-b' }),
    ]);

    expect(handles.filter(Boolean)).toHaveLength(1);
    const tombstone = `${dir}.stale.${staleToken}`;
    expect(JSON.parse(await fs.readFile(path.join(tombstone, 'owner.json'), 'utf8'))).toMatchObject({ token: staleToken });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')).operationId).toMatch(/^capture-/);
    await handles.find(Boolean).release();
  });

  it('does not derive a stale destination from an unsafe owner token', async () => {
    const dir = await lockPath();
    await seedLock(dir, {
      pid: 505,
      startedAt: '2026-07-20T00:00:00.000Z',
      operationId: 'corrupt-owner',
      token: '../../escape',
    }, 60_000);
    const aged = await fs.stat(dir);
    const lock = createWorkspaceLock({
      dir,
      staleGraceMs: 1_000,
      isProcessAlive: () => false,
    });

    // An unusable token makes the record unusable, so the directory is reclaimed — but the destination is
    // derived from the observation, never from the token, so no path can be built out of it.
    const handle = await lock.tryAcquire({ operationId: 'capture' });
    expect(handle).toBeTruthy();
    expect(await fs.readFile(path.join(dir, 'owner.json'), 'utf8').then(() => 'present', () => 'missing'))
      .toBe('present');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')).operationId).toBe('capture');
    const tombstone = `${dir}.stale.unreadable-${Math.round(aged.mtimeMs)}`;
    expect(await fs.readdir(tombstone)).toEqual(['owner.json']);
    await expect(fs.stat(path.resolve(dir, '../../escape'))).rejects.toThrow();
    await handle.release();
  });

  it('reclaims a lock directory left behind without an owner record', async () => {
    // A holder that dies between `mkdir` and writing its record leaves exactly this: a directory with
    // nothing in it. Refusing to reclaim it blocked every capture and every restore on the host for good.
    const dir = await lockPath();
    await fs.mkdir(dir, { recursive: true });
    const fresh = createWorkspaceLock({ dir, staleGraceMs: 60_000, isProcessAlive: () => false });
    expect(await fresh.tryAcquire({ operationId: 'capture' })).toBeNull();

    const at = new Date(Date.now() - 60_000);
    await fs.utimes(dir, at, at);
    const lock = createWorkspaceLock({ dir, staleGraceMs: 1_000, isProcessAlive: () => false });

    const handle = await lock.tryAcquire({ operationId: 'capture' });
    expect(handle).toBeTruthy();
    expect(JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')).operationId).toBe('capture');
    await handle.release();
  });

  it('reclaims a lock whose owner record cannot be read or parsed', async () => {
    const dir = await lockPath();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'owner.json'), '{"pid":');
    const at = new Date(Date.now() - 60_000);
    await fs.utimes(dir, at, at);
    const aged = await fs.stat(dir);
    const lock = createWorkspaceLock({ dir, staleGraceMs: 1_000, isProcessAlive: () => false });

    const handle = await lock.tryAcquire({ operationId: 'capture' });
    expect(handle).toBeTruthy();
    expect(await fs.readdir(`${dir}.stale.unreadable-${Math.round(aged.mtimeMs)}`)).toEqual(['owner.json']);
    await handle.release();
  });

  it('times out with the current owner details instead of hiding the contention', async () => {
    const dir = await lockPath();
    await seedLock(dir, { pid: 707, startedAt: '2026-07-20T00:00:00.000Z', operationId: 'restore-707' });
    let clock = 0;
    const lock = createWorkspaceLock({
      dir,
      now: () => (clock += 10),
      timeoutMs: 15,
      retryMs: 1,
      wait: async () => {},
      isProcessAlive: () => true,
    });

    await expect(lock.acquire({ operationId: 'capture' })).rejects.toThrow(/restore-707.*707|707.*restore-707/);
  });
});
