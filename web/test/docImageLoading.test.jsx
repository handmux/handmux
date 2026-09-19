// web/test/docImageLoading.test.jsx — the inline-image loading state.
//
// Two device-visible properties that jsdom can still pin down because they are about the CLASS
// lifecycle, not layout:
//   • a cache hit paints immediately and never shows the loading skeleton (the old code added the
//     class at render time, so every revisit flashed a placeholder);
//   • a real fetch DOES show the skeleton until the bytes land, and a failure degrades to a note
//     naming the cause.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// A controllable fetch: pending loads stay pending until the test resolves them.
let pending = [];
vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageUrl: vi.fn((path) => new Promise((resolve) => {
    pending.push(() => resolve({ url: `blob:${path}`, mtimeMs: 1 }));
  })),
}));

const { loadImage, __resetImageCacheForTest } = await import('../src/markdownImageCache.js');
const DocView = (await import('../src/components/DocView.jsx')).default;

let container, root;
beforeEach(() => {
  __resetImageCacheForTest();
  pending = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (content) => act(() => root.render(
  <DocView type="markdown" name="a.md" path="/repo/a.md" content={content} />,
));
const flush = () => act(async () => { await Promise.resolve(); });
const settlePending = async (promise) => {
  const queued = pending;
  pending = [];
  queued.forEach((resolve) => resolve());
  await promise;
};
const img = () => container.querySelector('img[data-handmux-src]');

describe('inline image loading state', () => {
  it('shows the skeleton while fetching, then drops it when the bytes arrive', async () => {
    await render('![x](pic.png)');
    expect(img()).not.toBeNull();
    expect(img().hasAttribute('src')).toBe(false); // no src === the CSS skeleton state
    await act(async () => { await settlePending(Promise.resolve()); });
    expect(img().getAttribute('src')).toBe('blob:/repo/pic.png'); // skeleton stops matching
  });

  it('never shows the skeleton for a cached image (no flash on revisit)', async () => {
    // prime the cache, as a previous view of this document would have
    await settlePending(loadImage('/repo/pic.png'));
    await render('![x](pic.png)');
    expect(img().getAttribute('src')).toBe('blob:/repo/pic.png'); // src in the first commit
  });

  it('degrades to a note with the reason when the file is gone', async () => {
    const api = await import('../src/api.js');
    api.fetchImageUrl.mockRejectedValueOnce(new Error('image -> 404'));
    await render('![图](missing.png)');
    await flush();
    const note = container.querySelector('.md-img-note');
    expect(note?.textContent).toContain('不存在');
    expect(container.querySelector('img[data-handmux-src]')).toBeNull();
  });
});
