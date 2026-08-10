import { describe, it, expect } from 'vitest';
import {
  COMMAND_ROWS, CONTROL_KEYS, MODIFIERS, KEY_LABELS, REPEAT_KEYS, keyAction,
  MOD_OFF, MOD_ARMED, MOD_LOCKED, tapMod, modActive, consumeMods, withMods, buildChord,
} from '../src/keybarKeys.js';

describe('buildChord (save a key combo from the 按键 tab)', () => {
  it('Ctrl/Alt + letter → C-x / M-x with a full-name label (shift folds away for letters)', () => {
    expect(buildChord({ ctrl: true }, 'c')).toEqual({ name: 'C-c', label: 'Ctrl+C' });
    expect(buildChord({ ctrl: true }, 'C')).toEqual({ name: 'C-c', label: 'Ctrl+C' });
    expect(buildChord({ alt: true }, 'x')).toEqual({ name: 'M-x', label: 'Alt+X' });
    expect(buildChord({ ctrl: true, alt: true }, 'k')).toEqual({ name: 'C-M-k', label: 'Ctrl+Alt+K' });
  });
  it('named base keys stack modifiers; Shift+Tab is the dedicated BTab', () => {
    expect(buildChord({ shift: true }, 'Tab')).toEqual({ name: 'BTab', label: 'Shift+Tab' });
    expect(buildChord({ ctrl: true }, 'up')).toEqual({ name: 'C-Up', label: 'Ctrl+Up' });
    expect(buildChord({ shift: true }, 'left')).toEqual({ name: 'S-Left', label: 'Shift+Left' });
    expect(buildChord({}, 'enter')).toEqual({ name: 'Enter', label: 'Enter' });
    expect(buildChord({}, 'esc')).toEqual({ name: 'Escape', label: 'Esc' });
  });
  it('returns null for nothing sendable (empty, or a bare char with no modifier)', () => {
    expect(buildChord({}, '')).toBeNull();
    expect(buildChord({}, 'c')).toBeNull();       // just typing, not a key
    expect(buildChord({}, 'foo')).toBeNull();     // unknown multi-char base
  });
});

describe('command grid layout', () => {
  it('is a fixed 2×7 grid', () => {
    expect(COMMAND_ROWS).toHaveLength(2);
    for (const row of COMMAND_ROWS) expect(row).toHaveLength(7);
  });

  it('pins the corners: Esc/Tab top-left, ⌫ top-right, Enter bottom-right', () => {
    expect(COMMAND_ROWS[0]?.[0]).toBe('esc');
    expect(COMMAND_ROWS[0]?.[1]).toBe('tab');
    expect(COMMAND_ROWS[0]?.[6]).toBe('del');
    expect(COMMAND_ROWS[1]?.[6]).toBe('enter');
  });

  it('puts Alt in the former tilde slot and Space in the former Alt slot', () => {
    expect(COMMAND_ROWS[0]?.slice(0, 3)).toEqual(['esc', 'tab', 'alt']);
    expect(COMMAND_ROWS[1]?.slice(0, 3)).toEqual(['ctrl', 'shift', 'space']);
  });

  it('keeps only the / and @ symbols (tilde and the buried ones are gone)', () => {
    const ids = COMMAND_ROWS.flat();
    for (const s of ['slash', 'at']) expect(ids).toContain(s);
    for (const gone of ['tilde', 'pipe', 'dash', 'under', 'bslash', 'gt', 'lt']) {
      expect(ids).not.toContain(gone);
    }
  });

  it('places the arrows as an inverted-T just left of Enter (▲ over ◀ ▼ ▶)', () => {
    expect(COMMAND_ROWS[0]?.[4]).toBe('up');                              // ▲ above ▼
    expect(COMMAND_ROWS[1]?.slice(3, 6)).toEqual(['left', 'down', 'right']); // ◀ ▼ ▶, left of Enter
  });

  it('ctrl/shift/alt are the live modifiers; kbd is a control (the quick-bar toggle)', () => {
    expect(MODIFIERS).toEqual(['ctrl', 'shift', 'alt']);
    expect(CONTROL_KEYS).toEqual(['kbd']);
  });

  it('every grid id is labelled', () => {
    for (const row of COMMAND_ROWS) for (const id of row) expect(typeof KEY_LABELS[id]).toBe('string');
  });

  it('arrows and ⌫ auto-repeat', () => {
    expect([...REPEAT_KEYS].sort()).toEqual(['del', 'down', 'left', 'right', 'up']);
  });
});

