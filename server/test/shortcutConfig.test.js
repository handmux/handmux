import { describe, it, expect } from 'vitest';
import { DEFAULT_SHORTCUTS, normalizeShortcuts, shortcutIdentity } from '../src/shortcutConfig.js';

describe('shortcut config', () => {
  it('uses Ctrl+C in both default quick bars when shortcuts are absent', () => {
    const out = normalizeShortcuts(undefined);
    expect(out).toEqual(DEFAULT_SHORTCUTS);
    expect(out.command[0]).toEqual({ type: 'key', key: 'C-c', label: 'Ctrl+C' });
    expect(out.chat.slice(0, 4)).toEqual([
      { type: 'key', key: 'C-c', label: 'Ctrl+C' },
      { type: 'key', key: 'Escape', label: 'Esc' },
      { type: 'key', key: 'Tab', label: 'Tab' },
      { type: 'key', key: 'BSpace', label: '⌫' },
    ]);
    expect(out.chat.find((item) => item.text === 'ok')).toMatchObject({ type: 'text', enter: true });
  });

  it('does not inject defaults into explicitly configured mode arrays', () => {
    expect(normalizeShortcuts({ command: [], chat: [] })).toEqual({ command: [], chat: [] });
  });

  it('accepts ordered typed items and preserves explicit empty mode lists', () => {
    expect(normalizeShortcuts({
      command: [
        { type: 'key', key: 'C-c', label: 'Ctrl+C' },
        { type: 'text', text: 'git status', enter: true },
      ],
      chat: [],
    })).toEqual({
      command: [
        { type: 'key', key: 'C-c', label: 'Ctrl+C' },
        { type: 'text', text: 'git status', enter: true },
      ],
      chat: [],
    });
  });

  it('defaults a missing key label to the canonical key name', () => {
    expect(normalizeShortcuts({ command: [{ type: 'key', key: 'Escape' }], chat: [] }).command[0])
      .toEqual({ type: 'key', key: 'Escape', label: 'Escape' });
  });

  it.each([
    [{ command: [], chat: 'no' }, 'shortcuts.chat: expected an array'],
    [{ command: [{ type: 'key', key: 'Foo' }], chat: [] }, 'shortcuts.command[0].key: unsupported key "Foo"'],
    [{ command: [{ type: 'text', text: 'ok' }], chat: [] }, 'shortcuts.command[0].enter: expected a boolean'],
    [{ command: [{ type: 'text', text: 'bad\nline', enter: true }], chat: [] }, 'shortcuts.command[0].text: expected non-empty single-line text'],
    [{ command: [{ type: 'wat', text: 'x', enter: true }], chat: [] }, 'shortcuts.command[0].type: expected "key" or "text"'],
  ])('rejects invalid input with an exact JSON path', (input, message) => {
    expect(() => normalizeShortcuts(input)).toThrow(message);
  });

  it('rejects duplicate actions inside one configured mode', () => {
    expect(() => normalizeShortcuts({
      command: [
        { type: 'text', text: 'ls', enter: false },
        { type: 'text', text: 'ls', enter: false },
      ],
      chat: [],
    })).toThrow('shortcuts.command[1]: duplicate shortcut');
  });

  it('identifies keys separately from text+Enter behavior', () => {
    expect(shortcutIdentity({ type: 'key', key: 'Escape' })).toBe('key:Escape');
    expect(shortcutIdentity({ type: 'text', text: 'ok', enter: true })).toBe('text:1:ok');
    expect(shortcutIdentity({ type: 'text', text: 'ok', enter: false })).toBe('text:0:ok');
  });
});
