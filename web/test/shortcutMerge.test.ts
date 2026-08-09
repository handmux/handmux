import { describe, it, expect } from 'vitest';
import { applyShortcutLayout } from '../src/shortcutLayout.js';
import { DEFAULT_SERVER_SHORTCUTS, mergeShortcuts, shortcutIdentity } from '../src/shortcutMerge.js';
import type { ShortcutItem, ShortcutPreset, ShortcutPresetText } from '../src/shortcutMerge.js';

describe('server shortcut merge', () => {
  it('keeps the server Ctrl+C defaults in the offline fallback', () => {
    expect(DEFAULT_SERVER_SHORTCUTS.command).toEqual([
      { type: 'key', key: 'C-c', label: 'Ctrl+C' },
    ]);
    expect(DEFAULT_SERVER_SHORTCUTS.chat.slice(0, 4).map((item) => (
      item.type === 'key' ? item.key : undefined
    )))
      .toEqual(['C-c', 'Escape', 'Tab', 'BSpace']);
    expect(DEFAULT_SERVER_SHORTCUTS.chat.find((item): item is ShortcutPresetText => (
      item.type === 'text' && item.text === 'ok'
    ))?.enter)
      .toBe(true);
  });

  it('places mandatory config items first and hides duplicate local actions without deleting them', () => {
    const presets: ShortcutPreset[] = [
      { type: 'key', key: 'Escape', label: 'Esc' },
      { type: 'text', text: 'ok', enter: true },
    ];
    const local: ShortcutItem[] = [
      { kind: 'key', text: 'Escape', label: 'My Esc' },
      { kind: 'reply', text: 'ok', enter: true },
      { kind: 'reply', text: 'local only', enter: false },
    ];
    const merged = mergeShortcuts(presets, local, 'chat');
    expect(merged.map((item) => item.source)).toEqual(['config', 'config', 'local']);
    expect(merged.map((item) => item.label || item.text)).toEqual(['Esc', 'ok', 'local only']);
    expect(local).toHaveLength(3); // merge never mutates/deletes the hidden local duplicate
  });

  it('lets a hidden local item reappear after its config preset is removed', () => {
    const local: ShortcutItem[] = [{ kind: 'reply', text: 'ok', enter: true }];
    expect(mergeShortcuts([{ type: 'text', text: 'ok', enter: true }], local, 'chat')).toHaveLength(1);
    expect(mergeShortcuts([], local, 'chat')).toEqual([{ ...local[0], source: 'local' }]);
  });

  it('treats the same text with different Enter behavior as different actions', () => {
    expect(shortcutIdentity({ type: 'text', text: 'ok', enter: true }))
      .not.toBe(shortcutIdentity({ kind: 'reply', text: 'ok', enter: false }));
  });

  it('keeps an explicitly hidden identity gone even when a phone-local duplicate exists', () => {
    const presets: ShortcutPreset[] = [{ type: 'key', key: 'C-c', label: 'Ctrl+C' }];
    const locals: ShortcutItem[] = [{ kind: 'key', text: 'C-c', label: 'My Ctrl+C' }];
    const merged = mergeShortcuts(presets, locals, 'command');
    expect(applyShortcutLayout(merged, { hidden: ['key:C-c'], order: [] })).toEqual([]);
  });
});
