import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOK_EVENTS, HOOK_EVENTS_EXT, mergeHooks, stripHooks, hooksStatus, installHooks, uninstallHooks, syncHooks,
  parseClaudeVersion, claudeVersionAtLeast, detectClaudeVersion,
} from '../src/cli/claudeHooks.js';

const V = (s) => parseClaudeVersion(s); // "2.1.207" → { major, minor, patch }

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks');

const DEST = '/home/x/.claude/hooks/handmux-notify.sh';

function hasHook(settings, event) {
  return (settings.hooks?.[event] || []).some(
    (g) => (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('handmux-notify.sh')),
  );
}

describe('HOOK_EVENTS', () => {
  it('declares the seven lifecycle events with the right src + matcher', () => {
    const byEvent = Object.fromEntries(HOOK_EVENTS.map((e) => [e.event, e]));
    expect(byEvent.Stop.src).toBe('stop');
    expect(byEvent.Notification.src).toBe('notify');
    expect(byEvent.UserPromptSubmit.src).toBe('prompt');
    expect(byEvent.SessionStart.src).toBe('start');
    expect(byEvent.SessionEnd.src).toBe('end');
    expect(byEvent.PostToolUse.src).toBe('resume');
    expect(byEvent.PostToolUse.matcher).toBe('AskUserQuestion|ExitPlanMode');
    expect(byEvent.PermissionRequest.src).toBe('permreq');
    // only PostToolUse carries a matcher
    expect(HOOK_EVENTS.filter((e) => e.matcher).map((e) => e.event)).toEqual(['PostToolUse']);
  });
});

describe('mergeHooks', () => {
  it('registers all seven events pointing at the dest script with src args', () => {
    const out = mergeHooks({}, DEST);
    for (const ev of ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PostToolUse', 'PermissionRequest']) {
      expect(hasHook(out, ev), ev).toBe(true);
    }
    const cmd = (ev) => out.hooks[ev].flatMap((g) => g.hooks).map((h) => h.command).join(' ');
    expect(cmd('UserPromptSubmit')).toBe(`${DEST} prompt`);
    expect(cmd('SessionStart')).toBe(`${DEST} start`);
    expect(cmd('PostToolUse')).toBe(`${DEST} resume`);
    expect(out.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion|ExitPlanMode');
    expect(out.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 5 });
  });

  it('is idempotent — merging twice does not duplicate groups', () => {
    const once = mergeHooks({}, DEST);
    const twice = mergeHooks(once, DEST);
    expect(twice.hooks.UserPromptSubmit).toHaveLength(1);
    expect(twice.hooks.PostToolUse).toHaveLength(1);
  });

  it('preserves the user’s unrelated hooks and settings', () => {
    const existing = {
      model: 'opus',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] },
    };
    const out = mergeHooks(existing, DEST);
    expect(out.model).toBe('opus');
    // our Stop hook is added alongside, the user's is kept
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command === '/my/other.sh'))).toBe(true);
    expect(hasHook(out, 'Stop')).toBe(true);
  });

  it('tolerates a malformed hooks field (array) by replacing it with an object', () => {
    const out = mergeHooks({ hooks: [] }, DEST);
    expect(hasHook(out, 'Stop')).toBe(true);
  });

  it('repairs malformed managed event groups without crashing or erasing unrelated malformed fields', () => {
    const out = mergeHooks({ hooks: { Stop: 'broken', Notification: [null, { hooks: 'bad' }], Custom: 42 } }, DEST);
    expect(Array.isArray(out.hooks.Stop)).toBe(true);
    expect(out.hooks.Stop.at(-1).hooks[0].command).toBe(`${DEST} stop`);
    expect(out.hooks.Notification.at(-1).hooks[0].command).toBe(`${DEST} notify`);
    expect(out.hooks.Custom).toBe(42);
    expect(stripHooks({ hooks: { Custom: 42 } }).hooks.Custom).toBe(42);
  });
});

