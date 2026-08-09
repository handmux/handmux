import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareVersions, isNewer, shouldRefresh, fetchLatest, parseView, VIEW_ARGS,
  readCache, writeCache, updateCachePath, runUpdateCheck, notifyUpdate,
  refreshLatestAsync, CHECK_INTERVAL_MS, isBrewInstall,
} from '../src/cli/updateCheck.js';
import { tmpHome } from './tmphome.js';

// A fake async child: `stdout` streams the given output, then `close` fires with the exit code.
function fakeChild(out, code) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  queueMicrotask(() => {
    if (out != null) child.stdout.emit('data', out);
    child.emit('close', code);
  });
  return child;
}

// npm view now returns JSON ({version, whatsNew}); helpers build that stdout for the sync/async paths.
const viewJson = (obj) => JSON.stringify(obj);
const okRun = (obj) => () => ({ status: 0, stdout: viewJson(obj) });
const WN = [{ version: '2.0.0', date: '2026-07-10', zh: '新功能', en: 'New thing' }];

describe('compareVersions / isNewer', () => {
  it('orders by major.minor.patch', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });
  it('ignores prerelease/build tails and a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
  });
  it('unparseable inputs compare equal (no false upgrade)', () => {
    expect(compareVersions('latest', '1.2.3')).toBe(0);
    expect(isNewer('garbage', '1.2.3')).toBe(false);
  });
  it('isNewer is strict greater-than', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.2', '1.2.3')).toBe(false);
  });
});

describe('shouldRefresh', () => {
  it('refreshes when there is no cache or no timestamp', () => {
    expect(shouldRefresh(null)).toBe(true);
    expect(shouldRefresh({ latest: '1.0.0' })).toBe(true);
  });
  it('respects the interval', () => {
    const now = 1_000_000_000;
    expect(shouldRefresh({ checkedAt: now, latest: '1.0.0' }, now)).toBe(false);
    expect(shouldRefresh({ checkedAt: now - CHECK_INTERVAL_MS - 1, latest: '1.0.0' }, now)).toBe(true);
  });
});

describe('parseView', () => {
  it('extracts a real version + whatsNew array', () => {
    expect(parseView(viewJson({ version: '1.4.2', whatsNew: WN }))).toEqual({ latest: '1.4.2', whatsNew: WN });
  });
  it('whatsNew is null when absent or not an array; latest null when not a version', () => {
    expect(parseView(viewJson({ version: '1.4.2' }))).toEqual({ latest: '1.4.2', whatsNew: null });
    expect(parseView(viewJson({ version: 'nope', whatsNew: WN }))).toEqual({ latest: null, whatsNew: WN });
    expect(parseView('not json')).toEqual({ latest: null, whatsNew: null });
  });
});

describe('fetchLatest', () => {
  it('returns { latest, whatsNew } on success', () => {
    expect(fetchLatest({ run: okRun({ version: '1.4.2', whatsNew: WN }) })).toEqual({ latest: '1.4.2', whatsNew: WN });
  });
  it('returns nulls on non-zero exit, empty output, garbage, or throw', () => {
    expect(fetchLatest({ run: () => ({ status: 1, stdout: '' }) })).toEqual({ latest: null, whatsNew: null });
    expect(fetchLatest({ run: () => ({ status: 0, stdout: '' }) })).toEqual({ latest: null, whatsNew: null });
    expect(fetchLatest({ run: () => ({ status: 0, stdout: 'not-a-version' }) })).toEqual({ latest: null, whatsNew: null });
    expect(fetchLatest({ run: () => { throw new Error('ENOENT'); } })).toEqual({ latest: null, whatsNew: null });
  });
  it('queries version + whatsNew via npm@latest --json with the given timeout', () => {
    const run = vi.fn(() => ({ status: 0, stdout: viewJson({ version: '1.0.0' }) }));
    fetchLatest({ run, timeoutMs: 1234 });
    expect(run).toHaveBeenCalledWith('npm', VIEW_ARGS, expect.objectContaining({ timeout: 1234 }));
    expect(VIEW_ARGS).toEqual(['view', 'handmux@latest', 'version', 'whatsNew', '--json']);
  });
});

