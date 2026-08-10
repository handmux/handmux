import { shortcutIdentity } from './shortcutMerge.js';
import type { ShortcutIdentityInput } from './shortcutMerge.js';

export interface ShortcutLayout {
  hidden: string[];
  order: string[];
}

const KEY = (mode: string): string => `hm_shortcut_layout1_${mode}`;
const empty = (): ShortcutLayout => ({ hidden: [], order: [] });
const strings = (value: unknown): string[] => [...new Set(Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item)
  : [])];

const normalize = (layout: unknown): ShortcutLayout => {
  const candidate = layout && typeof layout === 'object'
    ? layout as { hidden?: unknown; order?: unknown }
    : {};
  return {
    hidden: strings(candidate.hidden),
    order: strings(candidate.order),
  };
};

export function loadShortcutLayout(mode: string): ShortcutLayout {
  try {
    const raw = localStorage.getItem(KEY(mode));
    return raw ? normalize(JSON.parse(raw)) : empty();
  } catch {
    return empty();
  }
}

export function saveShortcutLayout(mode: string, layout: unknown): ShortcutLayout {
  const normalized = normalize(layout);
  try { localStorage.setItem(KEY(mode), JSON.stringify(normalized)); } catch { /* private mode */ }
  return normalized;
}

export function applyShortcutLayout<T extends ShortcutIdentityInput>(
  items: readonly T[],
  layout: unknown,
): T[] {
  const normalized = normalize(layout);
  const hidden = new Set(normalized.hidden);
  const remaining = new Map(items
    .map((item) => [shortcutIdentity(item), item]));
  const result: T[] = [];
  for (const identity of normalized.order) {
    if (hidden.has(identity) || !remaining.has(identity)) continue;
    result.push(remaining.get(identity)!);
    remaining.delete(identity);
  }
  for (const [identity, item] of remaining) {
    if (!hidden.has(identity)) result.push(item);
  }
  return result;
}

export function moveShortcutInLayout(
  layout: unknown,
  visibleItems: readonly ShortcutIdentityInput[],
  identity: string,
  direction: number,
): ShortcutLayout {
  const normalized = normalize(layout);
  const ids = applyShortcutLayout(visibleItems, layout).map(shortcutIdentity);
  const from = ids.indexOf(identity);
  const to = from + (direction < 0 ? -1 : 1);
  if (from < 0 || to < 0 || to >= ids.length) return normalized;
  const fromId = ids[from];
  const toId = ids[to];
  if (fromId === undefined || toId === undefined) return normalized;
  ids[from] = toId;
  ids[to] = fromId;
  const hidden = new Set(normalized.hidden);
  const visible = new Set(ids);
  let nextVisible = 0;
  const order: string[] = [];
  for (const current of normalized.order) {
    if (hidden.has(current)) order.push(current);
    else if (visible.has(current)) {
      const next = ids[nextVisible++];
      if (next !== undefined) order.push(next);
    }
  }
  order.push(...ids.slice(nextVisible));
  return { ...normalized, order: strings(order) };
}

export function hideShortcutInLayout(
  layout: unknown,
  visibleItems: readonly ShortcutIdentityInput[],
  identity: string,
): ShortcutLayout {
  const normalized = normalize(layout);
  const order = applyShortcutLayout(visibleItems, normalized).map(shortcutIdentity);
  return { hidden: strings([...normalized.hidden, identity]), order };
}

export function showShortcutInLayout(layout: unknown, identity: string): ShortcutLayout {
  const normalized = normalize(layout);
  return { ...normalized, hidden: normalized.hidden.filter((item) => item !== identity) };
}

export function removeShortcutFromLayout(layout: unknown, identity: string): ShortcutLayout {
  const normalized = normalize(layout);
  return {
    hidden: normalized.hidden.filter((item) => item !== identity),
    order: normalized.order.filter((item) => item !== identity),
  };
}

export function replaceShortcutInLayout(
  layout: unknown,
  oldIdentity: string,
  newIdentity: string,
): ShortcutLayout {
  const normalized = showShortcutInLayout(layout, newIdentity);
  return {
    hidden: normalized.hidden.filter((item) => item !== oldIdentity),
    order: strings(normalized.order.map((item) => item === oldIdentity ? newIdentity : item)),
  };
}