describe('Claude version detection (fail-closed gating input)', () => {
  it('parseClaudeVersion reads X.Y.Z out of the --version banner', () => {
    expect(parseClaudeVersion('2.1.207 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 207 });
    expect(parseClaudeVersion('garbage')).toBeNull();
    expect(parseClaudeVersion('')).toBeNull();
  });
  it('claudeVersionAtLeast compares full major.minor.patch; null is always below', () => {
    expect(claudeVersionAtLeast(V('2.1.207'), '2.1.207')).toBe(true);
    expect(claudeVersionAtLeast(V('2.1.208'), '2.1.207')).toBe(true);
    expect(claudeVersionAtLeast(V('2.2.0'), '2.1.207')).toBe(true);
    expect(claudeVersionAtLeast(V('2.1.100'), '2.1.207')).toBe(false);
    expect(claudeVersionAtLeast(V('1.9.999'), '2.1.207')).toBe(false);
    expect(claudeVersionAtLeast(null, '2.1.207')).toBe(false);
  });
  it('detectClaudeVersion parses a good run, and returns null on failure/throw (→ no ext hooks)', () => {
    expect(detectClaudeVersion(() => ({ status: 0, stdout: '2.1.207 (Claude Code)' }))).toEqual({ major: 2, minor: 1, patch: 207 });
    expect(detectClaudeVersion(() => ({ status: 1, stdout: '' }))).toBeNull();
    expect(detectClaudeVersion(() => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('mergeHooks — version-gated ext events (compact pair + StopFailure)', () => {
  const EXT = ['PostCompact', 'PreCompact', 'StopFailure'];

  it('the ext table pairs PreCompact with its clearer PostCompact, declared AFTER it', () => {
    const pre = HOOK_EVENTS_EXT.find((e) => e.event === 'PreCompact');
    expect(pre.pairWith).toBe('PostCompact');
    const iPost = HOOK_EVENTS_EXT.findIndex((e) => e.event === 'PostCompact');
    const iPre = HOOK_EVENTS_EXT.findIndex((e) => e.event === 'PreCompact');
    expect(iPost).toBeLessThan(iPre); // PostCompact must be enabled first for the pairing check to see it
  });

  it('installs the ext events on a new-enough Claude, with the right src args', () => {
    const out = mergeHooks({}, DEST, V('2.1.207'));
    for (const ev of EXT) expect(hasHook(out, ev), ev).toBe(true);
    const cmd = (ev) => out.hooks[ev].flatMap((g) => g.hooks).map((h) => h.command).join(' ');
    expect(cmd('PreCompact')).toBe(`${DEST} compacting`);
    expect(cmd('PostCompact')).toBe(`${DEST} compact`);
    expect(cmd('StopFailure')).toBe(`${DEST} stopfail`);
  });

  it('writes NONE of the ext events on an older Claude (pure downgrade)', () => {
    const out = mergeHooks({}, DEST, V('2.1.100'));
    for (const ev of EXT) expect(hasHook(out, ev), ev).toBe(false);
    expect(hasHook(out, 'Stop')).toBe(true); // the base (non-gated) events are always present
  });

  it('fail-closed: a null (undetectable) version writes no ext events', () => {
    const out = mergeHooks({}, DEST, null);
    for (const ev of EXT) expect(hasHook(out, ev), ev).toBe(false);
    expect(hasHook(out, 'UserPromptSubmit')).toBe(true);
  });

  it('PRUNES our ext events if Claude is downgraded after a newer install (no lingering unknown event)', () => {
    const newer = mergeHooks({}, DEST, V('2.1.207'));            // ext installed
    expect(hasHook(newer, 'PostCompact')).toBe(true);
    const downgraded = mergeHooks(newer, DEST, V('2.1.100'));    // re-run on an older Claude
    for (const ev of EXT) expect(hasHook(downgraded, ev), ev).toBe(false);
    expect(downgraded.hooks.PostCompact).toBeUndefined();        // emptied group dropped entirely
    expect(hasHook(downgraded, 'Stop')).toBe(true);              // base six untouched
  });

  it('is idempotent on the ext events too', () => {
    const once = mergeHooks({}, DEST, V('2.1.207'));
    const twice = mergeHooks(once, DEST, V('2.1.207'));
    for (const ev of EXT) expect(twice.hooks[ev]).toHaveLength(1);
  });
});

describe('stripHooks', () => {
  it('removes only our hooks, keeping the user’s', () => {
    const merged = mergeHooks({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] } }, DEST);
    const out = stripHooks(merged);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command === '/my/other.sh'))).toBe(true);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes('handmux-notify.sh')))).toBe(false);
    // an event that becomes empty is dropped entirely
    expect(out.hooks.PermissionRequest).toBeUndefined();
  });

  it('is a no-op when there are no hooks of ours', () => {
    const out = stripHooks({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] } });
    expect(out.hooks.Stop).toHaveLength(1);
  });
});

describe('hooksStatus', () => {
  function homeWith(settings) {
    const home = tmpHome('twhk-');
    if (settings !== undefined) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(settings));
    }
    return home;
  }

  it('no-claude when ~/.claude is absent', () => {
    const home = tmpHome('twhk-');
    expect(hooksStatus(home)).toBe('no-claude');
  });

  it('absent when ~/.claude exists but settings has no hook of ours', () => {
    expect(hooksStatus(homeWith({}))).toBe('absent');
    expect(hooksStatus(homeWith({ hooks: { Stop: [{ hooks: [{ command: '/x.sh' }] }] } }))).toBe('absent');
  });

  it('installed when settings has our hook', () => {
    const home = homeWith(mergeHooks({}, '/home/x/.claude/hooks/handmux-notify.sh'));
    expect(hooksStatus(home)).toBe('installed');
  });
});

