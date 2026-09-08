import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface EnvironmentIdentity {
  id: string;
  bootIdentity: string;
  tmuxServerId: string | null;
}
export type ObservedEnvironment =
  | ({ status: 'present' | 'absent' } & EnvironmentIdentity)
  | { status: 'unknown' };
export type EnvironmentChange =
  | { status: 'unknown' }
  | { status: 'initial'; current: Exclude<ObservedEnvironment, { status: 'unknown' }> }
  | { status: 'attached' | 'same'; reason: 'same'; current: Exclude<ObservedEnvironment, { status: 'unknown' }> }
  | { status: 'changed'; reason: 'boot-changed' | 'tmux-changed'; current: Exclude<ObservedEnvironment, { status: 'unknown' }> };

type ReadFile = (path: string, encoding: 'utf8') => Promise<string | Buffer>;
type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string | Buffer }>;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_PATTERN}$`, 'i');
const MAC_BOOT_IDENTITY = new RegExp(`^darwin:${UUID_PATTERN}$`, 'i');

export function isLegacyMacBootIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function environmentId(bootIdentity: string, tmuxServerId: string | null): string {
  return crypto
    .createHash('sha256')
    .update(`${bootIdentity}\0${tmuxServerId || 'no-tmux'}`)
    .digest('hex');
}

export function detectEnvironmentChange(
  previous: EnvironmentIdentity | null | undefined,
  observed: ObservedEnvironment | null | undefined,
): EnvironmentChange {
  if (!observed || observed.status === 'unknown') return { status: 'unknown' };
  if (!previous) return { status: 'initial', current: observed };
  // Old macOS checkpoints used a wall-clock boot timestamp, which can drift during the same boot.
  // It cannot be compared with a boot session UUID. During migration the tmux generation is the
  // available continuity evidence; a replaced/missing tmux still produces a recoverable change below.
  const migratingMacIdentity = isLegacyMacBootIdentity(previous.bootIdentity)
    && MAC_BOOT_IDENTITY.test(observed.bootIdentity);
  if (!migratingMacIdentity && previous.bootIdentity !== observed.bootIdentity) {
    return { status: 'changed', reason: 'boot-changed', current: observed };
  }
  if (observed.status === 'absent') {
    return previous.tmuxServerId
      ? { status: 'changed', reason: 'tmux-changed', current: observed }
      : { status: 'unknown' };
  }
  if (!previous.tmuxServerId) return { status: 'attached', reason: 'same', current: observed };
  if (previous.tmuxServerId !== observed.tmuxServerId) return { status: 'changed', reason: 'tmux-changed', current: observed };
  return { status: 'same', reason: 'same', current: observed };
}

export function createBootIdentityProvider({
  platform = process.platform,
  readFile = fsp.readFile as ReadFile,
  exec = execFileAsync as ExecFile,
}: { platform?: string; readFile?: ReadFile; exec?: ExecFile } = {}): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    try {
      if (platform === 'linux') {
        const identity = String(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        return identity || null;
      }
      if (platform === 'darwin') {
        const identity = String((await exec('sysctl', ['-n', 'kern.bootsessionuuid'])).stdout).trim();
        return UUID.test(identity) ? `darwin:${identity.toLowerCase()}` : null;
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
}: {
  bootIdentityProvider?: () => Promise<unknown>;
  tmuxServerIdProvider?: () => Promise<unknown>;
} = {}): () => Promise<ObservedEnvironment> {
  return async (): Promise<ObservedEnvironment> => {
    try {
      const bootIdentity = await bootIdentityProvider();
      if (typeof bootIdentity !== 'string' || !bootIdentity) return { status: 'unknown' };
      const tmuxServerId = await tmuxServerIdProvider?.();
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
