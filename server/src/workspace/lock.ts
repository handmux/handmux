import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const OWNER_FILE = 'owner.json';
const SAFE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceLockOwner {
  pid: number;
  startedAt: string;
  operationId: string;
  token: string;
}
export interface WorkspaceLockHandle {
  owner: WorkspaceLockOwner;
  release(): Promise<void>;
}
interface OwnerRecord { value: unknown; mtimeMs: number }
const errorCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
);
const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ownerLabel(value: unknown): string {
  const owner = asRecord(value);
  if (!owner) return 'unknown owner';
  const operation = typeof owner.operationId === 'string' && owner.operationId ? owner.operationId : 'unknown operation';
  const pid = Number.isInteger(owner.pid) ? owner.pid : 'unknown';
  return `${operation} (pid ${pid})`;
}

export function createWorkspaceLock({
  dir,
  fs = fsp,
  pid = process.pid,
  now = Date.now,
  isProcessAlive = defaultProcessAlive,
  wait = delay,
  timeoutMs = 5_000,
  retryMs = 50,
  staleGraceMs = 5_000,
  randomUUID = crypto.randomUUID,
}: {
  dir: string;
  fs?: typeof fsp;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  wait?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  retryMs?: number;
  staleGraceMs?: number;
  randomUUID?: () => string;
}) {
  if (typeof dir !== 'string' || !dir) throw new Error('workspace lock directory is required');

  async function readOwner(): Promise<OwnerRecord | null> {
    let stat: Awaited<ReturnType<typeof fsp.stat>> | null = null;
    try { stat = await fs.stat(dir); } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const value = JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8'));
      return { value, mtimeMs: stat.mtimeMs };
    } catch {
      return { value: null, mtimeMs: stat.mtimeMs };
    }
  }

  async function reclaimIfStale(record: OwnerRecord | null): Promise<boolean> {
    if (!record) return true;
    const owner = asRecord(record.value);
    if (!owner || typeof owner.token !== 'string' || !SAFE_TOKEN.test(owner.token)) return false;
    const startedAt = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : Number.NaN;
    const age = now() - (Number.isFinite(startedAt) ? startedAt : record.mtimeMs);
    if (age < staleGraceMs) return false;
    if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && await isProcessAlive(owner.pid)) return false;

    // Every contender that observed this owner uses the SAME destination. The winner leaves the renamed
    // directory as a tombstone, so a loser cannot later rename a newly-created lock out of the way.
    const staleDir = `${dir}.stale.${owner.token}`;
    try {
      await fs.rename(dir, staleDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      return false;
    }
    return true;
  }

  async function tryAcquire({ operationId = 'workspace-writer' }: { operationId?: string } = {}): Promise<WorkspaceLockHandle | null> {
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      if (!SAFE_TOKEN.test(token)) throw new Error('workspace lock token must be a UUID');
      const owner = { pid, startedAt: new Date(now()).toISOString(), operationId, token };
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        try {
          await fs.writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
        } catch (error) {
          await fs.rm(dir, { recursive: true, force: true });
          throw error;
        }
        let released = false;
        return {
          owner,
          async release() {
            if (released) return;
            released = true;
            const current = await readOwner();
            if (asRecord(current?.value)?.token === token) await fs.rm(dir, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const record = await readOwner();
        if (!await reclaimIfStale(record)) return null;
      }
    }
    return null;
  }

  async function acquire(
    owner: { operationId?: string } = {},
    options: { timeoutMs?: number; retryMs?: number } = {},
  ): Promise<WorkspaceLockHandle> {
    const limit = options.timeoutMs ?? timeoutMs;
    const started = now();
    while (true) {
      const handle = await tryAcquire(owner);
      if (handle) return handle;
      const current = await readOwner();
      if (now() - started >= limit) {
        throw new Error(`workspace writer lock timed out; held by ${ownerLabel(current?.value)}`);
      }
      await wait(options.retryMs ?? retryMs);
    }
  }

  async function withLock<T>(
    owner: { operationId?: string },
    fn: (owner: WorkspaceLockOwner) => T | Promise<T>,
    options?: { timeoutMs?: number; retryMs?: number },
  ): Promise<T> {
    const handle = await acquire(owner, options);
    try { return await fn(handle.owner); } finally { await handle.release(); }
  }

  return { tryAcquire, acquire, withLock, readOwner: async () => (await readOwner())?.value ?? null };
}
