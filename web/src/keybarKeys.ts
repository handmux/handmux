// Pure key model for the mobile COMMAND keyboard (DOM-free, unit-tested on its own). Command mode shows
// a fixed 2-row grid (no horizontal scroll); the ⌨ toggle + the user's saved commands live in a separate
// quick-bar above it (BottomDock). keyAction() decides how a key is sent — a named tmux key via /keys, or
// a literal character via /send (enter:false).

export type CommandKeyId =
  | 'kbd' | 'esc' | 'up' | 'tab' | 'ctrl' | 'shift' | 'del'
  | 'left' | 'down' | 'right' | 'alt' | 'space' | 'slash' | 'at' | 'enter';
export type ModifierId = 'ctrl' | 'shift' | 'alt';
export type ModifierState = 'off' | 'armed' | 'locked';
export type ModifierStateMap = Record<ModifierId, ModifierState>;
export type ModifierStates = Partial<ModifierStateMap>;
export type KeyAction =
  | { kind: 'key'; name: string }
  | { kind: 'text'; ch: string };

export interface SavedChord {
  name: string;
  label: string;
}

// The command keyboard: a fixed 2×7 grid, never scrolls. Row 1: Esc/Tab (top-left), Alt, /, ▲, @ and ⌫.
// Row 2: Ctrl/Shift, a direct Space key, then the arrows and Enter. The arrows form the classic
// inverted-T (▲ over ◀ ▼ ▶) just LEFT of Enter,
// which sits in the bottom-right corner. 'kbd' is a CONTROL id (the quick-bar's keyboard toggle), handled
// by the view, not dispatched via keyAction. All the other buried shell symbols were removed on purpose.
export const COMMAND_ROWS: readonly (readonly CommandKeyId[])[] = [
  ['esc', 'tab', 'alt', 'slash', 'up', 'at', 'del'],
  ['ctrl', 'shift', 'space', 'left', 'down', 'right', 'enter'],
];

// Control ids: rendered as special buttons by the view, never dispatched as keys. ⌨ now lives in the
// quick-bar (a text button), not the grid.
export const CONTROL_KEYS: readonly CommandKeyId[] = ['kbd'];

// Live modifiers rendered as sticky keys (tap = arm one key, double-tap = lock).
export const MODIFIERS: readonly ModifierId[] = ['ctrl', 'shift', 'alt'];

export const KEY_LABELS: Record<CommandKeyId, string> = {
  kbd: '⌨', esc: 'Esc', up: '▲', tab: 'Tab', ctrl: 'Ctrl', shift: 'Shift', del: '⌫',
  left: '◀', down: '▼', right: '▶', alt: 'Alt', space: '␣', slash: '/', at: '@', enter: 'Enter',
};

// Arrows and ⌫ auto-repeat while held.
export const REPEAT_KEYS: ReadonlySet<CommandKeyId> = new Set(['up', 'down', 'left', 'right', 'del']);

const NAMED: Record<string, string> = {
  esc: 'Escape', tab: 'Tab', space: 'Space', del: 'BSpace', enter: 'Enter',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};
const CHARS: Record<string, string> = {
  slash: '/', at: '@',
};

export function keyAction(id: string): KeyAction | null {
  if (id in NAMED) return { kind: 'key', name: NAMED[id] };
  if (id in CHARS) return { kind: 'text', ch: CHARS[id] };
  return null; // control ids (kbd/fav) + modifiers (ctrl/shift/alt) are not dispatched as keys
}

// ── Live modifiers ────────────────────────────────────────────────────────────────────────────
// Each modifier is 'off' | 'armed' (one-shot: composes the next key then resets) | 'locked' (sticky
// until tapped off). A single tap cycles; a fast double-tap (view-side) jumps to locked.
export const MOD_OFF = 'off';
export const MOD_ARMED = 'armed';
export const MOD_LOCKED = 'locked';

export function tapMod(state: ModifierState): ModifierState {
  if (state === MOD_ARMED) return MOD_LOCKED;
  if (state === MOD_LOCKED) return MOD_OFF;
  return MOD_ARMED;
}
export const modActive = (state: ModifierState | undefined): boolean => (
  state === MOD_ARMED || state === MOD_LOCKED
);