describe('installHooks / uninstallHooks (IO)', () => {
  it('copies the scripts, writes the env, merges settings, then strips clean', () => {
    const home = tmpHome('twhk-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });   // simulate a Claude Code user
    const stateFile = path.join(home, '.handmux/claude-state.json');
    const hooksDir = path.join(home, '.claude/hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'handmux-codex-usage.cjs'), 'legacy');

    const res = installHooks(home, { srcDir: SRC_DIR, stateFile });
    expect(res.status).toBe('installed');

    expect(fs.existsSync(path.join(hooksDir, 'handmux-notify.sh'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-write.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-codex-usage.cjs'))).toBe(false);
    expect(fs.readFileSync(path.join(hooksDir, 'handmux-notify.env'), 'utf8')).toContain(`HANDMUX_STATE=${stateFile}`);
    expect(hooksStatus(home)).toBe('installed');

    // the registered command points at the COPIED script in ~/.claude/hooks
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${path.join(hooksDir, 'handmux-notify.sh')} stop`);

    uninstallHooks(home);
    expect(hooksStatus(home)).toBe('absent');
    expect(fs.existsSync(path.join(hooksDir, 'handmux-notify.sh'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-notify.env'))).toBe(false);
  });

  it('gates the ext events on the injected Claude version (new → present, null → base-only)', () => {
    const mk = () => { const h = tmpHome('twhk-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; };
    const read = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8'));

    const newer = mk();
    installHooks(newer, { srcDir: SRC_DIR, stateFile: path.join(newer, '.handmux/s.json'), claudeVersion: { major: 2, minor: 1, patch: 207 } });
    expect(hasHook(read(newer), 'PostCompact')).toBe(true);
    expect(hasHook(read(newer), 'StopFailure')).toBe(true);

    const old = mk();
    installHooks(old, { srcDir: SRC_DIR, stateFile: path.join(old, '.handmux/s.json'), claudeVersion: null });
    expect(hasHook(read(old), 'PostCompact')).toBe(false);
    expect(hasHook(read(old), 'Stop')).toBe(true); // base (non-gated) events still installed
  });

  it('refuses to install when ~/.claude is absent (returns no-claude, creates nothing)', () => {
    const home = tmpHome('twhk-');
    const res = installHooks(home, { srcDir: SRC_DIR, stateFile: path.join(home, '.handmux/claude-state.json') });
    expect(res.status).toBe('no-claude');
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });
});

describe('syncHooks (roll newly-added base hooks + refreshed scripts out on restart)', () => {
  const mk = () => { const h = tmpHome('twsync-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; };
  const opts = (h) => ({ srcDir: SRC_DIR, stateFile: path.join(h, '.handmux/s.json') });
  const readSettings = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8'));

  it('is a no-op when ~/.claude is absent (never creates it)', () => {
    const h = tmpHome('twsync-');
    expect(syncHooks(h, opts(h))).toMatchObject({ status: 'no-claude', changed: false });
    expect(fs.existsSync(path.join(h, '.claude'))).toBe(false);
  });

  it('is a no-op when our hooks are NOT installed — opt-in preserved, nothing written, no scripts deployed', () => {
    const h = mk();
    expect(syncHooks(h, opts(h))).toMatchObject({ status: 'absent', changed: false });
    expect(fs.existsSync(path.join(h, '.claude/settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(h, '.claude/hooks/handmux-write.cjs'))).toBe(false);
  });

  it('adds a newly-defined base event (SessionStart) a prior install predates, WITHOUT pruning ext events', () => {
    const h = mk();
    const dest = path.join(h, '.claude/hooks/handmux-notify.sh');
    const old = mergeHooks({}, dest, V('2.1.207')); // full install…
    delete old.hooks.SessionStart;                  // …but from before SessionStart existed
    fs.mkdirSync(path.join(h, '.claude/hooks'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude/settings.json'), JSON.stringify(old, null, 2));

    const res = syncHooks(h, opts(h));
    expect(res).toMatchObject({ status: 'installed', changed: true });
    const s = readSettings(h);
    expect(hasHook(s, 'SessionStart')).toBe(true);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(`${dest} start`);
    expect(hasHook(s, 'PostCompact')).toBe(true);   // ext preserved — sync never strips them
    expect(hasHook(s, 'StopFailure')).toBe(true);
  });

  it('is idempotent — a fresh install is already current, and a second sync rewrites nothing', () => {
    const h = mk();
    installHooks(h, { srcDir: SRC_DIR, stateFile: path.join(h, '.handmux/s.json'), claudeVersion: V('2.1.207') });
    expect(syncHooks(h, opts(h)).changed).toBe(false);            // SessionStart already present after install
    const before = fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8');
    expect(syncHooks(h, opts(h)).changed).toBe(false);
    expect(fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8')).toBe(before);
  });

  it('refreshes the deployed hook scripts even when settings are already current (picks up write.cjs fixes)', () => {
    const h = mk();
    installHooks(h, { srcDir: SRC_DIR, stateFile: path.join(h, '.handmux/s.json'), claudeVersion: V('2.1.207') });
    const scriptPath = path.join(h, '.claude/hooks/handmux-write.cjs');
    fs.writeFileSync(scriptPath, '// stale');                     // deployed script went out of date
    expect(syncHooks(h, opts(h)).changed).toBe(false);           // settings unchanged…
    expect(fs.readFileSync(scriptPath, 'utf8')).not.toBe('// stale'); // …but the script was re-copied
  });
});
