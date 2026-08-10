import { shortcutIdentity } from './shortcutMerge.js';
import type { ShortcutItem } from './shortcutMerge.js';

export type StoredFav = Omit<ShortcutItem, 'source'>;

export type FavMutationResult =
  | { ok: true; items: StoredFav[] }
  | { ok: false; reason: 'conflict' | 'missing'; items: StoredFav[] };

export type FavTransferResult =
  | { ok: true; source: StoredFav[]; target: StoredFav[] }
  | { ok: false; reason: 'conflict' | 'missing'; source: StoredFav[]; target: StoredFav[] };

// Only phone-local additions live here. Shared config provides shortcut content; a device-local layout may
// hide or reorder those shared actions without ever writing the shared server config. v7 makes text Enter
// behavior explicit, so same-text actions with different Enter behavior have distinct identities.
const KEY = (mode: string): string => `hm_favs7_${mode}`;
const OLD_KEY = (mode: string): string => `hm_favs6_${mode}`;

// Command-mode saved commands split into two lists: the GLOBAL one (scope 'command' — the original list,
// so existing commands stay put) shown first, and a PER-WINDOW one keyed by the tmux window id (following
// the preview-dir precedent of keying persistent per-window data by window.id). Each item may carry an
// `enter` flag: tapping it types the command AND presses Enter (runs it) rather than just typing it.
export const CMD_GLOBAL = 'command';
export const cmdScope = (windowId: string | null | undefined): string => (
  windowId ? `command@${windowId}` : CMD_GLOBAL
);

export const DEFAULT_FAVS: Record<'command' | 'agent', StoredFav[]> = {
  command: [],
  agent: [],
};

const LEGACY_KEYS: Record<string, StoredFav | undefined> = {
  ESC: { kind: 'key', text: 'Escape', label: 'Esc' },
  Esc: { kind: 'key', text: 'Escape', label: 'Esc' },
  Tab: { kind: 'key', text: 'Tab', label: 'Tab' },
  '⌫': { kind: 'key', text: 'BSpace', label: '⌫' },
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
);

function normalizeStoredFav(value: unknown): StoredFav | null {
  const item = asRecord(value);
  if (!item || typeof item.text !== 'string'
    || (item.kind !== 'key' && item.kind !== 'reply' && item.kind !== 'cmd')) return null;
  if (item.kind === 'key') {
    return {
      kind: 'key',
      text: item.text,
      label: typeof item.label === 'string' ? item.label : item.text,
    };
  }
  return { kind: item.kind, text: item.text, enter: !!item.enter };
}

const parseStoredFavs = (value: unknown): StoredFav[] => (
  Array.isArray(value)
    ? value.map(normalizeStoredFav).filter((item): item is StoredFav => item !== null)
    : []
);

function migrateV6(mode: string, value: unknown): StoredFav[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = asRecord(candidate);
    if (!item || typeof item.text !== 'string') return [];
    const kind = item.kind === 'key' || item.kind === 'reply' || item.kind === 'cmd'
      ? item.kind
      : (mode === 'agent' && !item.text.startsWith('/') ? 'reply' : 'cmd');
    const legacy = kind !== 'key' ? LEGACY_KEYS[item.text] : undefined;
    if (legacy) return [{ ...legacy }];
    if (kind === 'key') {
      return [{
        kind: 'key' as const,
        text: item.text,
        label: typeof item.label === 'string' && item.label ? item.label : item.text,
      }];
    }
    return [{ kind, text: item.text, enter: mode === 'agent' ? true : !!item.enter }];
  });
}

export function loadFavs(mode: string): StoredFav[] {
  try {
    const raw = localStorage.getItem(KEY(mode));
    if (raw) return parseStoredFavs(JSON.parse(raw));
    const oldRaw = localStorage.getItem(OLD_KEY(mode));
    if (oldRaw) {
      const migrated = migrateV6(mode, JSON.parse(oldRaw));
      saveFavs(mode, migrated);
      return migrated;
    }
  } catch { /* fall through to defaults */ }
  const defaults = mode === 'command' || mode === 'agent' ? DEFAULT_FAVS[mode] : [];
  return defaults.map((fav) => ({ ...fav }));
}

export function saveFavs(mode: string, items: StoredFav[]): StoredFav[] {
  try { localStorage.setItem(KEY(mode), JSON.stringify(items)); } catch { /* no localStorage */ }
  return items;
}

function storedFav(item: ShortcutItem): StoredFav {
  return item.kind === 'key'
    ? {
      kind: 'key',
      text: item.text,
      ...(item.label !== undefined ? { label: item.label } : {}),
    }
    : { kind: item.kind, text: item.text, enter: !!item.enter };
}

