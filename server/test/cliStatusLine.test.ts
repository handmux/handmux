import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './tmphome.js';
import {
  statusLineStatus, installStatusLine, uninstallStatusLine, composeHint, refreshStatusLineScript,
} from '../src/cli/statusLine.js';

const SRC = path.resolve(__dirname, '../hooks'); // bundled scripts (has handmux-statusline.cjs)

interface TestSettings {
  model?: unknown;
  hooks?: unknown;
  statusLine?: { type?: unknown; command?: unknown };
}

function withClaude(prefix: string): string {
  const home = tmpHome(prefix);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}
function settings(home: string): TestSettings {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) as TestSettings;
}
function statusLine(home: string): { type?: unknown; command: string } {
  const value = settings(home).statusLine;
  if (!value || typeof value.command !== 'string') throw new Error('expected installed statusLine');
  return { ...value, command: value.command };
}
function writeSettings(home: string, obj: TestSettings): void {
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(obj));
}
const usageFile = (home: string): string => path.join(home, '.handmux', 'claude-usage.json');

describe('statusLineStatus', () => {
  it("'no-claude' when ~/.claude is absent", () => {
    expect(statusLineStatus(tmpHome('sl-'))).toBe('no-claude');
  });
  it("'absent' when Claude is present but has no statusLine", () => {
    expect(statusLineStatus(withClaude('sl-'))).toBe('absent');
  });
  it("'foreign' when the user has their own statusLine", () => {
    const home = withClaude('sl-');
    writeSettings(home, { statusLine: { type: 'command', command: 'bash ~/.claude/mystatus.sh' } });
    expect(statusLineStatus(home)).toBe('foreign');
  });
  it("'ours' when our capturer is installed", () => {
    const home = withClaude('sl-');
    installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    expect(statusLineStatus(home)).toBe('ours');
  });
});

describe('installStatusLine', () => {
  it('installs when absent: copies the script + points settings.statusLine at it', () => {
    const home = withClaude('sl-');
    const r = installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    expect(r.status).toBe('installed');
    expect(fs.existsSync(path.join(home, '.claude', 'hooks', 'handmux-statusline.cjs'))).toBe(true);
    const sl = statusLine(home);
    expect(sl.type).toBe('command');
    expect(sl.command).toContain('handmux-statusline.cjs');
    expect(sl.command).toContain(usageFile(home));
  });

  it('NEVER clobbers a foreign statusLine (but still deploys the capturer for compose)', () => {
    const home = withClaude('sl-');
    writeSettings(home, { statusLine: { type: 'command', command: 'bash ~/.claude/mystatus.sh' } });
    const r = installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    expect(r.status).toBe('foreign');
    expect(statusLine(home).command).toBe('bash ~/.claude/mystatus.sh'); // untouched
    // the script IS copied so the TEE compose one-liner is runnable — settings just isn't rewired
    expect(fs.existsSync(path.join(home, '.claude', 'hooks', 'handmux-statusline.cjs'))).toBe(true);
  });

  it("'no-claude' and does nothing when ~/.claude is absent", () => {
    const home = tmpHome('sl-');
    expect(installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) }).status).toBe('no-claude');
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('preserves other settings keys', () => {
    const home = withClaude('sl-');
    writeSettings(home, { model: 'opus', hooks: { Stop: [] } });
    installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    const s = settings(home);
    expect(s.model).toBe('opus');
    expect(s.hooks).toEqual({ Stop: [] });
    expect(s.statusLine).toBeDefined();
  });
});

describe('uninstallStatusLine', () => {
  it('removes ours (settings key + script)', () => {
    const home = withClaude('sl-');
    installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    uninstallStatusLine(home);
    expect(settings(home).statusLine).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.claude', 'hooks', 'handmux-statusline.cjs'))).toBe(false);
  });

  it('leaves a foreign statusLine intact', () => {
    const home = withClaude('sl-');
    writeSettings(home, { statusLine: { type: 'command', command: 'bash ~/.claude/mystatus.sh' } });
    uninstallStatusLine(home);
    expect(statusLine(home).command).toBe('bash ~/.claude/mystatus.sh');
  });
});

describe('refreshStatusLineScript (upgrade path — refresh the on-disk capturer without touching settings)', () => {
  const scriptPath = (home: string): string => path.join(home, '.claude', 'hooks', 'handmux-statusline.cjs');

  it('refreshes the script in place when ours (plain form)', () => {
    const home = withClaude('sl-');
    installStatusLine(home, { srcDir: SRC, usageFile: usageFile(home) });
    fs.writeFileSync(scriptPath(home), '// stale old capturer'); // simulate a pre-upgrade copy
    const before = statusLine(home).command;
    expect(refreshStatusLineScript(home, { srcDir: SRC })).toBe(true);
    expect(fs.readFileSync(scriptPath(home), 'utf8')).toContain('handmux statusLine capturer'); // bundled again
    expect(statusLine(home).command).toBe(before); // settings untouched
  });

  it('refreshes the script but KEEPS a composed (TEE) statusline command intact', () => {
    const home = withClaude('sl-');
    // user composed our capturer into their own renderer — reads as 'ours' via the mark, must not be rewritten
    const composed = 'HANDMUX_STATUS_TEE=1 node ~/.claude/hooks/handmux-statusline.cjs ~/.handmux/claude-usage.json | bash ~/.claude/mystatus.sh';
    writeSettings(home, { statusLine: { type: 'command', command: composed } });
    fs.mkdirSync(path.dirname(scriptPath(home)), { recursive: true });
    fs.writeFileSync(scriptPath(home), '// stale');
    expect(statusLineStatus(home)).toBe('ours');
    expect(refreshStatusLineScript(home, { srcDir: SRC })).toBe(true);
    expect(fs.readFileSync(scriptPath(home), 'utf8')).toContain('handmux statusLine capturer');
    expect(statusLine(home).command).toBe(composed); // downstream renderer preserved
  });

  it('no-op (false) when not ours (foreign / absent)', () => {
    const foreign = withClaude('sl-');
    writeSettings(foreign, { statusLine: { type: 'command', command: 'bash ~/.claude/mystatus.sh' } });
    expect(refreshStatusLineScript(foreign, { srcDir: SRC })).toBe(false);
    expect(refreshStatusLineScript(withClaude('sl-'), { srcDir: SRC })).toBe(false); // absent
  });
});

describe('composeHint', () => {
  it('is a TEE pipeline into the user\'s own statusline', () => {
    const home = withClaude('sl-');
    const hint = composeHint(home, { usageFile: usageFile(home) });
    expect(hint).toContain('HANDMUX_STATUS_TEE=1');
    expect(hint).toContain('handmux-statusline.cjs');
    expect(hint).toContain('<your existing statusline>');
  });
});
