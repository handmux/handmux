// web/test/markdownImageCache.test.js — blob-URL LRU cache (web/src/markdownImageCache.ts)
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const origFetchImageUrl = { present: true }; // marker: api.js is mocked below; direct use avoided

let nextMtime = 1;
const blobs = []; // { url, revoked }
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchImageUrl: vi.fn(async (path, sinceMtime) => {
      if (path === '/missing.png') throw new Error('image -> 404');
      if (path === '/stale.png') throw new Error('image -> 304'); // server never 304s without a hit
      if (path === '/volatile.png' && sinceMtime != null) return { notModified: true };
      const url = `blob:${path}#${nextMtime}`;
      const mtimeMs = nextMtime++;
      blobs.push({ url, revoked: false });
      return { url, mtimeMs };
    }),
  };
});

const { acquireImage, releaseImage, loadImage, __resetImageCacheForTest, __imageCacheEntriesForTest } =
  await import('../src/markdownImageCache.js');

// jsdom has no createObjectURL/revokeObjectURL — stub the pair BEFORE importing the module under
// test (its module scope calls URL.revokeObjectURL). Our stub records revocations instead.
const realRevoke = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : null;
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:stub-${Math.random()}`;
}
URL.revokeObjectURL = (url) => {
  const entry = blobs.find((b) => b.url === url);
  if (entry) entry.revoked = true;
  else realRevoke?.(url);
};
beforeEach(() => {
  __resetImageCacheForTest();
  blobs.length = 0;
  nextMtime = 1;
});
afterAll(() => { if (realRevoke) URL.revokeObjectURL = realRevoke; });

describe('markdownImageCache', () => {
  it('loads once and serves later acquires from cache', async () => {
    await loadImage('/a.png');
    const hit = acquireImage('/a.png');
    expect(hit?.url).toBe('blob:/a.png#1');
    releaseImage('/a.png');
    const again = acquireImage('/a.png');
    expect(again?.url).toBe('blob:/a.png#1'); // no second blob
    releaseImage('/a.png');
  });
  it('shares one request between concurrent callers', async () => {
    const [x, y] = await Promise.all([loadImage('/a.png'), loadImage('/a.png')]);
    expect(x.url).toBe('blob:/a.png#1');
    expect(y.url).toBe(x.url);
  });
  it('re-fetches when mtime changed, revoking the old unreferenced blob', async () => {
    const first = await loadImage('/a.png');
    expect(first.mtimeMs).toBe(1);
    const second = await loadImage('/a.png'); // server mtime advanced → new blob
    expect(second.url).not.toBe(first.url);
    const old = blobs.find((b) => b.url === first.url);
    expect(old?.revoked).toBe(true);
  });
  it('keeps a referenced blob alive across reload', async () => {
    const first = await loadImage('/a.png');
    acquireImage('/a.png'); // in use
    const second = await loadImage('/a.png');
    const old = blobs.find((b) => b.url === first.url);
    expect(old?.revoked).toBe(false); // still displayed → not revoked
    expect(second.url).not.toBe(first.url);
  });
  it('propagates load failures', async () => {
    await expect(loadImage('/missing.png')).rejects.toThrow('404');
  });
  it('evicts the oldest unreferenced entry beyond the cap and revokes its blob', async () => {
    for (let i = 0; i < 26; i++) await loadImage(`/f${i}.png`);
    const entries = __imageCacheEntriesForTest();
    expect(entries.length).toBeLessThanOrEqual(24);
    const first = blobs.find((b) => b.url === 'blob:/f0.png#1');
    expect(first?.revoked).toBe(true);
    const last = blobs.find((b) => b.url === 'blob:/f25.png#26');
    expect(last?.revoked).toBe(false);
  });
  it('temporary growth: never evicts an in-use entry', async () => {
    for (let i = 0; i < 25; i++) {
      await loadImage(`/g${i}.png`);
      acquireImage(`/g${i}.png`); // everything stays referenced
    }
    const entries = __imageCacheEntriesForTest();
    expect(entries.length).toBe(25); // over cap but nothing revocable
    expect(entries.every(([, e]) => !blobs.find((b) => b.url === e.url)?.revoked)).toBe(true);
  });
});