export function addFavResult(mode: string, item: ShortcutItem): FavMutationResult {
  const items = loadFavs(mode);
  const identity = shortcutIdentity(item);
  if (items.some((f) => shortcutIdentity(f) === identity)) {
    return { ok: false, reason: 'conflict', items };
  }
  // A key fav (kind 'key') carries a pretty label (⌃C); a command carries the enter flag.
  const next = saveFavs(mode, [...items, storedFav(item)]);
  return { ok: true, items: next };
}

export function addFav(mode: string, item: ShortcutItem): StoredFav[] {
  return addFavResult(mode, item).items;
}

export function removeFav(mode: string, text: string): StoredFav[] {
  return saveFavs(mode, loadFavs(mode).filter((f) => f.text !== text));
}

export function removeFavByIdentity(mode: string, identity: string): StoredFav[] {
  return saveFavs(mode, loadFavs(mode).filter((f) => shortcutIdentity(f) !== identity));
}

// Replace the exact identity while keeping its position. Same-text actions with different Enter behavior
// remain independently addressable throughout edit and cross-scope flows.
export function updateFavResult(
  mode: string,
  oldIdentity: string,
  item: ShortcutItem,
): FavMutationResult {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => shortcutIdentity(f) === oldIdentity);
  if (i < 0) return { ok: false, reason: 'missing', items };
  const newIdentity = shortcutIdentity(item);
  if (items.some((f, k) => k !== i && shortcutIdentity(f) === newIdentity)) {
    return { ok: false, reason: 'conflict', items };
  }
  const next = items.slice();
  next[i] = storedFav(item);
  return { ok: true, items: saveFavs(mode, next) };
}

export function updateFav(mode: string, oldText: string, item: ShortcutItem): StoredFav[] {
  const old = loadFavs(mode).find((fav) => fav.text === oldText);
  if (!old) return loadFavs(mode);
  return updateFavResult(mode, shortcutIdentity(old), item).items;
}

// Move one item between scopes only after validating both lists. A target conflict is therefore a true
// no-op: neither source nor target is written, and callers can keep their UI/layout unchanged too.
export function transferFavResult(
  oldMode: string,
  oldIdentity: string,
  newMode: string,
  item: ShortcutItem,
): FavTransferResult | FavMutationResult {
  if (oldMode === newMode) return updateFavResult(oldMode, oldIdentity, item);
  const source = loadFavs(oldMode);
  const target = loadFavs(newMode);
  if (!source.some((f) => shortcutIdentity(f) === oldIdentity)) {
    return { ok: false, reason: 'missing', source, target };
  }
  const newIdentity = shortcutIdentity(item);
  if (target.some((f) => shortcutIdentity(f) === newIdentity)) {
    return { ok: false, reason: 'conflict', source, target };
  }
  const nextSource = saveFavs(oldMode, source.filter((f) => shortcutIdentity(f) !== oldIdentity));
  const nextTarget = saveFavs(newMode, [...target, storedFav(item)]);
  return { ok: true, source: nextSource, target: nextTarget };
}

// Reorder one item by swapping it with its neighbour. dir < 0 = up, dir > 0 = down. No-op at the ends.
export function moveFav(mode: string, text: string, dir: number): StoredFav[] {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => f.text === text);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  const source = next[i];
  const target = next[j];
  if (!source || !target) return items;
  next[i] = target;
  next[j] = source;
  return saveFavs(mode, next);
}

// Swap two known visible neighbours at their real storage positions. Hidden effective-global duplicates may
// sit between them in the full window-local list, so swapping raw adjacent indexes would leave the UI still.
export function moveFavBeside(mode: string, text: string, neighbourText: string): StoredFav[] {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => f.text === text);
  const j = items.findIndex((f) => f.text === neighbourText);
  if (i < 0 || j < 0 || i === j) return items;
  const next = items.slice();
  const source = next[i];
  const target = next[j];
  if (!source || !target) return items;
  next[i] = target;
  next[j] = source;
  return saveFavs(mode, next);
}

export function moveFavBesideByIdentity(
  mode: string,
  identity: string,
  neighbourIdentity: string,
): StoredFav[] {
  const items = loadFavs(mode);
  const i = items.findIndex((f) => shortcutIdentity(f) === identity);
  const j = items.findIndex((f) => shortcutIdentity(f) === neighbourIdentity);
  if (i < 0 || j < 0 || i === j) return items;
  const next = items.slice();
  const source = next[i];
  const target = next[j];
  if (!source || !target) return items;
  next[i] = target;
  next[j] = source;
  return saveFavs(mode, next);
}
