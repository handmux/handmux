// Update notifier for the globally-installed `handmux` CLI. There is NO self-updating server: the notice
// is a hint, the upgrade is a plain `npm i -g handmux@latest` (the `handmux update` command runs that for
// you). Two rules keep it unobtrusive and China-friendly:
//   1. The hot path (start/status) NEVER touches the network — it prints from a cached "latest version"
//      and, only if that cache is stale, spawns a DETACHED background worker to refresh it. So the first
//      run after a new release is what surfaces it; the command itself is never delayed or blocked.
//   2. The version query goes through the user's own npm (`npm view handmux version`), so it honours a
//      configured China mirror / private registry instead of hard-coding registry.npmjs.org. Any failure
//      (offline, blocked, npm missing) is swallowed — the notifier is best-effort, never an error.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pocketHome } from './state.js';
import { t } from './i18n/index.js';
import { PrivateStateStore } from '../privateStateStore.js';

export const PKG_NAME = 'handmux';
export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // refresh the cached "latest" at most once an hour

// A Homebrew-installed handmux lives under the Cellar (…/Cellar/handmux/<ver>/…, symlinked from the brew
// prefix's bin), or under a linuxbrew prefix. For such installs `handmux update` must NOT `npm i -g` over
// itself — that plants a second, conflicting copy that brew can't see or upgrade — and the "how to upgrade"
// hint must point at `brew upgrade` instead. Detect the source from the (real, symlink-resolved) entry path.
export function isBrewInstall(selfPath = '') { return /\/(Cellar|homebrew)\//.test(selfPath); }

export function updateCachePath(home) { return path.join(pocketHome(home), 'update-check.json'); }

export function readCache(home) {
  return new PrivateStateStore(updateCachePath(home)).read();
}

export function writeCache(home, obj) {
  try { new PrivateStateStore(updateCachePath(home)).write(obj); }
  catch { /* best effort — a missing cache just means we re-check next time */ }
}

// "1.2.3" → [1,2,3]; a prerelease/build tail (`-rc.1`, `+meta`) is ignored. null if unparseable.
function parts(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// -1 / 0 / 1 by numeric major.minor.patch. Unparseable inputs compare equal (→ no false "upgrade").
export function compareVersions(a, b) {
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function isNewer(latest, current) { return compareVersions(latest, current) > 0; }

export function shouldRefresh(cache, now = Date.now(), interval = CHECK_INTERVAL_MS) {
  return !cache || typeof cache.checkedAt !== 'number' || (now - cache.checkedAt) > interval;
}

// ONE npm call fetches both the latest version AND its concise `whatsNew` highlights (the published
// package.json field release.sh mirrors from the changelog), so the phone can show "what's new" BEFORE
// upgrading — sourced through the user's own npm, so it stays China-mirror-friendly. `@latest` + `--json`
// makes npm return an object keyed by field: {"version":"0.9.1","whatsNew":[{version,date,zh,en},…]}.
export const VIEW_ARGS = ['view', `${PKG_NAME}@latest`, 'version', 'whatsNew', '--json'];

// Parse that JSON into { latest, whatsNew }. `latest` is null unless it's a real version; `whatsNew` is
// null unless it's an array (old published versions predate the field). Never throws.
export function parseView(stdout) {
  try {
    const o = JSON.parse(String(stdout));
    const v = String(o.version || '').trim();
    return { latest: parts(v) ? v : null, whatsNew: Array.isArray(o.whatsNew) ? o.whatsNew : null };
  } catch { return { latest: null, whatsNew: null }; }
}

// Query the latest version + highlights via the user's own npm (honours their registry/mirror). Hard
// timeout; any non-zero exit, empty/garbled output, or thrown error → { latest:null, whatsNew:null }.
export function fetchLatest({ timeoutMs = 4000, run = spawnSync } = {}) {
  try {
    const r = run('npm', VIEW_ARGS, { timeout: timeoutMs, encoding: 'utf8' });
    if (!r || r.status !== 0 || !r.stdout) return { latest: null, whatsNew: null };
    return parseView(r.stdout);
  } catch { return { latest: null, whatsNew: null }; }
}

// Merge a fetch result over the prior cache: on a failed field keep the previously-known value, so a flaky
// network never blanks out a good `latest`/`whatsNew`. Always stamps `checkedAt`.
function mergedCache(home, now, { latest, whatsNew }) {
  const prev = readCache(home);
  return { checkedAt: now, latest: latest ?? prev?.latest ?? null, whatsNew: whatsNew ?? prev?.whatsNew ?? null };
}

// Non-blocking refresh for the long-running server: query npm asynchronously (never stalls the event loop
// the way the CLI's spawnSync path would) and persist the same cache the CLI reads. The /api/version route
// calls this when the cache is stale, so the phone opening the app keeps `latest`/`whatsNew` current without
// the user re-running the CLI. Best-effort: npm missing/offline/blocked leaves the prior values.
export function refreshLatestAsync(home, { now = Date.now(), spawnFn = spawn, timeoutMs = 4000 } = {}) {
  try {
    const child = spawnFn('npm', VIEW_ARGS, { timeout: timeoutMs });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      writeCache(home, mergedCache(home, now, code === 0 ? parseView(out) : { latest: null, whatsNew: null }));
    });
    child.on('error', () => { /* npm missing/offline — leave the cache untouched */ });
  } catch { /* best effort */ }
}

// The hidden `__update-check` worker (runs detached, prints nothing): refresh the cache. On a failed fetch
// keep the previously-known values but still stamp checkedAt, so a flaky network doesn't re-spawn every run.
export function runUpdateCheck(home, { now = Date.now(), ...opts } = {}) {
  writeCache(home, mergedCache(home, now, fetchLatest(opts)));
}

// Fire-and-forget notifier for a foreground command. Prints an upgrade line straight from the cache (no
// network on this path), then — if the cache is stale — kicks off a detached refresh so the NEXT run is
// current. Returns true if a notice was printed (handy for tests). `selfPath` is the CLI entry so the
// background worker re-invokes this same binary.
export function notifyUpdate(home, { version, selfPath, now = Date.now(), log = console.log, spawnFn = spawn } = {}) {
  const cache = readCache(home);
  let shown = false;
  if (cache && cache.latest && isNewer(cache.latest, version)) {
    log('');
    log(t('update.available', { current: version, latest: cache.latest }));
    log(t(isBrewInstall(selfPath) ? 'update.howBrew' : 'update.how'));
    shown = true;
  }
  if (selfPath && shouldRefresh(cache, now)) {
    try {
      const child = spawnFn(process.execPath, [selfPath, '__update-check'], { detached: true, stdio: 'ignore' });
      child.unref?.();
    } catch { /* best effort */ }
  }
  return shown;
}
