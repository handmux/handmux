import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOK_EVENTS, HOOK_EVENTS_EXT, mergeHooks, stripHooks, hooksStatus, hooksHealthStatus,
  installHooks, uninstallHooks, syncHooks,
  parseCodeBuddyVersion, codeBuddyVersionAtLeast, detectCodeBuddyVersion,
} from '../src/cli/codebuddyHooks.js';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks');

const DEST = '/home/x/.codebuddy/hooks/handmux-codebuddy-notify.sh';
const MARK = 'handmux-codebuddy-notify.sh';

const mk = () => { const h = tmpHome('tbcb-'); fs.mkdirSync(path.join(h, '.codebuddy'), { recursive: true }); return h; };
const opts = (h) => ({ srcDir: SRC_DIR, stateFile: path.join(h, '.handmux/codebuddy-state.json') });
const readSettings = (h) => JSON.parse(fs.readFileSync(path.join(h, '.codebuddy/settings.json'), 'utf8'));

function hasHook(settings, event, mark = MARK) {
  return (settings.hooks?.[event] || []).some(
    (g) => (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(mark)),
  );
}

describe('CodeBuddy HOOK_EVENTS', () => {
  it('declares every event the Agent needs, with the agreed src names', () => {
    const byEvent = Object.fromEntries(HOOK_EVENTS.map((e) => [e.event, e]));
    expect(HOOK_EVENTS.map((e) => e.event)).toEqual([
      'Stop', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
      'PostToolUse', 'PermissionRequest',
    ]);
    expect(byEvent.Stop.src).toBe('stop');
    expect(byEvent.Notification.src).toBe('notify');
    expect(byEvent.UserPromptSubmit.src).toBe('prompt');
    expect(byEvent.SessionStart.src).toBe('start');
    expect(byEvent.SessionEnd.src).toBe('end');
    // The pair that owns 需要你: the request lights it, answering the question clears it. Same two events
    // Claude installs — without them a pending prompt stays lit after the user replies.
    expect(byEvent.PermissionRequest.src).toBe('permreq');
    expect(byEvent.PostToolUse.src).toBe('resume');
    // Only the interaction tools may wake PostToolUse; every other tool call in a turn must not.
    expect(byEvent.PostToolUse.matcher).toBe('AskUserQuestion|ExitPlanMode');
    expect(byEvent.PermissionRequest.matcher).toBeUndefined();
  });
});

