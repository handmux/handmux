import { shortcutIdentity } from './shortcutMerge.js';

const KEY = (mode) => `hm_shortcut_layout1_${mode}`;
const empty = () => ({ hidden: [], order: [] });
const strings = (value) => [...new Set(Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item)
  : [])];

const normalize = (layout) => ({
  hidden: strings(layout?.hidden),
  order: strings(layout?.order),
});

export function loadShortcutLayout(mode) {
  try {
    const raw = localStorage.getItem(KEY(mode));
    return raw ? normalize(JSON.parse(raw)) : empty();
  } catch {
    return empty();
  }
}

export function saveShortcutLayout(mode, layout) {
  const normalized = normalize(layout);
  try { localStorage.setItem(KEY(mode), JSON.stringify(normalized)); } catch { /* private mode */ }
  return normalized;
}

export function applyShortcutLayout(items, layout) {
  const normalized = normalize(layout);
  const hidden = new Set(normalized.hidden);
  const remaining = new Map((Array.isArray(items) ? items : [])
    .map((item) => [shortcutIdentity(item), item]));
  const result = [];
  for (const identity of normalized.order) {
    if (hidden.has(identity) || !remaining.has(identity)) continue;
    result.push(remaining.get(identity));
    remaining.delete(identity);
  }
  for (const [identity, item] of remaining) {
    if (!hidden.has(identity)) result.push(item);
  }
  return result;
}

export function moveShortcutInLayout(layout, visibleItems, identity, direction) {
  const ids = applyShortcutLayout(visibleItems, layout).map(shortcutIdentity);
  const from = ids.indexOf(identity);
  const to = from + (direction < 0 ? -1 : 1);
  if (from < 0 || to < 0 || to >= ids.length) return normalize(layout);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return { ...normalize(layout), order: ids };
}

export function hideShortcutInLayout(layout, visibleItems, identity) {
  const normalized = normalize(layout);
  const order = applyShortcutLayout(visibleItems, normalized).map(shortcutIdentity);
  return { hidden: strings([...normalized.hidden, identity]), order };
}

export function showShortcutInLayout(layout, identity) {
  const normalized = normalize(layout);
  return { ...normalized, hidden: normalized.hidden.filter((item) => item !== identity) };
}

export function removeShortcutFromLayout(layout, identity) {
  const normalized = normalize(layout);
  return {
    hidden: normalized.hidden.filter((item) => item !== identity),
    order: normalized.order.filter((item) => item !== identity),
  };
}

export function replaceShortcutInLayout(layout, oldIdentity, newIdentity) {
  const normalized = showShortcutInLayout(layout, newIdentity);
  return {
    hidden: normalized.hidden.filter((item) => item !== oldIdentity),
    order: strings(normalized.order.map((item) => item === oldIdentity ? newIdentity : item)),
  };
}
