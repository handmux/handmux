import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './tmphome.js';
import {
  buildShortcutKey, moveShortcut, saveShortcutConfig, runShortcutEditor,
} from '../src/cli/shortcutEditor.js';

describe('shortcut editor model', () => {
  it('builds canonical tmux keys and friendly labels from picked parts', () => {
    expect(buildShortcutKey('none', 'Escape')).toEqual({ type: 'key', key: 'Escape', label: 'Esc' });
    expect(buildShortcutKey('shift', 'Tab')).toEqual({ type: 'key', key: 'BTab', label: 'Shift+Tab' });
    expect(buildShortcutKey('ctrl-alt', 'r')).toEqual({ type: 'key', key: 'C-M-r', label: 'Ctrl+Alt+R' });
    expect(buildShortcutKey('ctrl-shift', 'Up')).toEqual({ type: 'key', key: 'C-S-Up', label: 'Ctrl+Shift+Up' });
  });

  it('rejects a bare character because that belongs to a text shortcut', () => {
    expect(() => buildShortcutKey('none', 'a')).toThrow(/modifier/);
  });

  it('moves one configured shortcut without crossing the list ends', () => {
    const items = [
      { type: 'text', text: 'a', enter: false },
      { type: 'text', text: 'b', enter: true },
    ];
    expect(moveShortcut(items, 1, -1).map((item) => item.text)).toEqual(['b', 'a']);
    expect(moveShortcut(items, 0, -1)).toEqual(items);
  });

  it('atomically writes shortcuts while preserving every unrelated config field', () => {
    const home = tmpHome('tw-shortcuts-');
    const target = path.join(home, '.handmux', 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ tunnel: 'none', token: 'keep', staticDir: '/srv' }));

    saveShortcutConfig(target, { command: [], chat: [{ type: 'text', text: 'ok', enter: true }] });

    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({
      tunnel: 'none', token: 'keep', staticDir: '/srv',
      shortcuts: { command: [], chat: [{ type: 'text', text: 'ok', enter: true }] },
    });
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });
});

describe('runShortcutEditor', () => {
  it('guides a text shortcut from mode selection through Enter behavior and save', async () => {
    const home = tmpHome('tw-shortcuts-ui-');
    const target = path.join(home, '.handmux', 'config.json');
    const answers = ['command', 'add', 'text', 'git status', true, 'back', 'save'];
    const ui = {
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      select: vi.fn((options) => ({ kind: 'select', options })),
      text: vi.fn((options) => ({ kind: 'text', options })),
      confirm: vi.fn((options) => ({ kind: 'confirm', options })),
      ask: vi.fn(async () => answers.shift()),
    };

    const result = await runShortcutEditor({ target, running: false, isTTY: true, ui });

    expect(result).toMatchObject({ restart: false });
    expect(result.cfg.shortcuts.command).toEqual([
      { type: 'text', text: 'git status', enter: true },
    ]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).shortcuts.command).toEqual(result.cfg.shortcuts.command);
    expect(ui.outro).toHaveBeenCalled();
  });

  it('refuses non-interactive input instead of hanging', async () => {
    const log = { error: vi.fn() };
    expect(await runShortcutEditor({ target: '/unused', isTTY: false, log })).toEqual({ error: 'non-tty' });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('the CLI exits non-zero when shortcuts has no interactive terminal', () => {
    const home = tmpHome('tw-shortcuts-no-tty-');
    const bin = fileURLToPath(new URL('../bin/handmux.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'shortcuts'], {
      env: { ...process.env, HOME: home, LANG: 'en_US.UTF-8' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('interactive terminal');
  });
});