describe('keyAction', () => {
  it('maps named keys, symbols, Space, and Enter/Backspace', () => {
    expect(keyAction('esc')).toEqual({ kind: 'key', name: 'Escape' });
    expect(keyAction('tab')).toEqual({ kind: 'key', name: 'Tab' });
    expect(keyAction('up')).toEqual({ kind: 'key', name: 'Up' });
    expect(keyAction('enter')).toEqual({ kind: 'key', name: 'Enter' });
    expect(keyAction('del')).toEqual({ kind: 'key', name: 'BSpace' });
    expect(keyAction('space')).toEqual({ kind: 'key', name: 'Space' });
    expect(keyAction('slash')).toEqual({ kind: 'text', ch: '/' });
    expect(keyAction('at')).toEqual({ kind: 'text', ch: '@' });
  });
  it('returns null for control ids, modifier ids, removed symbols, and unknowns', () => {
    expect(keyAction('kbd')).toBe(null);
    expect(keyAction('ctrl')).toBe(null);
    expect(keyAction('tilde')).toBe(null); // removed from the grid
    expect(keyAction('pipe')).toBe(null); // removed
    expect(keyAction('nope')).toBe(null);
  });
});

describe('live modifiers (ctrl/shift/alt)', () => {
  it('a tap cycles off -> armed -> locked -> off', () => {
    expect(tapMod(MOD_OFF)).toBe(MOD_ARMED);
    expect(tapMod(MOD_ARMED)).toBe(MOD_LOCKED);
    expect(tapMod(MOD_LOCKED)).toBe(MOD_OFF);
  });
  it('modActive true when armed or locked', () => {
    expect(modActive(MOD_OFF)).toBe(false);
    expect(modActive(MOD_ARMED)).toBe(true);
    expect(modActive(MOD_LOCKED)).toBe(true);
  });
  it('consuming collapses armed modifiers to off but keeps locked ones', () => {
    expect(consumeMods({ ctrl: MOD_ARMED, shift: MOD_LOCKED, alt: MOD_OFF }))
      .toEqual({ ctrl: MOD_OFF, shift: MOD_LOCKED, alt: MOD_OFF });
  });
  it('withMods composes Ctrl -> C-<x>, Alt -> M-<x> for letters/digits', () => {
    expect(withMods({ kind: 'text', ch: 'r' }, { ctrl: MOD_ARMED })).toEqual({ kind: 'key', name: 'C-r' });
    expect(withMods({ kind: 'text', ch: '1' }, { alt: MOD_LOCKED })).toEqual({ kind: 'key', name: 'M-1' });
  });
  it('withMods: Shift+Tab -> BTab, Shift+arrow -> S-<Arrow>', () => {
    expect(withMods({ kind: 'key', name: 'Tab' }, { shift: MOD_ARMED })).toEqual({ kind: 'key', name: 'BTab' });
    expect(withMods({ kind: 'key', name: 'Up' }, { shift: MOD_ARMED })).toEqual({ kind: 'key', name: 'S-Up' });
  });
  it('withMods leaves symbols/other untouched and no active modifier is a passthrough', () => {
    expect(withMods({ kind: 'text', ch: '|' }, { ctrl: MOD_ARMED })).toEqual({ kind: 'text', ch: '|' });
    expect(withMods({ kind: 'text', ch: 'r' }, { ctrl: MOD_OFF })).toEqual({ kind: 'text', ch: 'r' });
  });
});
