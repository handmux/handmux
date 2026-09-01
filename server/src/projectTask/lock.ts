import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProjectTaskError } from './schema.js';

const OWNER_FILE = 'owner.json';

interface LockOwner {
  pid: number;
  startedAt: string;
  token: string;
}

export interface ProjectStoreLockHandle {
  owner: LockOwner;
  release(): Promise<void>;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function validOwner(value: unknown): LockOwner | null {
  if (!value || typeof value !== 'object') return null;
  const owner = value as Partial<LockOwner>;
  if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) < 1) return null;
  if (typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) return null;
  if (typeof owner.token !== 'string' || !owner.token) return null;
  return owner as LockOwner;
}

export function createProjectStoreLock({
  dir,
  fs = fsp,
  pid = process.pid,
  now = Date.now,
  isProcessAlive = processAlive,
  randomUUID = crypto.randomUUID,
  staleGraceMs = 5_000,
}: {
  dir: string;
  fs?: typeof fsp;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  randomUUID?: () => string;
  staleGraceMs?: number;
}) {
  async function readOwner(): Promise<{ owner: LockOwner | null; mtimeMs: number } | null> {
    try {
      const stat = await fs.stat(dir);
      let owner: LockOwner | null = null;
      try { owner = validOwner(JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8'))); } catch {}
      return { owner, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async function reclaimStale(observed: Awaited<ReturnType<typeof readOwner>>): Promise<boolean> {
    if (!observed) return true;
    const startedAt = observed.owner ? Date.parse(observed.owner.startedAt) : observed.mtimeMs;
    if (now() - startedAt < staleGraceMs) return false;
    if (observed.owner && await isProcessAlive(observed.owner.pid)) return false;
    const suffix = observed.owner?.token ?? randomUUID();
    try {
      await fs.rename(dir, `${dir}.stale.${suffix}`);
      return true;
    } catch (error) {
      return errorCode(error) === 'ENOENT';
    }
  }

  async function acquire(): Promise<ProjectStoreLockHandle> {
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const owner: LockOwner = { pid, startedAt: new Date(now()).toISOString(), token: randomUUID() };
      try {
        await fs.mkdir(dir, { mode: 0o700 });
        try {
          await fs.writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
            mode: 0o600,
            flag: 'wx',
          });
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
            if (current?.owner?.token === owner.token) {
              await fs.rm(dir, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const observed = await readOwner();
        if (await reclaimStale(observed)) continue;
        const pidLabel = observed?.owner?.pid ? ` (pid ${observed.owner.pid})` : '';
        throw new ProjectTaskError(
          'PROJECT_STORE_LOCKED',
          503,
          `Project data is open in another HandMux instance${pidLabel}; close it and try again`,
        );
      }
    }
    throw new ProjectTaskError(
      'PROJECT_STORE_LOCKED',
      503,
      'Project data lock changed while starting; try again',
    );
  }

  return { acquire, readOwner: async () => (await readOwner())?.owner ?? null };
}
