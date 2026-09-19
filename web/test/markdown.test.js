// web/test/markdown.test.js — shared markdown pipeline (web/src/markdown.ts)
import { describe, it, expect, beforeEach } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';
import { __resetImageCacheForTest } from '../src/markdownImageCache.js';

beforeEach(() => { __resetImageCacheForTest(); });

describe('renderMarkdown — frontmatter', () => {
  it('strips a valid frontmatter block', () => {
    const out = renderMarkdown('---\ntitle: x\n---\n\n# Head');
    expect(out).toContain('<h1');
    expect(out).not.toContain('title:');
  });
  it('keeps the source when the block never closes', () => {
    const out = renderMarkdown('---\ntitle: x\nno closer');
    expect(out).toContain('title: x');
  });
  it('does not touch a document that only starts with --- later', () => {
    const out = renderMarkdown('# Head\n\n---\n\nrule');
    expect(out).toContain('rule');
  });
});

describe('renderMarkdown — doc mode images (baseDir set)', () => {
  it('rewrites a relative image to an authenticated placeholder', () => {
    const out = renderMarkdown('![](pic.png)', { baseDir: '/Users/x/docs' });
    expect(out).toContain('data-handmux-src="/Users/x/docs/pic.png"');
    expect(out).not.toContain('src="pic.png"');
  });
  it('resolves ../ and keeps absolute paths', () => {
    expect(renderMarkdown('![](../img/a.png)', { baseDir: '/Users/x/docs' }))
      .toContain('data-handmux-src="/Users/x/img/a.png"');
    expect(renderMarkdown('![](/abs/a.png)', { baseDir: '/Users/x/docs' }))
      .toContain('data-handmux-src="/abs/a.png"');
  });
  it('keeps ~/ paths as-is for the loader', () => {
    expect(renderMarkdown('![](~/p/a.png)', { baseDir: '/Users/x/docs' }))
      .toContain('data-handmux-src="~/p/a.png"');
  });
  it('keeps an https image direct', () => {
    const out = renderMarkdown('![](https://e.com/a.png)', { baseDir: '/d' });
    expect(out).toContain('src="https://e.com/a.png"');
    expect(out).not.toContain('data-handmux-src');
  });
  it('strips a non-http(s) scheme image (data:, javascript:)', () => {
    const out = renderMarkdown('![alt](data:image/png;base64,AAAA)', { baseDir: '/d' });
    expect(out).not.toContain('<img');
    expect(out).toContain('alt');
  });
  it('covers raw inline HTML images, not just md syntax', () => {
    const out = renderMarkdown('<img src="pic.png" alt="p">', { baseDir: '/d' });
    expect(out).toContain('data-handmux-src="/d/pic.png"');
  });

  it('decodes percent-encoded non-ASCII and space destinations (marked encodes them)', () => {
    // `![x](assets/图片示例.png)` reaches us as `assets/%E5%9B%BE...png`; handing that to the loader
    // double-encodes it and the server looks for a file literally named `%E5%9B%BE...`.
    expect(renderMarkdown('![x](assets/图片示例.png)', { baseDir: '/repo' }))
      .toContain('data-handmux-src="/repo/assets/图片示例.png"');
    expect(renderMarkdown('![x](<assets/图片 示例.png>)', { baseDir: '/repo' }))
      .toContain('data-handmux-src="/repo/assets/图片 示例.png"');
    expect(renderMarkdown('![x](assets/图片%20示例.png)', { baseDir: '/repo' }))
      .toContain('data-handmux-src="/repo/assets/图片 示例.png"');
  });

  it('keeps an encoded #/% as part of the filename and survives a malformed escape', () => {
    expect(renderMarkdown('![x](a%23b.png)', { baseDir: '/r' }))
      .toContain('data-handmux-src="/r/a#b.png"'); // %23 is a filename char, not a fragment
    expect(renderMarkdown('![x](100%.png)', { baseDir: '/r' }))
      .toContain('data-handmux-src="/r/100%.png"'); // never throws mid-render
  });

  it('emits the image without a src, which is what the CSS paints as the loading skeleton', () => {
    const out = renderMarkdown('![x](a.png)', { baseDir: '/r' });
    expect(out).toContain('data-handmux-src="/r/a.png"');
    expect(out).not.toMatch(/<img[^>]*\ssrc=/); // no src until the loader assigns a blob URL
    expect(out).not.toContain('md-img-loading'); // no JS-toggled class to flash on a cache hit
  });
});

describe('renderMarkdown — bubble mode images (no baseDir)', () => {
  it('strips images but keeps alt text', () => {
    const out = renderMarkdown('![a diagram](diagram.png)', { links: true });
    expect(out).not.toContain('<img');
    expect(out).toContain('a diagram');
  });
  it('strips an image without alt entirely', () => {
    const out = renderMarkdown('before ![](x.png) after', { links: true });
    expect(out).not.toContain('<img');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });
});

describe('renderMarkdown — sanitization still holds', () => {
  it('drops event handlers', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>ok', { baseDir: '/d' });
    expect(out).not.toContain('onerror');
  });
  it('drops javascript: links', () => {
    const out = renderMarkdown('[x](javascript:alert(1))', { links: true });
    expect(out).not.toContain('javascript:');
  });
});

describe('renderMarkdown — linkify (bubble mode)', () => {
  it('wraps a bare doc path in an anchor', () => {
    const out = renderMarkdown('see /Users/x/notes.md please', { links: true });
    const anchor = /<a [^>]*data-handmux-output-link="doc"[^>]*>/.exec(out);
    expect(anchor).not.toBeNull();
    expect(out).toContain('/Users/x/notes.md');
  });
  it('wraps a bare URL in an anchor', () => {
    const out = renderMarkdown('docs at https://example.com/x ok', { links: true });
    // marked auto-links the URL; the DOM pass keeps the anchor only because it resolves to a real
    // output link (an anchor to nowhere would have been unwrapped).
    expect(out).toContain('<a href="https://example.com/x"');
  });
  it('doc mode does not linkify', () => {
    const out = renderMarkdown('see /Users/x/notes.md', { baseDir: '/d' });
    expect(out).not.toContain('data-handmux-output-link');
  });
});