describe('version-gated events', () => {
  const at = (major, minor, patch) => ({ major, minor, patch });

  it('writes the extension events only for a CodeBuddy new enough to emit them', () => {
    // Same policy as Claude's: never write an event the CLI might not recognise. Undetectable fails closed.
    for (const version of [null, undefined, at(2, 154, 9)]) {
      const out = mergeHooks({}, DEST, version);
      for (const e of HOOK_EVENTS_EXT) expect(hasHook(out, e.event), e.event).toBe(false);
    }
    const out = mergeHooks({}, DEST, at(2, 155, 0));
    for (const e of HOOK_EVENTS_EXT) expect(hasHook(out, e.event), e.event).toBe(true);
    expect(out.hooks.StopFailure[0].hooks[0].command).toBe(`${DEST} stopfail`);
    expect(out.hooks.PreCompact[0].hooks[0].command).toBe(`${DEST} compacting`);
    expect(out.hooks.PostCompact[0].hooks[0].command).toBe(`${DEST} compact`);
  });

  it('prunes our extension events when the version no longer passes the gate', () => {
    // A downgrade must not leave an event name behind that this CLI cannot handle; the user's own hooks and
    // the base events stay exactly where they are.
    const installed = mergeHooks({ hooks: { Custom: [{ matcher: '', hooks: [{ type: 'command', command: 'user-own' }] }] } },
      DEST, at(2, 155, 0));
    const downgraded = mergeHooks(installed, DEST, at(2, 154, 0));
    for (const e of HOOK_EVENTS_EXT) expect(hasHook(downgraded, e.event), e.event).toBe(false);
    for (const e of HOOK_EVENTS) expect(hasHook(downgraded, e.event), e.event).toBe(true);
    expect(downgraded.hooks.Custom[0].hooks[0].command).toBe('user-own');
  });

  it('parses and compares versions the way the gate needs', () => {
    expect(parseCodeBuddyVersion('2.155.0\n')).toEqual(at(2, 155, 0));
    expect(parseCodeBuddyVersion('codebuddy 3.0.1')).toEqual(at(3, 0, 1));
    expect(parseCodeBuddyVersion('nonsense')).toBeNull();
    expect(codeBuddyVersionAtLeast(at(2, 155, 0), '2.155.0')).toBe(true);
    expect(codeBuddyVersionAtLeast(at(2, 154, 99), '2.155.0')).toBe(false);
    expect(codeBuddyVersionAtLeast(at(3, 0, 0), '2.155.0')).toBe(true);
    expect(codeBuddyVersionAtLeast(null, '2.155.0')).toBe(false);
  });

  it('detects the CLI version, and reports nothing when it cannot be read', () => {
    expect(detectCodeBuddyVersion(() => ({ status: 0, stdout: '2.155.0\n' }))).toEqual(at(2, 155, 0));
    expect(detectCodeBuddyVersion(() => ({ status: 1, stdout: '' }))).toBeNull();
    expect(detectCodeBuddyVersion(() => { throw new Error('ENOENT'); })).toBeNull();
  });

  it('installs the extension events through installHooks when the detected version allows them', () => {
    const home = mk();
    installHooks(home, { ...opts(home), codebuddyVersion: at(2, 155, 0) });
    const settings = readSettings(home);
    for (const e of [...HOOK_EVENTS, ...HOOK_EVENTS_EXT]) expect(hasHook(settings, e.event), e.event).toBe(true);
    // A partial registration is still repairable-but-not-ready only for BASE events; extension events stay
    // optional, exactly like Claude's.
    expect(hooksHealthStatus(home)).toBe('installed');
  });
});

describe('mergeHooks', () => {
  it('registers every event pointing at the dest script with src args', () => {
    const out = mergeHooks({}, DEST);
    for (const ev of ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
      'PostToolUse', 'PermissionRequest']) {
      expect(hasHook(out, ev), ev).toBe(true);
    }
    const cmd = (ev) => out.hooks[ev].flatMap((g) => g.hooks).map((h) => h.command).join(' ');
    expect(cmd('UserPromptSubmit')).toBe(`${DEST} prompt`);
    expect(cmd('SessionStart')).toBe(`${DEST} start`);
    expect(cmd('SessionEnd')).toBe(`${DEST} end`);
    expect(cmd('PostToolUse')).toBe(`${DEST} resume`);
    expect(cmd('PermissionRequest')).toBe(`${DEST} permreq`);
    expect(out.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 5 });
    expect(out.hooks.Stop[0].matcher).toBe('');
    // The matcher has to reach settings.json, or the hook would fire on every tool call.
    expect(out.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion|ExitPlanMode');
  });

  it('is idempotent — merging twice does not duplicate groups', () => {
    const once = mergeHooks({}, DEST);
    const twice = mergeHooks(once, DEST);
    for (const ev of Object.keys(once.hooks)) expect(twice.hooks[ev]).toHaveLength(1);
  });

  it('preserves the user’s unrelated settings and hooks — including a CLAUDE handmux hook', () => {
    const existing = {
      model: 'gpt-5',
      enabledPlugins: ['foo@bar'],
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/handmux-notify.sh stop' }] }] },
    };
    const out = mergeHooks(existing, DEST);
    expect(out.model).toBe('gpt-5');
    expect(out.enabledPlugins).toEqual(['foo@bar']);
    // our Stop hook is added alongside, the user's (which carries the OTHER marker) is kept
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command === '/usr/local/bin/handmux-notify.sh stop'))).toBe(true);
  });

  it('repairs a moved install without duplicating our entry', () => {
    const stale = mergeHooks({}, '/old/install/.codebuddy/hooks/handmux-codebuddy-notify.sh');
    const out = mergeHooks(stale, DEST);
    expect(out.hooks.Stop).toHaveLength(1);
    expect(out.hooks.Stop[0].hooks[0].command).toBe(`${DEST} stop`);
  });

  it('tolerates malformed groups without crashing or erasing unrelated fields', () => {
    const out = mergeHooks({ hooks: { Stop: 'broken', Notification: [null, { hooks: 'bad' }], Custom: 42 } }, DEST);
    expect(Array.isArray(out.hooks.Stop)).toBe(true);
    expect(out.hooks.Stop.at(-1).hooks[0].command).toBe(`${DEST} stop`);
    expect(out.hooks.Notification.at(-1).hooks[0].command).toBe(`${DEST} notify`);
    expect(out.hooks.Custom).toBe(42);
    expect(mergeHooks({ hooks: [] }, DEST).hooks.Stop).toBeDefined();
  });
});