describe('cache round-trip', () => {
  it('reads back what it writes; missing/garbage → null', () => {
    const home = tmpHome('upd-');
    expect(readCache(home)).toBeNull();
    writeCache(home, { checkedAt: 5, latest: '9.9.9', whatsNew: WN });
    expect(readCache(home)).toEqual({ checkedAt: 5, latest: '9.9.9', whatsNew: WN });
    expect(fs.statSync(path.join(home, '.handmux')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(updateCachePath(home)).mode & 0o777).toBe(0o600);
    fs.writeFileSync(updateCachePath(home), 'not json');
    expect(readCache(home)).toBeNull();
  });
});

describe('runUpdateCheck', () => {
  it('stamps the fetched latest + whatsNew', () => {
    const home = tmpHome('upd-');
    runUpdateCheck(home, { now: 42, run: okRun({ version: '2.0.0', whatsNew: WN }) });
    expect(readCache(home)).toEqual({ checkedAt: 42, latest: '2.0.0', whatsNew: WN });
  });
  it('keeps the previously-known latest AND whatsNew when the fetch fails', () => {
    const home = tmpHome('upd-');
    writeCache(home, { checkedAt: 1, latest: '1.5.0', whatsNew: WN });
    runUpdateCheck(home, { now: 99, run: () => ({ status: 1, stdout: '' }) });
    expect(readCache(home)).toEqual({ checkedAt: 99, latest: '1.5.0', whatsNew: WN });
  });
});

describe('isBrewInstall', () => {
  it('detects Homebrew (Cellar) and linuxbrew paths', () => {
    expect(isBrewInstall('/opt/homebrew/Cellar/handmux/0.14.0/libexec/bin/handmux.js')).toBe(true);
    expect(isBrewInstall('/usr/local/Cellar/handmux/0.14.0/libexec/bin/handmux.js')).toBe(true);
    expect(isBrewInstall('/home/linuxbrew/.linuxbrew/Cellar/handmux/0.14.0/x')).toBe(true);
  });
  it('is false for a plain npm global install', () => {
    expect(isBrewInstall('/usr/local/lib/node_modules/handmux/server/bin/handmux.js')).toBe(false);
    expect(isBrewInstall('/Users/me/.nvm/versions/node/v22/lib/node_modules/handmux/x')).toBe(false);
    expect(isBrewInstall('')).toBe(false);
  });
});

describe('notifyUpdate', () => {
  // Bare `brew upgrade handmux` (not the tap-qualified name) is deliberate: verified against real Homebrew
  // to resolve a tap-installed formula AND to keep working after an eventual move into homebrew-core, so the
  // hint never needs revisiting. The tap prefix is only required for `brew install`, never `brew upgrade`.
  it('routes the upgrade hint to `brew upgrade handmux` for a brew install', () => {
    const home = tmpHome('upd-');
    writeCache(home, { checkedAt: Date.now(), latest: '3.0.0' });
    const log = vi.fn();
    const selfPath = '/opt/homebrew/Cellar/handmux/2.9.0/libexec/bin/handmux.js';
    notifyUpdate(home, { version: '2.9.0', selfPath, now: Date.now(), log, spawnFn: () => ({ unref() {} }) });
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('brew upgrade handmux');
    expect(out).not.toContain('brew upgrade handmux/tap/handmux'); // bare name, not tap-qualified
    expect(out).not.toContain('npm i -g');
  });

  it('prints an upgrade notice when the cache is newer than the running version', () => {
    const home = tmpHome('upd-');
    writeCache(home, { checkedAt: Date.now(), latest: '3.0.0' });
    const log = vi.fn();
    const spawnFn = vi.fn(() => ({ unref() {} }));
    const shown = notifyUpdate(home, { version: '2.9.0', selfPath: '/x/handmux.js', now: Date.now(), log, spawnFn });
    expect(shown).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain('3.0.0');
    expect(spawnFn).not.toHaveBeenCalled(); // fresh cache → no background refresh
  });

  it('prints nothing when up to date, and refreshes in the background when stale', () => {
    const home = tmpHome('upd-');
    writeCache(home, { checkedAt: 0, latest: '1.0.0' }); // stale
    const log = vi.fn();
    const spawnFn = vi.fn(() => ({ unref() {} }));
    const shown = notifyUpdate(home, { version: '1.0.0', selfPath: '/x/handmux.js', now: Date.now(), log, spawnFn });
    expect(shown).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnFn.mock.calls[0];
    expect(args).toEqual(['/x/handmux.js', '__update-check']);
    expect(opts).toMatchObject({ detached: true });
  });

  it('does not spawn a refresh without a selfPath', () => {
    const home = tmpHome('upd-');
    const spawnFn = vi.fn(() => ({ unref() {} }));
    notifyUpdate(home, { version: '1.0.0', now: Date.now(), log: () => {}, spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('refreshLatestAsync (server, non-blocking)', () => {
  it('writes the fetched latest + whatsNew + timestamp on success', async () => {
    const home = tmpHome('upd-');
    const spawnFn = vi.fn(() => fakeChild(viewJson({ version: '1.2.4', whatsNew: WN }), 0));
    refreshLatestAsync(home, { now: 5000, spawnFn });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawnFn).toHaveBeenCalledWith('npm', VIEW_ARGS, expect.objectContaining({ timeout: 4000 }));
    expect(readCache(home)).toEqual({ checkedAt: 5000, latest: '1.2.4', whatsNew: WN });
  });

  it('keeps the previously-known latest + whatsNew when the query fails', async () => {
    const home = tmpHome('upd-');
    writeCache(home, { checkedAt: 0, latest: '1.0.0', whatsNew: WN });
    refreshLatestAsync(home, { now: 9000, spawnFn: () => fakeChild('', 1) });
    await new Promise((r) => setTimeout(r, 0));
    expect(readCache(home)).toEqual({ checkedAt: 9000, latest: '1.0.0', whatsNew: WN });
  });

  it('never throws when npm is missing (spawn error)', async () => {
    const home = tmpHome('upd-');
    const spawnFn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); queueMicrotask(() => c.emit('error', new Error('ENOENT'))); return c; };
    expect(() => refreshLatestAsync(home, { now: 1, spawnFn })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
