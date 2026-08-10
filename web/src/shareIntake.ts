// Web Share Target intake (page side). sw.js stashes a shared file in the SHARE_CACHE under
// SHARE_PREFIX+encodeURIComponent(name) and redirects to /?share=1. Here we read it back into a File
// and consume it (one-shot: deleted on read, so a refresh won't re-trigger an upload). These two
// constants MUST match the SHARE_CACHE / SHARE_PREFIX in public/sw.js.
export const SHARE_CACHE = 'tmw-share-v1';
export const SHARE_PREFIX = '/__share__/';

// True when this load was launched by a share (the ?share flag sw.js redirects with).
export function hasShareFlag(search = (typeof location !== 'undefined' ? location.search : '')): boolean {
  try { return new URLSearchParams(search).has('share'); } catch { return false; }
}

// Strip ?share from the URL (keep path + hash) so a manual refresh doesn't look like a fresh share.
export function clearShareFlag(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  url.searchParams.delete('share');
  // Preserve state (not null): keep any back-button guard/overlay marker on the current entry intact.
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

// Pull the most-recently shared file out of the cache and delete it (consume). Returns a File, or
// null if there's nothing pending / the Cache API is unavailable. The name comes from the cache key,
// the type from the cached Response's Content-Type.
export async function takeSharedFile(): Promise<File | null> {
  if (typeof caches === 'undefined') return null;
  let cache: Cache;
  try { cache = await caches.open(SHARE_CACHE); } catch { return null; }
  const keys = await cache.keys();
  if (!keys.length) return null;
  const reqKey = keys[keys.length - 1]; // newest (sw.js clears old entries, so usually the only one)
  if (!reqKey) return null;
  const res = await cache.match(reqKey);
  await cache.delete(reqKey);
  if (!res) return null;
  const blob = await res.blob();
  let name = 'shared';
  try { name = decodeURIComponent(new URL(reqKey.url).pathname.slice(SHARE_PREFIX.length)) || 'shared'; }
  catch { /* keep the fallback name */ }
  return new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || '' });
}
