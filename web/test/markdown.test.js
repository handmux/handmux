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
