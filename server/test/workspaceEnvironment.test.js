import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createBootIdentityProvider,
  createEnvironmentProvider,
  detectEnvironmentChange,
} from '../src/workspace/environment.js';

describe('detectEnvironmentChange', () => {
  it.each([
    [{ bootIdentity: 'b', tmuxServerId: 't' }, { status: 'present', bootIdentity: 'b', tmuxServerId: 't' }, 'same'],
    [{ bootIdentity: 'a', tmuxServerId: 't' }, { status: 'absent', bootIdentity: 'b' }, 'boot-changed'],
    [{ bootIdentity: 'b', tmuxServerId: 'a' }, { status: 'present', bootIdentity: 'b', tmuxServerId: 'b' }, 'tmux-changed'],
  ])('%j -> %j = %s', (previous, observed, reason) => {
    expect(detectEnvironmentChange(previous, observed).reason).toBe(reason);
  });

  it('does not turn a query failure into a change', () => {
    expect(detectEnvironmentChange({ bootIdentity: 'a', tmuxServerId: 'a' }, { status: 'unknown' }).status).toBe('unknown');
  });

  it('treats a missing tmux server as a generation change only when live state belonged to one', () => {
    const observed = { status: 'absent', id: 'empty-id', bootIdentity: 'a', tmuxServerId: null };

    expect(detectEnvironmentChange({ id: 'old-id', bootIdentity: 'a', tmuxServerId: 'tmux-old' }, observed)).toEqual({
      status: 'changed',
      reason: 'tmux-changed',
      current: observed,
    });
    expect(detectEnvironmentChange({ id: 'empty-id', bootIdentity: 'a', tmuxServerId: null }, observed)).toEqual({
      status: 'unknown',
    });
  });

  it('attaches the first tmux generation to an explicit empty live environment', () => {
    const observed = { status: 'present', id: 'new-id', bootIdentity: 'a', tmuxServerId: 'tmux-a' };
    expect(detectEnvironmentChange({ id: 'empty-id', bootIdentity: 'a', tmuxServerId: null }, observed)).toEqual({
      status: 'attached',
      reason: 'same',
      current: observed,
    });
  });

  it('starts with the observed environment and propagates a boot change while tmux is absent', () => {
    const observed = { status: 'absent', id: 'new-id', bootIdentity: 'b', tmuxServerId: null };
    expect(detectEnvironmentChange(null, observed)).toEqual({ status: 'initial', current: observed });
    expect(detectEnvironmentChange({ bootIdentity: 'a', tmuxServerId: 'old' }, observed)).toEqual({
      status: 'changed',
      reason: 'boot-changed',
      current: observed,
    });
  });
});

