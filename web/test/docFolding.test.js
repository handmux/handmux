// web/test/docFolding.test.js — collapsing sections in the document BODY.
//
// Every section heading carries a caret; the first h1 is the document title and always stays expanded.
// Folding hides that section's content up to the next heading of the same or higher level, so folding an
// h1 takes its h2/h3 with it. Folded content must also stay out of read-aloud and find.
import { describe, it, expect, beforeEach } from 'vitest';
import { installHeadingFolding } from '../src/docFolding.js';
import { renderMarkdown } from '../src/markdown.js';
import { markSentences } from '../src/voice/docSpeech.js';
import { runFind } from '../src/docFind.js';

const DOC = [
  '# 文档标题',
  '',
  '# 一级',
  '',
  '一级正文。',
  '',
  '## 二级 A',
  '',
  '二级正文 A。',
  '',
  '### 三级',
  '',
  '三级正文。',
  '',
  '## 二级 B',
  '',
  '二级正文 B。',
].join('\n');

function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  root.className = 'doc-md';
  root.innerHTML = renderMarkdown(DOC, { baseDir: '/d' });
  const cleanup = installHeadingFolding(root);
  return { root, cleanup };
}

const hidden = (root) => [...root.querySelectorAll('.md-section-hidden')].map((el) => el.textContent.trim());
const caretOf = (root, label) => [...root.querySelectorAll('h1, h2, h3')]
  .find((h) => h.textContent.trim() === label)?.querySelector('.md-fold');

beforeEach(() => { document.body.innerHTML = ''; });

describe('heading folding', () => {
  it('keeps the document title expanded and adds carets to section headings without touching text', () => {
    const { root } = mount();
    const [title, section] = root.querySelectorAll('h1');
    expect(title.textContent.trim()).toBe('文档标题');
    expect(title.classList.contains('md-document-title')).toBe(true);
    expect(title.querySelector('.md-fold')).toBeNull();
    expect(section.querySelector('.md-fold')).not.toBeNull();
    expect(section.textContent.trim()).toBe('一级'); // the caret contributes no text (slugs/find/TTS unaffected)
  });

  it('hides the section content but never a heading', () => {
    const { root } = mount();
    const caret = caretOf(root, '一级');
    caret.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // every paragraph goes, every heading stays (they are what you fold around)
    expect(hidden(root)).toEqual(['一级正文。', '二级正文 A。', '三级正文。', '二级正文 B。']);
    expect(root.querySelectorAll('h1, h2, h3').length).toBe(5);
    caret.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hidden(root)).toEqual([]);
  });

  it('stops at the next heading of the same level', () => {
    const { root } = mount();
    caretOf(root, '二级 A').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hidden(root)).toEqual(['二级正文 A。', '三级正文。']);
  });

  it('keeps a nested fold folded when its parent is folded and unfolded again', () => {
    const { root } = mount();
    caretOf(root, '二级 A').dispatchEvent(new MouseEvent('click', { bubbles: true })); // fold the child
    const parent = caretOf(root, '一级');
    parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));  // fold the parent
    parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));  // and unfold it
    expect(hidden(root)).toEqual(['二级正文 A。', '三级正文。']); // the child is still folded
  });

  it('drives the caret aria state', () => {
    const { root } = mount();
    const caret = caretOf(root, '一级');
    expect(caret.getAttribute('aria-label')).toBe('收起这一节');
    caret.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(caret.getAttribute('aria-label')).toBe('展开这一节');
  });

  it('keeps folded text out of read-aloud and find', () => {
    const { root } = mount();
    caretOf(root, '二级 B').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // read-aloud
    const sentences = markSentences(root);
    expect(sentences.join(' ')).not.toContain('二级正文 B');
    expect(sentences.join(' ')).toContain('二级正文 A');
    // find
    expect(runFind(root, '二级正文')).toBe(1); // only the visible one
    // and the folded paragraph really is the hidden one
    const hiddenNode = [...root.querySelectorAll('p')].find((p) => p.textContent.includes('B'));
    expect(hiddenNode.classList.contains('md-section-hidden')).toBe(true);
  });
});