describe('stripHooks', () => {
  it('removes only our hooks, keeping the user’s (same-file, other marker)', () => {
    const merged = mergeHooks({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/handmux-notify.sh stop' }] }] },
    }, DEST);
    const out = stripHooks(merged);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command === '/usr/local/bin/handmux-notify.sh stop'))).toBe(true);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes(MARK)))).toBe(false);
    // an event that becomes empty is dropped entirely
    expect(out.hooks.SessionStart).toBeUndefined();
  });

  it('is a no-op when there are no hooks of ours', () => {
    const out = stripHooks({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] } });
    expect(out.hooks.Stop).toHaveLength(1);
  });
});

describe('hooksStatus / hooksHealthStatus', () => {
  it('no-codebuddy when ~/.codebuddy is absent', () => {
    const home = tmpHome('tbcb-');
    expect(hooksStatus(home)).toBe('no-codebuddy');
    expect(hooksHealthStatus(home)).toBe('no-codebuddy');
  });

  it('absent when ~/.codebuddy exists but nothing of ours is registered', () => {
    const home = mk();
    expect(hooksStatus(home)).toBe('absent');
    fs.writeFileSync(path.join(home, '.codebuddy/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '/x.sh' }] }] } }));
    expect(hooksStatus(home)).toBe('absent');
  });

  it('installed once our hooks and every deployed file are present', () => {
    const home = mk();
    installHooks(home, opts(home));
    expect(hooksStatus(home)).toBe('installed');
    expect(hooksHealthStatus(home)).toBe('installed');
  });

  it('stale when an event registration is missing, unowned, or the deployed scripts are gone', () => {
    const missing = mk();
    installHooks(missing, opts(missing));
    const s = readSettings(missing);
    delete s.hooks.SessionStart;
    fs.writeFileSync(path.join(missing, '.codebuddy/settings.json'), JSON.stringify(s));
    expect(hooksHealthStatus(missing)).toBe('stale');

    const duplicated = mk();
    installHooks(duplicated, opts(duplicated));
    const d = readSettings(duplicated);
    d.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: `${DEST} stop`, async: true, timeout: 5 }] });
    fs.writeFileSync(path.join(duplicated, '.codebuddy/settings.json'), JSON.stringify(d));
    expect(hooksHealthStatus(duplicated)).toBe('stale');

    const deleted = mk();
    installHooks(deleted, opts(deleted));
    fs.unlinkSync(path.join(deleted, '.codebuddy/hooks/handmux-write.cjs'));
    expect(hooksHealthStatus(deleted)).toBe('stale');
  });
});