// mods is a { ctrl, shift, alt } map of states. Any armed/locked one is active.
const anyActive = (mods: ModifierStates): boolean => MODIFIERS.some((m) => modActive(mods[m]));
// After a key composes: armed modifiers collapse to off, locked ones persist.
export function consumeMods(mods: ModifierStates): ModifierStateMap {
  const out: ModifierStateMap = { ctrl: MOD_OFF, shift: MOD_OFF, alt: MOD_OFF };
  for (const m of MODIFIERS) out[m] = mods[m] === MOD_ARMED ? MOD_OFF : (mods[m] ?? MOD_OFF);
  return out;
}

// Compose a resolved keyAction with the active modifiers into a tmux key:
//   Ctrl + letter/digit -> C-<x>;  Alt + letter/digit -> M-<x>
//   Shift + Tab -> BTab;  Shift + arrow -> S-Up/S-Down/S-Left/S-Right
// Anything else (symbols, no active modifier) passes through unchanged.
export function withMods(action: KeyAction | null, mods: ModifierStates): KeyAction | null {
  if (!action || !anyActive(mods)) return action;
  const ctrl = modActive(mods.ctrl), shift = modActive(mods.shift), alt = modActive(mods.alt);
  if (shift && action.kind === 'key') {
    if (action.name === 'Tab') return { kind: 'key', name: 'BTab' };
    if (['Up', 'Down', 'Left', 'Right'].includes(action.name)) return { kind: 'key', name: `S-${action.name}` };
  }
  if ((ctrl || alt) && action.kind === 'text' && /^[a-z0-9]$/i.test(action.ch)) {
    return { kind: 'key', name: `${ctrl ? 'C' : 'M'}-${action.ch.toLowerCase()}` };
  }
  return action;
}

// ── Chord builder (for saving a KEY fav, e.g. Ctrl+C) ───────────────────────────────────────────
// The command-editor's 按键 tab lets you save a key combo: pick modifiers (plain on/off booleans here,
// not the arm/lock states) + a base key, and this composes the tmux key NAME (sent via onKey → /keys)
// plus a pretty LABEL (Ctrl+C) for the chip. Modifiers are spelled out in full (Ctrl/Shift/Alt), joined
// with '+', never as ⌃⇧⌥ symbols. Returns null when there's nothing sendable (empty, or a bare character
// with no modifier — that's just typing, not a key).
const CHORD_NAMED: Record<string, string> = {                    // typed word → tmux key name
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  enter: 'Enter', ret: 'Enter', return: 'Enter', cr: 'Enter',
  esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  del: 'BSpace', bs: 'BSpace', bspace: 'BSpace', backspace: 'BSpace',
  home: 'Home', end: 'End', pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
};
const NAMED_DISPLAY: Record<string, string> = {
  Escape: 'Esc', BSpace: '⌫', Space: 'Space', PageUp: 'PgUp', PageDown: 'PgDn',
};

export function buildChord(
  mods: Partial<Record<ModifierId, boolean>>,
  base: string,
): SavedChord | null {
  const ctrl = !!mods.ctrl, shift = !!mods.shift, alt = !!mods.alt;
  const raw = (base || '').trim();
  if (!raw) return null;
  // Full modifier names, in Ctrl→Shift→Alt order, joined with '+' onto the base: e.g. Ctrl+Shift+Tab.
  const names: string[] = [];
  if (ctrl) names.push('Ctrl');
  if (shift) names.push('Shift');
  if (alt) names.push('Alt');
  const label = (baseDisplay: string): string => [...names, baseDisplay].join('+');
  const named = CHORD_NAMED[raw.toLowerCase()];
  if (named) {
    // Shift+Tab is tmux's dedicated BTab; otherwise stack C-/M-/S- prefixes onto the named key.
    const name = (named === 'Tab' && shift && !ctrl && !alt)
      ? 'BTab'
      : (ctrl ? 'C-' : '') + (alt ? 'M-' : '') + (shift ? 'S-' : '') + named;
    return { name, label: label(NAMED_DISPLAY[named] || named) };
  }
  if (raw.length !== 1) return null;          // an unknown multi-char base isn't a key
  if (!ctrl && !alt && !shift) return null;   // a bare character is just typing, not a key
  if (ctrl || alt) {                          // Ctrl/Alt + char → C-x / M-x (shift folds away for letters)
    return { name: (ctrl ? 'C-' : '') + (alt ? 'M-' : '') + raw.toLowerCase(),
      label: label(raw.toUpperCase()) };
  }
  return { name: raw.toUpperCase(), label: label(raw.toUpperCase()) }; // Shift + char → the uppercase char
}
