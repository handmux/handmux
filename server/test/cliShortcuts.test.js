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

  it('moves one configured shortcut directly to any final position', () => {
    const items = [
      { type: 'text', text: 'a', enter: false },
      { type: 'text', text: 'b', enter: true },
      { type: 'text', text: 'c', enter: true },
      { type: 'text', text: 'd', enter: true },
    ];
    expect(moveShortcut(items, 3, 0).map((item) => item.text)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveShortcut(items, 0, 3).map((item) => item.text)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveShortcut(items, 3, 1).map((item) => item.text)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveShortcut(items, 0, 2).map((item) => item.text)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveShortcut(items, 1, 1)).toEqual(items);
    expect(items.map((item) => item.text)).toEqual(['a', 'b', 'c', 'd']);
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
  it('moves a shortcut to a selected final position in one operation', async () => {
    const home = tmpHome('tw-shortcuts-move-');
    const target = path.join(home, '.handmux', 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ shortcuts: {
      command: [
        { type: 'text', text: 'a', enter: false },
        { type: 'text', text: 'b', enter: false },
        { type: 'text', text: 'c', enter: false },
        { type: 'text', text: 'd', enter: false },
      ],
      chat: [],
    } }));
    const answers = ['command', 'item:1', 'move', 2, 'back', 'save'];
    const selectCalls = [];
    const ui = {
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      select: vi.fn((options) => { selectCalls.push(options); return { kind: 'select', options }; }),
      text: vi.fn((options) => ({ kind: 'text', options })),
      confirm: vi.fn((options) => ({ kind: 'confirm', options })),
      ask: vi.fn(async () => answers.shift()),
    };

    const result = await runShortcutEditor({ target, running: false, isTTY: true, ui });

    expect(result.cfg.shortcuts.command.map((item) => item.text)).toEqual(['a', 'c', 'b', 'd']);
    const actionMenu = selectCalls.find((call) => call.options.some((option) => option.value === 'move'));
    expect(actionMenu.options.some((option) => option.value === 'move')).toBe(true);
    const positionMenu = selectCalls.find((call) => call.options.some((option) => option.value === 0));
    expect(positionMenu.options).toEqual([
      { value: 0, label: '1 · First' },
      { value: 2, label: '3 · After c' },
      { value: 3, label: '4 · Last' },
    ]);
  });

  it('does not offer moving when a mode has only one shortcut', async () => {
    const home = tmpHome('tw-shortcuts-one-');
    const target = path.join(home, '.handmux', 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ shortcuts: {
      command: [{ type: 'text', text: 'only', enter: false }], chat: [],
    } }));
    const answers = ['command', 'item:0', 'back', 'back', 'exit'];
    const selectCalls = [];
    const ui = {
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      select: vi.fn((options) => { selectCalls.push(options); return { kind: 'select', options }; }),
      text: vi.fn((options) => ({ kind: 'text', options })),
      confirm: vi.fn((options) => ({ kind: 'confirm', options })),
      ask: vi.fn(async () => answers.shift()),
    };

    await runShortcutEditor({ target, running: false, isTTY: true, ui });

    const itemMenu = selectCalls.find((call) => call.message === 'only');
    expect(itemMenu.options.some((option) => option.value === 'move')).toBe(false);
  });

  it('guides a text shortcut from mode selection through Enter behavior and save', async () => {
    const home = tmpHome('tw-shortcuts-ui-');
    const target = path.join(home, '.handmux', 'config.json');
    const answers = ['command', 'add-text', 'git status', true, 'back', 'save'];
    const selectCalls = [];
    const ui = {
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      select: vi.fn((options) => { selectCalls.push(options); return { kind: 'select', options }; }),
      text: vi.fn((options) => ({ kind: 'text', options })),
      confirm: vi.fn((options) => {
        if (/restart handmux/i.test(options.message)) throw new Error('restart prompt must not be shown');
        return { kind: 'confirm', options };
      }),
      ask: vi.fn(async () => answers.shift()),
    };

    const result = await runShortcutEditor({ target, running: true, isTTY: true, ui });

    expect(result.cfg.shortcuts.command).toEqual([
      { type: 'text', text: 'git status', enter: true },
    ]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).shortcuts.command).toEqual(result.cfg.shortcuts.command);
    expect(ui.outro).toHaveBeenCalled();
    const modeMenu = selectCalls.find((call) => call.options.some((option) => option.value === 'add-text'));
    expect(modeMenu.options.map((option) => option.value)).toContain('add-key');
    expect(modeMenu.options.map((option) => option.value)).not.toContain('add');
  });

  it('applies saved shortcuts to the running server through its authenticated local API', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    expect(typeof mod.applyShortcutsLive).toBe('function');
    const shortcuts = { command: [], chat: [{ type: 'text', text: 'ok', enter: true }] };
    let captured;
    const fetchImpl = async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await mod.applyShortcutsLive({
      state: { localUrl: 'http://localhost:12345', token: 'secret' }, shortcuts, fetchImpl,
    });

    expect(captured.url).toBe('http://localhost:12345/api/config/shortcuts');
    expect(captured.options).toMatchObject({
      method: 'PUT',
      redirect: 'manual',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(captured.options.body)).toEqual({ shortcuts });
  });

  it('reports a live-apply HTTP failure so the CLI can give a restart fallback', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    await expect(mod.applyShortcutsLive({
      state: { localUrl: 'http://localhost:12345', token: 'secret' },
      shortcuts: { command: [], chat: [] },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    })).rejects.toThrow(/HTTP 503/);
  });

  it('does not treat an unrelated 2xx response as a successful live apply', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    await expect(mod.applyShortcutsLive({
      state: { localUrl: 'http://localhost:12345', token: 'secret' },
      shortcuts: { command: [], chat: [] },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
    })).rejects.toThrow(/invalid server response/);
  });

  it('times out a live apply instead of leaving the CLI hung forever', async () => {
    vi.useFakeTimers();
    try {
      const mod = await import('../src/cli/shortcutEditor.js');
      const pending = mod.applyShortcutsLive({
        state: { localUrl: 'http://localhost:12345', token: 'secret' },
        shortcuts: { command: [], chat: [] },
        timeoutMs: 25,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves without calling the live API when no server is running', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    const home = tmpHome('tw-shortcuts-offline-');
    const target = path.join(home, '.handmux', 'config.json');
    const release = vi.fn();
    const fetchImpl = vi.fn();
    const result = await mod.commitShortcuts({
      home, target,
      shortcuts: { command: [], chat: [{ type: 'text', text: 'saved', enter: true }] },
      acquireLock: () => release,
      readStateImpl: () => null,
      fetchImpl,
    });

    expect(result).toMatchObject({ running: false, applied: false });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).shortcuts.chat[0].text).toBe('saved');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps save and live apply under one cross-process lock', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    const home = tmpHome('tw-shortcuts-lock-');
    const target = path.join(home, '.handmux', 'config.json');
    let finishRequest;
    const first = mod.commitShortcuts({
      home, target,
      shortcuts: { command: [], chat: [{ type: 'text', text: 'first', enter: true }] },
      readStateImpl: () => ({ localUrl: 'http://localhost:12345', token: 'secret', supervisorPid: process.pid }),
      fetchImpl: async () => new Promise((resolve) => { finishRequest = resolve; }),
    });
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf('function'));

    await expect(mod.commitShortcuts({
      home, target,
      shortcuts: { command: [], chat: [{ type: 'text', text: 'second', enter: true }] },
      readStateImpl: () => null,
    })).rejects.toMatchObject({ ownerPid: process.pid });

    finishRequest({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await expect(first).resolves.toMatchObject({ running: true, applied: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).shortcuts.chat[0].text).toBe('first');
  });

  it('returns a non-zero report with restart fallback when live apply fails', async () => {
    const mod = await import('../src/cli/shortcutEditor.js');
    const log = vi.fn();
    const error = vi.fn();
    const exitCode = mod.reportShortcutCommit({
      running: true, applied: false, error: new Error('server returned HTTP 503'),
    }, { log, error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/handmux restart/));
    expect(log).not.toHaveBeenCalled();
  });

  it('adds a key directly without asking for its shortcut type first', async () => {
    const home = tmpHome('tw-shortcuts-key-ui-');
    const target = path.join(home, '.handmux', 'config.json');
    const answers = ['command', 'add-key', 'none', 'Escape', 'back', 'save'];
    const ui = {
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      select: vi.fn((options) => ({ kind: 'select', options })),
      text: vi.fn((options) => ({ kind: 'text', options })),
      confirm: vi.fn((options) => ({ kind: 'confirm', options })),
      ask: vi.fn(async () => answers.shift()),
    };

    const result = await runShortcutEditor({ target, running: false, isTTY: true, ui });

    expect(result.cfg.shortcuts.command).toEqual([
      { type: 'key', key: 'Escape', label: 'Esc' },
    ]);
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
