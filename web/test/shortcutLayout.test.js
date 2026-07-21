import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyShortcutLayout, hideShortcutInLayout, loadShortcutLayout, moveShortcutInLayout,
  removeShortcutFromLayout, replaceShortcutInLayout, saveShortcutLayout, showShortcutInLayout,
} from '../src/shortcutLayout.js';

const a = { type: 'key', key: 'Escape' };
const b = { type: 'key', key: 'C-c' };
const c = { type: 'text', text: 'ok', enter: true };
const id = (item) => item.type === 'key'
  ? `key:${item.key}`
  : `text:${item.text}:${item.enter ? 'enter' : 'no-enter'}`;

beforeEach(() => localStorage.clear());

describe('phone-local shortcut layout', () => {
  it('falls back safely for missing or malformed storage', () => {
    expect(loadShortcutLayout('command')).toEqual({ hidden: [], order: [] });
    localStorage.setItem('hm_shortcut_layout1_command', '{bad');
    expect(loadShortcutLayout('command')).toEqual({ hidden: [], order: [] });
    localStorage.setItem('hm_shortcut_layout1_command', JSON.stringify({ hidden: [1, 'key:C-c', 'key:C-c'], order: null }));
    expect(loadShortcutLayout('command')).toEqual({ hidden: ['key:C-c'], order: [] });
  });

  it('persists command and chat independently', () => {
    saveShortcutLayout('command', { hidden: [id(b)], order: [id(a)] });
    expect(loadShortcutLayout('command')).toEqual({ hidden: [id(b)], order: [id(a)] });
    expect(loadShortcutLayout('chat')).toEqual({ hidden: [], order: [] });
  });

  it('orders known identities, appends new items, and removes hidden identities', () => {
    expect(applyShortcutLayout([a, b, c], { hidden: [id(b)], order: [id(c), id(a)] }))
      .toEqual([c, a]);
    expect(applyShortcutLayout([a, b, c], { hidden: [], order: [id(b)] }))
      .toEqual([b, a, c]);
  });

  it('moves visible items and hide/show restores the former position', () => {
    const moved = moveShortcutInLayout({ hidden: [], order: [] }, [a, b, c], id(c), -1);
    expect(applyShortcutLayout([a, b, c], moved)).toEqual([a, c, b]);
    const hidden = hideShortcutInLayout(moved, [a, c, b], id(c));
    expect(applyShortcutLayout([a, b, c], hidden)).toEqual([a, b]);
    expect(applyShortcutLayout([a, b, c], showShortcutInLayout(hidden, id(c))))
      .toEqual([a, c, b]);
  });

  it('forgets deleted local identities and preserves position across an edit', () => {
    const layout = { hidden: [], order: [id(a), id(b), id(c)] };
    expect(removeShortcutFromLayout(layout, id(b)).order).toEqual([id(a), id(c)]);
    expect(replaceShortcutInLayout(layout, id(b), 'key:C-d').order)
      .toEqual([id(a), 'key:C-d', id(c)]);
  });
});
