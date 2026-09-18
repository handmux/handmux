// Blob-URL cache for authenticated inline markdown images. fetchImageUrl (api.ts) is the only
// sanctioned way to load a local image (Bearer header → blob URL); this module keeps those blob
// URLs alive across doc-tab switches and re-renders so an image is fetched at most once per
// (path, mtime). In-use entries can't be evicted — revoking a blob another <img> is displaying
// would break it — so eviction only reclaims entries with refs === 0.
import { fetchImageUrl } from './api.js';

const CACHE_MAX = 24;

interface CacheEntry {
  url: string;
  mtimeMs: number | null;
  refs: number;
}

const cache = new Map<string, CacheEntry>();   // insertion order = LRU order
const pending = new Map<string, Promise<CacheEntry>>();

// Make room for one more entry BEFORE it is inserted — evicting after insertion could select the
// brand-new entry itself (its refs are still 0 until the caller acquires). Stops at the cap or when
// every remaining entry is in use (in-use entries must never be evicted — revoking a blob another
// <img> is displaying would break it); temporary growth past the cap is accepted over that.
function makeRoom(): void {
  while (cache.size >= CACHE_MAX) {
    let oldest: string | null = null;
    for (const [key, entry] of cache) {
      if (entry.refs === 0) { oldest = key; break; }   // first zero-ref key is the oldest
    }
    if (oldest === null) return;                        // everything in use — accept temporary growth
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) URL.revokeObjectURL(entry.url);
  }
}

/** Take a reference on the cached blob URL for `path` (LRU-touches it), or null on a miss. */
export function acquireImage(path: string): CacheEntry | null {
  const hit = cache.get(path) || null;
  if (hit) {
    cache.delete(path);
    cache.set(path, hit);
    hit.refs += 1;
  }
  return hit;
}

/** Drop a reference taken by acquireImage. Never revokes — eviction owns blob lifetime. */
export function releaseImage(path: string): void {
  const entry = cache.get(path);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

/** Load `path` through the authenticated pipeline and cache the blob URL. Concurrent callers share
 *  one request (pending), so two <img>s for the same path fetch once. */
export function loadImage(path: string): Promise<CacheEntry> {
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;
  const load = (async (): Promise<CacheEntry> => {
    const hit = cache.get(path);
    const response = await fetchImageUrl(path, hit ? hit.mtimeMs : null);
    if (!('notModified' in response) || !response.notModified) {
      const entry: CacheEntry = { url: response.url, mtimeMs: response.mtimeMs, refs: 0 };
      const old = cache.get(path);
      cache.delete(path);
      makeRoom();
      cache.set(path, entry);
      // The old blob may still be displayed elsewhere (file changed mid-view) — leak that one URL
      // rather than break a visible <img>; a stale entry is at most one image.
      if (old && old.url !== entry.url && old.refs === 0) URL.revokeObjectURL(old.url);
      return entry;
    }
    // 304: the cached blob is still current (hit must exist — we passed its mtime).
    if (hit) return hit;
    throw new Error('image not modified but not cached');
  })().finally(() => { pending.delete(path); });
  pending.set(path, load);
  return load;
}

/** Test-only: forget every entry (revoking in-use URLs too) so tests start clean. */
export function __resetImageCacheForTest(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  pending.clear();
}

/** Test-only: read the live cache (order + entries) to assert LRU behavior. */
export function __imageCacheEntriesForTest(): Array<[string, CacheEntry]> {
  return Array.from(cache.entries());
}
