// Only phone-local additions live here. Required presets come from config.json and are merged at render
// time, so local edits can never remove or reorder them. v7 makes text Enter behavior explicit.
const KEY = (mode) => `hm_favs7_${mode}`;
const OLD_KEY = (mode) => `hm_favs6_${mode}`;

// Command-mode saved commands split into two lists: the GLOBAL one (scope 'command' — the original list,
// so existing commands stay put) shown first, and a PER-WINDOW one keyed by the tmux window id (following
// the preview-dir precedent of keying persistent per-window data by window.id). Each item may carry an
// `enter` flag: tapping it types the command AND presses Enter (runs it) rather than just typing it.
export const CMD_GLOBAL = 'command';
export const cmdScope = (windowId) => (windowId ? `command@${windowId}` : CMD_GLOBAL);

export const DEFAULT_FAVS = {
  command: [],
  agent: [],
};

const LEGACY_KEYS = {
  ESC: { kind: 'key', text: 'Escape', label: 'Esc' },
  Esc: { kind: 'key', text: 'Escape', label: 'Esc' },
  Tab: { kind: 'key', text: 'Tab', label: 'Tab' },
  '⌫': { kind: 'key', text: 'BSpace', label: '⌫' },
};

function migrateV6(mode, items) {
  return items.map((item) => {
    if (item.kind !== 'key' && LEGACY_KEYS[item.text]) return { ...LEGACY_KEYS[item.text] };
    if (item.kind === 'key') return { kind: 'key', text: item.text, label: item.label || item.text };
    return { kind: item.kind, text: item.text, enter: mode === 'agent' ? true : !!item.enter };
  });
}

export function loadFavs(mode) {
  try {
    const raw = localStorage.getItem(KEY(mode));
    if (raw) return JSON.parse(raw);
    const oldRaw = localStorage.getItem(OLD_KEY(mode));
    if (oldRaw) {
      const migrated = migrateV6(mode, JSON.parse(oldRaw));
      saveFavs(mode, migrated);
      return migrated;
    }
  } catch { /* fall through to defaults */ }
  return (DEFAULT_FAVS[mode] || []).map((f) => ({ ...f }));
}

export function saveFavs(mode, items) {
  try { localStorage.setItem(KEY(mode), JSON.stringify(items)); } catch { /* no localStorage */ }
  return items;
}

export function addFav(mode, item) {
  const items = loadFavs(mode);
  if (items.some((f) => f.text === item.text)) return items; // dedupe by text
  // A key fav (kind 'key') carries a pretty label (⌃C); a command carries the enter flag.
  const next = item.kind === 'key'
    ? { kind: 'key', text: item.text, label: item.label }
    : { kind: item.kind, text: item.text, enter: !!item.enter };
  return saveFavs(mode, [...items, next]);
}

export function removeFav(mode, text) {
  return saveFavs(mode, loadFavs(mode).filter((f) => f.text !== text));
}

// Replace the item currently stored as `oldText` with `item`, KEEPING its position (used by the editor's
// re-open-to-edit flow). No-op if oldText is gone; rejected if the new text would collide with a DIFFERENT
// existing item (dedupe by text, same rule as addFav).
export function updateFav(mode, oldText, item) {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => f.text === oldText);
  if (i < 0) return items;
  if (items.some((f, k) => k !== i && f.text === item.text)) return items;
  const next = items.slice();
  next[i] = item.kind === 'key'
    ? { kind: 'key', text: item.text, label: item.label }
    : { kind: item.kind, text: item.text, enter: !!item.enter };
  return saveFavs(mode, next);
}

// Reorder one item by swapping it with its neighbour. dir < 0 = up, dir > 0 = down. No-op at the ends.
export function moveFav(mode, text, dir) {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => f.text === text);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return saveFavs(mode, next);
}
