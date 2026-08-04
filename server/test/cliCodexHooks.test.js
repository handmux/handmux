import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeCodexHooks, stripCodexHooks, codexHooksBlock,
  codexHooksStatus, installCodexHooks, uninstallCodexHooks, syncCodexHooks,
} from '../src/cli/codexHooks.js';

// Presence is gated on the `codex` BINARY being on PATH (not on ~/.codex existing — that dir name isn't
// unique to Codex CLI). Put a fake executable `codex` on PATH for the install/status tests.
function fakeCodexOnPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbin-'));
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')); }
const srcDir = path.resolve(new URL('../hooks', import.meta.url).pathname);
const BLOCK = codexHooksBlock('/home/u');
const LEGACY_BLOCK = BLOCK.replace(/\[\[hooks\.SessionStart\]\][\s\S]*?(?=\[\[hooks\.UserPromptSubmit\]\])/, '');

describe('mergeCodexHooks / stripCodexHooks (pure)', () => {
  it('appends the marked region to an empty / hookless config', () => {
    const out = mergeCodexHooks('', BLOCK);
    expect(out).toContain('# >>> handmux codex-hooks >>>');
    expect(out).toContain('[[hooks.Stop]]');
    expect(out).toContain('[[hooks.SessionStart]]');
    expect(out).toContain('matcher = "^(startup|resume|clear)$"');
    expect(out).toContain('[[hooks.SessionEnd]]');
    expect(out).toContain('[[hooks.UserPromptSubmit]]');
    expect(out).toContain('[[hooks.PermissionRequest]]');
    expect(out).toContain('[[hooks.PostToolUse]]'); // un-stick 需要你→进行中 after an approval
  });

  it("keeps the user's own config and appends after it", () => {
    const user = 'model = "gpt-5"\n[tui]\nx = 1\n';
    const out = mergeCodexHooks(user, BLOCK);
    expect(out.startsWith(user)).toBe(true);
    expect(out).toContain('# >>> handmux codex-hooks >>>');
  });

  it('replaces our region in place on reinstall (idempotent — one region only)', () => {
    const once = mergeCodexHooks('model = "gpt-5"\n', BLOCK);
    const twice = mergeCodexHooks(once, BLOCK);
    expect(twice.match(/# >>> handmux codex-hooks >>>/g)).toHaveLength(1);
    expect(twice.match(/\[\[hooks\.Stop\]\]/g)).toHaveLength(1);
  });

  it('strips our region and leaves the user config intact', () => {
    const user = 'model = "gpt-5"\n';
    expect(stripCodexHooks(mergeCodexHooks(user, BLOCK)).trimEnd()).toBe(user.trimEnd());
    expect(stripCodexHooks(user)).toBe(user); // nothing of ours → unchanged
  });

  it('builds a command that runs the shared notify script with agent=codex', () => {
    expect(BLOCK).toContain("handmux-notify.sh' stop codex");
    expect(BLOCK).toContain("handmux-notify.sh' prompt codex");
    expect(BLOCK).toContain("handmux-notify.sh' start codex");
    expect(BLOCK).toContain("handmux-notify.sh' end codex");
    expect(BLOCK).toContain('type = "command"');
  });
});

describe('installCodexHooks / status / uninstall (IO)', () => {
  const realPath = process.env.PATH;
  afterEach(() => { process.env.PATH = realPath; });

  it('reports no-codex and does nothing when codex is not on PATH (even if ~/.codex exists)', () => {
    process.env.PATH = '';
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); // a FOREIGN ~/.codex (not Codex CLI)
    expect(codexHooksStatus(home)).toBe('no-codex');
    expect(installCodexHooks(home, { srcDir, stateFile: '/x' }).status).toBe('no-codex');
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false); // untouched
  });

  it('installs: splices the hook region, copies the shared scripts, pins the state file', () => {
    process.env.PATH = fakeCodexOnPath();
    const home = tmpHome();
    const stateFile = path.join(home, '.handmux', 'claude-state.json');
    expect(codexHooksStatus(home)).toBe('absent');

    expect(installCodexHooks(home, { srcDir, stateFile }).status).toBe('installed');
    expect(codexHooksStatus(home)).toBe('installed');

    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[[hooks.Stop]]');
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'handmux-notify.sh'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'handmux-write.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'handmux-codex-usage.cjs'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.codex', 'hooks', 'handmux-notify.env'), 'utf8'))
      .toBe(`HANDMUX_STATE=${stateFile}\n`);

    // idempotent: a second install refreshes, no duplicate region
    installCodexHooks(home, { srcDir, stateFile });
    const again = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(again.match(/# >>> handmux codex-hooks >>>/g)).toHaveLength(1);
  });

  it('preserves a pre-existing config.toml when wiring hooks', () => {
    process.env.PATH = fakeCodexOnPath();
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    installCodexHooks(home, { srcDir, stateFile: '/s' });
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('[[hooks.Stop]]');
  });

  it('uninstall strips our region and removes the copied files', () => {
    process.env.PATH = fakeCodexOnPath();
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    installCodexHooks(home, { srcDir, stateFile: path.join(home, '.handmux', 's.json') });
    uninstallCodexHooks(home);
    expect(codexHooksStatus(home)).toBe('absent');
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('model = "gpt-5"');
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'handmux-notify.sh'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'handmux-codex-usage.cjs'))).toBe(false);
  });

  it('sync refreshes an existing marked install even when the server PATH cannot resolve codex', () => {
    const home = tmpHome();
    const stateFile = path.join(home, '.handmux', 'claude-state.json');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), mergeCodexHooks('model = "gpt-5"\n', LEGACY_BLOCK));
    fs.mkdirSync(path.join(home, '.codex', 'hooks'), { recursive: true });
    const usageScript = path.join(home, '.codex', 'hooks', 'handmux-codex-usage.cjs');
    fs.writeFileSync(usageScript, '// stale');
    process.env.PATH = '';

    expect(syncCodexHooks(home, { srcDir, stateFile })).toEqual({ status: 'installed', changed: true });
    expect(fs.readFileSync(usageScript, 'utf8')).not.toBe('// stale');
    const refreshed = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(refreshed).toContain('[[hooks.SessionStart]]');
    expect(refreshed).toContain("handmux-notify.sh' start codex");
  });

  it('sync is idempotent after refreshing scripts and the marked hook region', () => {
    process.env.PATH = fakeCodexOnPath();
    const home = tmpHome();
    const stateFile = path.join(home, '.handmux', 'claude-state.json');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    installCodexHooks(home, { srcDir, stateFile });
    const configPath = path.join(home, '.codex', 'config.toml');
    const before = fs.readFileSync(configPath, 'utf8');
    const usageScript = path.join(home, '.codex', 'hooks', 'handmux-codex-usage.cjs');
    fs.writeFileSync(usageScript, '// stale');

    expect(syncCodexHooks(home, { srcDir, stateFile })).toEqual({ status: 'installed', changed: false });
    expect(fs.readFileSync(usageScript, 'utf8')).not.toBe('// stale');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});
