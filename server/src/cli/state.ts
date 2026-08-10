// Runtime state lives in ~/.handmux/ — a single state.json (pids + the live public URL) plus a log
// file the detached supervisor writes to. `home` is injectable so this unit-tests in a temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { PrivateStateStore, ensurePrivateDirectorySync } from '../privateStateStore.js';

export interface StoredState extends Record<string, unknown> {
  supervisorPid?: number;
  version?: string;
  tunnel?: string;
  port?: number;
  host?: string;
  token?: string;
  localUrl?: string;
  lanUrl?: string | null;
  publicUrl?: string | null;
  ready?: boolean;
  serverPid?: number | null;
  tunnelPid?: number | null;
  error?: string | null;
}

const isRecord = (value: unknown): value is StoredState =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export function pocketHome(home: string = homedir()): string { return path.join(home, '.handmux'); }
export function statePath(home: string): string { return path.join(pocketHome(home), 'state.json'); }
export function lifecycleLockPath(home: string): string { return path.join(pocketHome(home), 'lifecycle.lock'); }
export function logPath(home: string): string { return path.join(pocketHome(home), 'handmux.log'); }
export function configPath(home: string): string { return path.join(pocketHome(home), 'config.json'); }
export function supervisorConfigPath(home: string): string { return path.join(pocketHome(home), 'supervisor-config.json'); }
export function codexOutboxPath(home: string): string { return path.join(pocketHome(home), 'codex-outbox.json'); }

// The hook-maintained Claude state file, on a stable per-user path (survives a global reinstall, unlike
// the package-internal server/data default). The CLI sets this as CLAUDE_STATE_FILE for the server child
// and writes the same path into the hook's env, so both ends read/write one file.
export function claudeStatePath(home: string): string { return path.join(pocketHome(home), 'claude-state.json'); }

// Push subscriptions and the dynamic-preview registry are mutable runtime data too, so they belong on the
// same stable per-user path — NOT the package-internal server/data default, which a `npm i -g handmux`
// reinstall replaces (silently dropping every saved subscription). The CLI injects these as PUSH_STORE /
// PREVIEW_STORE for the server child.
export function pushStorePath(home: string): string { return path.join(pocketHome(home), 'push-subs.json'); }
export function previewStorePath(home: string): string { return path.join(pocketHome(home), 'previews.json'); }
export function notificationsDirPath(home: string): string { return path.join(pocketHome(home), 'notifications'); }

export function readState(home: string): StoredState | null {
  const value = new PrivateStateStore<unknown>(statePath(home)).read();
  return isRecord(value) ? value : null;
}

export function readSupervisorConfig(home: string): StoredState | null {
  const value = new PrivateStateStore<unknown>(supervisorConfigPath(home)).read();
  return isRecord(value) ? value : null;
}

export function writeSupervisorConfig(config: unknown, home: string): void {
  new PrivateStateStore<unknown>(supervisorConfigPath(home)).write(config);
}

// Atomic write (tmp + rename): the supervisor persist()s frequently while the CLI concurrently readState()s
// (waitAndPrint/status), so a plain writeFileSync could be caught mid-write and JSON.parse-fail — silently
// degrading to "not running". rename is atomic on the same filesystem, so a reader sees old or new, never torn.
export function writeState(state: unknown, home: string): void {
  new PrivateStateStore<unknown>(statePath(home)).write(state);
}

export function clearState(home: string): void {
  new PrivateStateStore<unknown>(statePath(home)).remove();
}

// pid liveness without sending a real signal: kill(pid, 0) throws ESRCH if dead, EPERM if alive but
// not ours (still counts as running).
export function isAlive(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return errorCode(e) === 'EPERM'; }
}

const LIFECYCLE_LOCK_STALE_MS = 10 * 60 * 1000;

// Cross-process mutex for start/stop/restart/service operations. `wx` is atomic even when two shells run
// start at exactly the same time. A killed CLI leaves a tiny stale file; its dead owner is detected and
// reclaimed on the next operation. The release closure only removes a lock still owned by this process.
export function acquireLifecycleLock(home: string, pid: number = process.pid): () => void {
  ensurePrivateDirectorySync(pocketHome(home));
  const file = lifecycleLockPath(home);
  const stamp = JSON.stringify({ pid, createdAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, stamp, { flag: 'wx', mode: 0o600 });
      return (): void => {
        try {
          if (fs.readFileSync(file, 'utf8') === stamp) fs.unlinkSync(file);
        } catch { /* already gone/replaced */ }
      };
    } catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e;
      let owner = 0, createdAt = 0;
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          owner = Number(parsed.pid);
          createdAt = Number(parsed.createdAt);
        }
      } catch { /* malformed/legacy → stale unless its plain pid is live */
        try { owner = Number(fs.readFileSync(file, 'utf8').trim()); } catch { /* stale */ }
      }
      const fresh = !createdAt || (Date.now() - createdAt) < LIFECYCLE_LOCK_STALE_MS;
      if (owner && fresh && isAlive(owner)) {
        const err = Object.assign(new Error(`lifecycle operation already running (pid ${owner})`), { ownerPid: owner });
        throw err;
      }
      try { fs.unlinkSync(file); } catch { /* raced with another contender */ }
    }
  }
  throw new Error('could not acquire lifecycle lock');
}
