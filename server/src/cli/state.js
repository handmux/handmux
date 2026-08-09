// Runtime state lives in ~/.handmux/ — a single state.json (pids + the live public URL) plus a log
// file the detached supervisor writes to. `home` is injectable so this unit-tests in a temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { PrivateStateStore, ensurePrivateDirectorySync } from '../privateStateStore.js';

export function pocketHome(home = homedir()) { return path.join(home, '.handmux'); }
export function statePath(home) { return path.join(pocketHome(home), 'state.json'); }
export function lifecycleLockPath(home) { return path.join(pocketHome(home), 'lifecycle.lock'); }
export function logPath(home) { return path.join(pocketHome(home), 'handmux.log'); }
export function configPath(home) { return path.join(pocketHome(home), 'config.json'); }
export function supervisorConfigPath(home) { return path.join(pocketHome(home), 'supervisor-config.json'); }
export function codexOutboxPath(home) { return path.join(pocketHome(home), 'codex-outbox.json'); }

// The hook-maintained Claude state file, on a stable per-user path (survives a global reinstall, unlike
// the package-internal server/data default). The CLI sets this as CLAUDE_STATE_FILE for the server child
// and writes the same path into the hook's env, so both ends read/write one file.
export function claudeStatePath(home) { return path.join(pocketHome(home), 'claude-state.json'); }

// Push subscriptions and the dynamic-preview registry are mutable runtime data too, so they belong on the
// same stable per-user path — NOT the package-internal server/data default, which a `npm i -g handmux`
// reinstall replaces (silently dropping every saved subscription). The CLI injects these as PUSH_STORE /
// PREVIEW_STORE for the server child.
export function pushStorePath(home) { return path.join(pocketHome(home), 'push-subs.json'); }
export function previewStorePath(home) { return path.join(pocketHome(home), 'previews.json'); }
export function notificationsDirPath(home) { return path.join(pocketHome(home), 'notifications'); }

export function readState(home) {
  return new PrivateStateStore(statePath(home)).read();
}

export function readSupervisorConfig(home) {
  return new PrivateStateStore(supervisorConfigPath(home)).read();
}

export function writeSupervisorConfig(config, home) {
  new PrivateStateStore(supervisorConfigPath(home)).write(config);
}

// Atomic write (tmp + rename): the supervisor persist()s frequently while the CLI concurrently readState()s
// (waitAndPrint/status), so a plain writeFileSync could be caught mid-write and JSON.parse-fail — silently
// degrading to "not running". rename is atomic on the same filesystem, so a reader sees old or new, never torn.
export function writeState(state, home) {
  new PrivateStateStore(statePath(home)).write(state);
}

export function clearState(home) {
  new PrivateStateStore(statePath(home)).remove();
}

// pid liveness without sending a real signal: kill(pid, 0) throws ESRCH if dead, EPERM if alive but
// not ours (still counts as running).
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const LIFECYCLE_LOCK_STALE_MS = 10 * 60 * 1000;

// Cross-process mutex for start/stop/restart/service operations. `wx` is atomic even when two shells run
// start at exactly the same time. A killed CLI leaves a tiny stale file; its dead owner is detected and
// reclaimed on the next operation. The release closure only removes a lock still owned by this process.
export function acquireLifecycleLock(home, pid = process.pid) {
  ensurePrivateDirectorySync(pocketHome(home));
  const file = lifecycleLockPath(home);
  const stamp = JSON.stringify({ pid, createdAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, stamp, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === stamp) fs.unlinkSync(file);
        } catch { /* already gone/replaced */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = 0, createdAt = 0;
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const parsed = JSON.parse(raw);
        owner = Number(parsed.pid);
        createdAt = Number(parsed.createdAt);
      } catch { /* malformed/legacy → stale unless its plain pid is live */
        try { owner = Number(fs.readFileSync(file, 'utf8').trim()); } catch { /* stale */ }
      }
      const fresh = !createdAt || (Date.now() - createdAt) < LIFECYCLE_LOCK_STALE_MS;
      if (owner && fresh && isAlive(owner)) {
        const err = new Error(`lifecycle operation already running (pid ${owner})`);
        err.ownerPid = owner;
        throw err;
      }
      try { fs.unlinkSync(file); } catch { /* raced with another contender */ }
    }
  }
  throw new Error('could not acquire lifecycle lock');
}