describe('createBootIdentityProvider', () => {
  it.each([
    ['Linux', 'linux'],
    ['WSL', 'linux'],
  ])('reads the kernel boot id on %s without consulting the host', async (_name, platform) => {
    const readFile = vi.fn(async () => '  2f61d1ee-boot-id\n');
    const provider = createBootIdentityProvider({ platform, readFile });

    await expect(provider()).resolves.toBe('2f61d1ee-boot-id');
    expect(readFile).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
  });

  it('uses the macOS boot session UUID rather than the wall-clock boot time', async () => {
    const exec = vi.fn(async () => ({ stdout: '  54B3288F-F346-4849-B503-EB5A1D433DBB\n' }));
    const provider = createBootIdentityProvider({ platform: 'darwin', exec });
    await expect(provider()).resolves.toBe('darwin:54b3288f-f346-4849-b503-eb5a1d433dbb');
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.bootsessionuuid']);
  });

  it.each(['', '1788200735', '{ sec = 1788200735, usec = 0 }', 'not-a-uuid'])(
    'does not fall back to boot time when the macOS UUID is invalid: %j', async (stdout) => {
      const exec = vi.fn(async () => ({ stdout }));
      const provider = createEnvironmentProvider({
        bootIdentityProvider: createBootIdentityProvider({ platform: 'darwin', exec }),
        tmuxServerIdProvider: async () => 'same-tmux',
      });
      await expect(provider()).resolves.toEqual({ status: 'unknown' });
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );

  it('returns unknown without a boot-time fallback when macOS sysctl fails', async () => {
    const exec = vi.fn(async () => { throw new Error('sysctl unavailable'); });
    const provider = createEnvironmentProvider({
      bootIdentityProvider: createBootIdentityProvider({ platform: 'darwin', exec }),
      tmuxServerIdProvider: async () => 'same-tmux',
    });
    await expect(provider()).resolves.toEqual({ status: 'unknown' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.bootsessionuuid']);
  });

  it('returns null for unsupported platforms, malformed macOS output, and provider errors', async () => {
    const unsupported = createBootIdentityProvider({ platform: 'win32' });
    const malformed = createBootIdentityProvider({ platform: 'darwin', exec: async () => ({ stdout: 'not-a-time' }) });
    const failed = createBootIdentityProvider({ platform: 'linux', readFile: async () => { throw new Error('denied'); } });

    await expect(unsupported()).resolves.toBeNull();
    await expect(malformed()).resolves.toBeNull();
    await expect(failed()).resolves.toBeNull();
  });
});

describe('createEnvironmentProvider', () => {
  it.each([
    ['tmux-a', 'present'],
    [null, 'absent'],
  ])('builds a stable environment identity for tmux generation %j', async (tmuxServerId, status) => {
    const provider = createEnvironmentProvider({
      bootIdentityProvider: async () => 'boot-a',
      tmuxServerIdProvider: async () => tmuxServerId,
    });
    const expectedId = crypto.createHash('sha256').update(`boot-a\0${tmuxServerId || 'no-tmux'}`).digest('hex');

    await expect(provider()).resolves.toEqual({ status, id: expectedId, bootIdentity: 'boot-a', tmuxServerId });
  });

  it.each(['boot', 'tmux'])('returns unknown when the injected %s provider fails', async (failedProvider) => {
    const fail = async () => { throw new Error('query failed'); };
    const provider = createEnvironmentProvider({
      bootIdentityProvider: failedProvider === 'boot' ? fail : async () => 'boot-a',
      tmuxServerIdProvider: failedProvider === 'tmux' ? fail : async () => 'tmux-a',
    });

    await expect(provider()).resolves.toEqual({ status: 'unknown' });
  });
});


describe('legacy macOS boot identity migration', () => {
  const bootIdentity = 'darwin:54b3288f-f346-4849-b503-eb5a1d433dbb';
  it.each([
    ['present', 'same-tmux', 'same'],
    ['present', 'new-tmux', 'tmux-changed'],
    ['absent', null, 'tmux-changed'],
  ])('uses tmux generation evidence during numeric-to-UUID migration: %s %s', (status, tmuxServerId, reason) => {
    expect(detectEnvironmentChange({ bootIdentity: '1788200737', tmuxServerId: 'same-tmux' },
      { status, id: 'current', bootIdentity, tmuxServerId }).reason).toBe(reason);
  });
  it('still detects a changed stable boot UUID', () => {
    expect(detectEnvironmentChange({ bootIdentity, tmuxServerId: 'same-tmux' }, {
      status: 'present', id: 'current', bootIdentity: 'darwin:64b3288f-f346-4849-b503-eb5a1d433dbb', tmuxServerId: 'same-tmux',
    }).reason).toBe('boot-changed');
  });
  it('does not infer a lost generation from two empty environments during migration', () => {
    expect(detectEnvironmentChange({ bootIdentity: '1788200737', tmuxServerId: null },
      { status: 'absent', id: 'current', bootIdentity, tmuxServerId: null })).toEqual({ status: 'unknown' });
  });
});


it.each(['54b3288f-f346-4849-b503-eb5a1d433dbb', 'darwin:not-a-uuid', '1788200735'])(
  'does not treat a numeric-to-%s change as the macOS UUID migration', (bootIdentity) => {
    expect(detectEnvironmentChange({ bootIdentity: '1788200737', tmuxServerId: 'same-tmux' }, {
      status: 'present', id: 'current', bootIdentity, tmuxServerId: 'same-tmux',
    }).reason).toBe('boot-changed');
  },
);
