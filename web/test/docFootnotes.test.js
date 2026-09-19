// web/test/docFootnotes.test.js — the GFM footnote fix.
//
// Before this, `[^1]` with a definition rendered as a LINK to the definition text and the definition
// line vanished (marked 12 has no footnote support). Both halves are pinned here.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';
import { stripFootnoteDefs } from '../src/docFootnotes.js';

describe('stripFootnoteDefs', () => {
  it('lifts definitions out in document order and leaves the body alone', () => {
    const { source, notes } = stripFootnoteDefs('正文[^a]。\n\n[^a]: 第一条\n[^b]: 第二条\n其余段落');
    expect(notes).toEqual([{ id: 'a', text: '第一条' }, { id: 'b', text: '第二条' }]);
    expect(source).not.toContain('[^a]:');
    expect(source).toContain('其余段落');
  });
});

describe('renderMarkdown footnotes', () => {
  const doc = '参见脚注[^1]与另一条[^2]。\n\n行内代码 `[^1]` 不该变成引用。\n\n[^1]: 第一条说明。\n[^2]: 第二条说明。';

  it('renders a superscript reference and a notes list', () => {
    const html = renderMarkdown(doc, { baseDir: '/d' });
    expect(html).toContain('class="md-fn-ref"');
    expect(html).toContain('href="#fn-1"');
    expect(html).toContain('id="fn-1"');
    expect(html).toContain('第一条说明。');
    expect(html).toContain('第二条说明。');
    expect(html).toContain('md-footnotes');
  });

  it('does not turn a reference inside code into a footnote', () => {
    const html = renderMarkdown(doc, { baseDir: '/d' });
    expect(html).toContain('<code>[^1]</code>'); // the code sample is untouched
  });

  it('leaves an unresolved reference as literal text', () => {
    const html = renderMarkdown('没有定义的引用[^nope]在这里。', { baseDir: '/d' });
    expect(html).toContain('[^nope]');
    expect(html).not.toContain('md-fn-ref');
  });

  it('numbers notes by definition order and only lists the ones referenced', () => {
    const html = renderMarkdown('只引用第二条[^b]。\n\n[^a]: 甲\n[^b]: 乙', { baseDir: '/d' });
    expect(html).toContain('href="#fn-b"');
    expect(html).not.toContain('id="fn-a"'); // unreferenced note is not listed
    expect(html).toContain('乙');
  });
});
