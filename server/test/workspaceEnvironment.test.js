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

  it.each([
    [{ status: 'unknown' }, 'unknown'],
    [{ status: 'absent', bootIdentity: 'a' }, 'unknown'],
  ])('does not turn a query failure or same-boot absent tmux into a change', (observed, status) => {
    expect(detectEnvironmentChange({ bootIdentity: 'a', tmuxServerId: 'a' }, observed).status).toBe(status);
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

  it('normalizes macOS kern.boottime output to stable whole seconds', async () => {
    const exec = vi.fn(async () => ({
      stdout: '{ sec = 1721234567, usec = 123456 } Mon Jul 17 12:34:56 2026\n',
    }));
    const provider = createBootIdentityProvider({ platform: 'darwin', exec });

    await expect(provider()).resolves.toBe('1721234567');
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.boottime']);
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
