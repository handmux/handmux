import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalizeMacBootTime(value) {
  const seconds = String(value).match(/\bsec\s*=\s*(\d+)\b/)?.[1];
  return seconds && seconds !== '0' ? seconds : null;
}

function environmentId(bootIdentity, tmuxServerId) {
  return crypto
    .createHash('sha256')
    .update(`${bootIdentity}\0${tmuxServerId || 'no-tmux'}`)
    .digest('hex');
}

export function detectEnvironmentChange(previous, observed) {
  if (!observed || observed.status === 'unknown') return { status: 'unknown' };
  if (!previous) return { status: 'initial', current: observed };
  if (previous.bootIdentity !== observed.bootIdentity) return { status: 'changed', reason: 'boot-changed', current: observed };
  if (observed.status === 'absent') return { status: 'unknown' };
  if (!previous.tmuxServerId) return { status: 'attached', reason: 'same', current: observed };
  if (previous.tmuxServerId !== observed.tmuxServerId) return { status: 'changed', reason: 'tmux-changed', current: observed };
  return { status: 'same', reason: 'same', current: observed };
}

export function createBootIdentityProvider({
  platform = process.platform,
  readFile = fsp.readFile,
  exec = execFileAsync,
} = {}) {
  return async () => {
    try {
      if (platform === 'linux') {
        const identity = String(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        return identity || null;
      }
      if (platform === 'darwin') {
        return normalizeMacBootTime((await exec('sysctl', ['-n', 'kern.boottime'])).stdout);
      }
      return null;
    } catch {
      return null;
    }
  };
}

export function createEnvironmentProvider({
  bootIdentityProvider = createBootIdentityProvider(),
  tmuxServerIdProvider,
} = {}) {
  return async () => {
    try {
      const bootIdentity = await bootIdentityProvider();
      if (typeof bootIdentity !== 'string' || !bootIdentity) return { status: 'unknown' };
      const tmuxServerId = await tmuxServerIdProvider();
      if (tmuxServerId !== null && (typeof tmuxServerId !== 'string' || !tmuxServerId)) return { status: 'unknown' };
      return {
        status: tmuxServerId === null ? 'absent' : 'present',
        id: environmentId(bootIdentity, tmuxServerId),
        bootIdentity,
        tmuxServerId,
      };
    } catch {
      return { status: 'unknown' };
    }
  };
}