describe('installHooks / uninstallHooks (IO)', () => {
  it('deploys only the CodeBuddy script set, then restores the user’s settings on uninstall', () => {
    const home = mk();
    const original = {
      model: 'gpt-5',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] },
    };
    fs.writeFileSync(path.join(home, '.codebuddy/settings.json'), JSON.stringify(original));

    expect(installHooks(home, opts(home)).status).toBe('installed');

    const hooksDir = path.join(home, '.codebuddy/hooks');
    expect(fs.existsSync(path.join(hooksDir, MARK))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-write.cjs'))).toBe(true);
    // the CLAUDE entry script must never be deployed into CodeBuddy's directory
    expect(fs.existsSync(path.join(hooksDir, 'handmux-notify.sh'))).toBe(false);
    expect(fs.statSync(path.join(hooksDir, MARK)).mode & 0o111).not.toBe(0); // executable
    const env = fs.readFileSync(path.join(hooksDir, 'handmux-codebuddy-notify.env'), 'utf8');
    expect(env).toContain(`HANDMUX_STATE=${opts(home).stateFile}`);
    expect(env).toContain(`HANDMUX_CODEBUDDY_EVENTS=${opts(home).stateFile}.events`);

    const installed = readSettings(home);
    expect(installed.model).toBe('gpt-5');
    expect(installed.hooks.Stop.some((g) => g.hooks.some((h) => h.command === '/my/other.sh'))).toBe(true);
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe(`${path.join(hooksDir, MARK)} start`);

    uninstallHooks(home);
    expect(hooksStatus(home)).toBe('absent');
    expect(fs.existsSync(path.join(hooksDir, MARK))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-write.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'handmux-codebuddy-notify.env'))).toBe(false);
    expect(readSettings(home)).toEqual(original); // the user's file is back, byte for byte in meaning
  });

  it('refuses to install when ~/.codebuddy is absent (returns no-codebuddy, creates nothing)', () => {
    const home = tmpHome('tbcb-');
    expect(installHooks(home, opts(home)).status).toBe('no-codebuddy');
    expect(fs.existsSync(path.join(home, '.codebuddy'))).toBe(false);
  });

  it('uninstalls cleanly even when nothing was installed', () => {
    const home = mk();
    fs.writeFileSync(path.join(home, '.codebuddy/settings.json'), JSON.stringify({ model: 'x' }));
    expect(uninstallHooks(home)).toEqual({ status: 'absent' });
    expect(readSettings(home)).toEqual({ model: 'x' });
  });
});

describe('syncHooks (roll newly-added hooks + refreshed scripts out on restart)', () => {
  it('is a no-op when ~/.codebuddy is absent (never creates it)', () => {
    const h = tmpHome('tbcb-');
    expect(syncHooks(h, opts(h))).toMatchObject({ status: 'no-codebuddy', changed: false });
    expect(fs.existsSync(path.join(h, '.codebuddy'))).toBe(false);
  });

  it('is a no-op when our hooks are NOT installed — opt-in preserved, nothing written or deployed', () => {
    const h = mk();
    expect(syncHooks(h, opts(h))).toMatchObject({ status: 'absent', changed: false });
    expect(fs.existsSync(path.join(h, '.codebuddy/settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(h, '.codebuddy/hooks/handmux-write.cjs'))).toBe(false);
  });

  it('adds a base event a prior install predates, without touching the user’s hooks', () => {
    const h = mk();
    const dest = path.join(h, '.codebuddy/hooks', MARK);
    const old = mergeHooks({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/my/other.sh' }] }] } }, dest);
    delete old.hooks.SessionStart;
    fs.mkdirSync(path.join(h, '.codebuddy/hooks'), { recursive: true });
    fs.writeFileSync(path.join(h, '.codebuddy/settings.json'), JSON.stringify(old, null, 2));

    expect(syncHooks(h, opts(h))).toMatchObject({ status: 'installed', changed: true });
    const s = readSettings(h);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(`${dest} start`);
    expect(s.hooks.Stop.some((g) => g.hooks.some((x) => x.command === '/my/other.sh'))).toBe(true);
  });

  it('is idempotent and refreshes the deployed scripts', () => {
    const h = mk();
    installHooks(h, opts(h));
    expect(syncHooks(h, opts(h)).changed).toBe(false);
    const before = fs.readFileSync(path.join(h, '.codebuddy/settings.json'), 'utf8');
    expect(syncHooks(h, opts(h)).changed).toBe(false);
    expect(fs.readFileSync(path.join(h, '.codebuddy/settings.json'), 'utf8')).toBe(before);

    const script = path.join(h, '.codebuddy/hooks/handmux-write.cjs');
    fs.writeFileSync(script, '// stale');
    syncHooks(h, opts(h));
    expect(fs.readFileSync(script, 'utf8')).not.toBe('// stale');
  });
});
