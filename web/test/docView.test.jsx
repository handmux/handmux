// web/test/docView.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DocView from '../src/components/DocView.jsx';

// Inline-image loading must never hit the network from a unit test: keep every authenticated image
// fetch pending, so the placeholder state (data-handmux-src, no src) is what the assertions see.
vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageUrl: vi.fn(() => new Promise(() => { /* never settles */ })),
}));

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (props) => act(() => root.render(<DocView {...props} />));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
// Let the idle-scheduled sentence marking (setTimeout 0) run inside act().
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

// jsdom has no Web Speech API. Install a minimal fake so the TTS paths (which only exist when
// speechSynthesis is present) become testable: `spoken` records every utterance in order.
let lastSynth = null;
function installSpeechMock() {
  const spoken = [];
  const synth = {
    speak: (utterance) => { spoken.push(utterance.text); },
    cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    getVoices: () => [{ lang: 'zh-CN', name: 'Fake', default: true }],
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  lastSynth = synth;
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
  };
  return spoken;
}
const installedSynth = () => lastSynth;

function installClipboard(written) {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (value) => { written.push(value); } },
    configurable: true,
  });
}

describe('DocView', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; });

  it('renders markdown to sanitized HTML', async () => {
    await render({ type: 'markdown', name: 'a.md', content: '# Title\n\nhello' });
    const md = container.querySelector('.doc-md');
    expect(md).not.toBeNull();
    expect(md.querySelector('h1')?.textContent).toBe('Title');
  });
  it('strips dangerous markup from markdown', async () => {
    await render({ type: 'markdown', name: 'x.md', content: '<img src=x onerror=alert(1)>ok' });
    expect(container.querySelector('.doc-md').innerHTML).not.toContain('onerror');
  });
  it('rewrites a relative markdown image into an authenticated placeholder (no src)', async () => {
    await render({ type: 'markdown', name: 'a.md', path: '/docs/a.md', content: '![pic](pic.png)' });
    const img = container.querySelector('.doc-md img');
    expect(img?.getAttribute('src')).toBeNull();
    expect(img?.getAttribute('data-handmux-src')).toBe('/docs/pic.png');
  });
  it('without a path, relative images degrade to alt text (no broken image)', async () => {
    await render({ type: 'markdown', name: 'a.md', content: '![pic](pic.png)' });
    expect(container.querySelector('.doc-md img')).toBeNull();
    expect(container.querySelector('.doc-md').textContent).toContain('pic');
  });
  it('strips javascript: links from markdown', async () => {
    await render({ type: 'markdown', name: 'x.md', content: '[click](javascript:alert(1))' });
    const a = container.querySelector('.doc-md a');
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('A+/A− stay on the bar and step the font level (persisted)', async () => {
    await render({ type: 'markdown', name: 'a.md', content: '# Title' });
    const md = () => container.querySelector('.doc-md');
    expect(md().style.fontSize).toBe('14px'); // default = level index 4
    await click(container.querySelector('[aria-label="放大字体"]'));
    expect(md().style.fontSize).toBe('16px'); // index 5
    expect(localStorage.getItem('tw_doc_font')).toBe('5');
    await click(container.querySelector('[aria-label="缩小字体"]'));
    expect(md().style.fontSize).toBe('14px'); // back to index 4
  });
  it('starts from the persisted level and disables A+ at the largest level', async () => {
    localStorage.setItem('tw_doc_font', '8'); // last index → 22px
    await render({ type: 'markdown', name: 'a.md', content: '# Title' });
    expect(container.querySelector('.doc-md').style.fontSize).toBe('22px');
    expect(container.querySelector('[aria-label="放大字体"]').disabled).toBe(true);
  });
  it('disables A− at the smallest level', async () => {
    localStorage.setItem('tw_doc_font', '0'); // first index → 10px
    await render({ type: 'markdown', name: 'a.md', content: '# Title' });
    expect(container.querySelector('.doc-md').style.fontSize).toBe('10px');
    expect(container.querySelector('[aria-label="缩小字体"]').disabled).toBe(true);
  });
  it('text docs get the toolbar too (font size, no read-aloud)', async () => {
    await render({ type: 'text', name: 'a.log', content: 'line' });
    expect(container.querySelector('.doc-toolbar')).not.toBeNull();
    expect(container.querySelector('[aria-label="放大字体"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="朗读"]')).toBeNull();
  });
  it('has no toolbar for an html doc', async () => {
    await render({ type: 'html', name: 'r.html', content: '<h1>hi</h1>' });
    expect(container.querySelector('.doc-toolbar')).toBeNull();
  });
  it('renders single-file html into a sandboxed iframe (no allow-same-origin)', async () => {
    await render({ type: 'html', name: 'r.html', content: '<h1>hi</h1>' });
    const f = container.querySelector('iframe.doc-iframe');
    expect(f).not.toBeNull();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('srcdoc')).toContain('<h1>hi</h1>');
  });
  it('renders an image (ImageViewer) with the object-URL and a zoom pill', async () => {
    await render({ type: 'image', name: 'a.png', content: 'blob:fake' });
    const img = container.querySelector('img.doc-image');
    expect(img.getAttribute('src')).toBe('blob:fake');
    expect(img.getAttribute('alt')).toBe('a.png');
    expect(container.querySelector('.doc-image-zoom')).toBeTruthy();
  });
  it('does NOT revoke the object-URL on unmount (tab switch must keep it alive)', async () => {
    const revoke = vi.fn();
    window.URL.revokeObjectURL = revoke;
    await render({ type: 'image', name: 'a.png', content: 'blob:keep' });
    await act(() => root.unmount()); // simulate switching away from the image tab
    root = createRoot(container);    // afterEach unmounts again; give it a fresh root
    expect(revoke).not.toHaveBeenCalled(); // URL is freed on tab CLOSE (App), not on unmount
  });
});

describe('DocView 目录 drawer', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; });

  const DOC = '# 一级\n\n正文。\n\n## 二级\n\n更多。\n\n### 三级\n\n结束。';

  it('lists the headings, indented by level, and is hidden when the doc has none', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    const button = container.querySelector('[aria-label="目录"]');
    expect(button).not.toBeNull();
    expect(button.classList.contains('doc-zoom-icon')).toBe(true); // a small icon control
    await click(button);
    const items = [...container.querySelectorAll('.doc-toc-item')];
    expect(items.map((item) => item.textContent)).toEqual(['一级', '二级', '三级']);
    expect(items[1].style.paddingLeft).toBe('26px'); // level 2 → 12 + 14
    expect(items[2].style.paddingLeft).toBe('40px'); // level 3 → 12 + 28
  });

  it('has no 目录 button for a document without headings', async () => {
    await render({ type: 'markdown', name: 'a.md', content: '只有正文。' });
    expect(container.querySelector('[aria-label="目录"]')).toBeNull();
    await render({ type: 'text', name: 'a.log', content: 'line' });
    expect(container.querySelector('[aria-label="目录"]')).toBeNull();
  });

  it('jumps to the heading by scrolling ONLY our container, and closes the drawer', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await render({ type: 'markdown', name: 'a.md', content: DOC });
      await click(container.querySelector('[aria-label="目录"]'));
      await click([...container.querySelectorAll('.doc-toc-item')][2]);
      expect(calls.length).toBe(1); // one scroll, on the doc container — never the page
      expect(typeof calls[0].top).toBe('number');
      expect(container.querySelector('.doc-toc')).toBeNull(); // closed after jumping
      // the heading carries a slug id so the jump has a target (same ids the 目录 lists)
      expect(container.querySelector('.doc-md h3').id).toBe('三级');
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('closes on the backdrop', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await click(container.querySelector('[aria-label="目录"]'));
    expect(container.querySelector('.doc-toc')).not.toBeNull();
    await click(container.querySelector('.doc-toc-backdrop'));
    expect(container.querySelector('.doc-toc')).toBeNull();
  });
});

describe('DocView 查找', () => {
  beforeEach(() => { localStorage.clear(); });
  const DOC = '# 标题\n\nalpha beta alpha。\n\n```js\nalpha();\n```';
  const type = (input, value) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('is just an icon until it is tapped, then becomes a search row', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    expect(container.querySelector('.doc-find')).toBeNull();
    await click(container.querySelector('[aria-label="在本文中查找"]'));
    expect(container.querySelector('.doc-find-input')).not.toBeNull();
    expect(container.querySelector('.doc-find-input').getAttribute('placeholder')).toBe('在本文中查找');
  });

  it('highlights every match, counts them, and steps through with ↑/↓', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await click(container.querySelector('[aria-label="在本文中查找"]'));
    await type(container.querySelector('.doc-find-input'), 'alpha');
    const marks = () => [...container.querySelectorAll('.doc-md mark.doc-find-hit')];
    expect(marks().length).toBe(3); // two in the prose + one in the code block
    expect(container.querySelector('.doc-find-count').textContent).toBe('1/3');
    expect(marks()[0].classList.contains('is-current')).toBe(true);
    await click(container.querySelector('[aria-label="下一个匹配"]'));
    expect(container.querySelector('.doc-find-count').textContent).toBe('2/3');
    expect(marks()[1].classList.contains('is-current')).toBe(true);
    await click(container.querySelector('[aria-label="上一个匹配"]')); // wraps back from 2 → 1? no: 1 → 0
    expect(container.querySelector('.doc-find-count').textContent).toBe('1/3');
  });

  it('scrolls only the document container when stepping matches (never the page)', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await render({ type: 'markdown', name: 'a.md', content: DOC });
      await click(container.querySelector('[aria-label="在本文中查找"]'));
      await type(container.querySelector('.doc-find-input'), 'alpha');
      expect(calls.length).toBeGreaterThan(0);
      const before = calls.length;
      await click(container.querySelector('[aria-label="下一个匹配"]'));
      expect(calls.length).toBe(before + 1);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('says so when nothing matches, and clears its marks when closed', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await click(container.querySelector('[aria-label="在本文中查找"]'));
    await type(container.querySelector('.doc-find-input'), 'zzzz');
    expect(container.querySelector('.doc-find-count').textContent).toBe('没有匹配');
    await click(container.querySelector('.doc-find [aria-label="关闭"]'));
    expect(container.querySelector('.doc-find')).toBeNull();
    expect(container.querySelectorAll('.doc-md mark.doc-find-hit').length).toBe(0);
    expect(container.querySelector('.doc-md h1').textContent).toBe('标题'); // text put back together
  });

  it('searches plain-text docs too', async () => {
    await render({ type: 'text', name: 'a.log', content: 'line one\nline two\nline one again' });
    await click(container.querySelector('[aria-label="在本文中查找"]'));
    await type(container.querySelector('.doc-find-input'), 'line one');
    expect(container.querySelectorAll('.doc-text mark.doc-find-hit').length).toBe(2);
  });

  it('does not damage read-aloud sentence markers', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush(); // sentence spans exist
    await click(container.querySelector('[aria-label="在本文中查找"]'));
    await type(container.querySelector('.doc-find-input'), 'alpha');
    await click(container.querySelector('.doc-find [aria-label="关闭"]'));
    // The spans that carry data-tts (the read-aloud position) must survive a search untouched.
    expect(container.querySelectorAll('.doc-md .tts-sent[data-tts]').length).toBeGreaterThan(0);
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
  });
});

describe('DocView P1 document features', () => {
  beforeEach(() => { localStorage.clear(); });

  const openMore = () => click(container.querySelector('[aria-label="文件信息"]'));

  it('shows the loading page while the bytes are on their way (a fresh open)', async () => {
    await render({ type: 'markdown', name: 'a.md', path: '/a.md', content: '', loading: true });
    expect(container.querySelector('.doc-loading')).not.toBeNull();
    expect(container.querySelector('.doc-md')).toBeNull(); // no half-rendered document
    expect(container.querySelector('.doc-loading-name')?.textContent).toBe('a.md');
  });

  it('reloading shows the same loading page until the refresh settles', async () => {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    await render({
      type: 'markdown', name: 'a.md', path: '/a.md', content: '# 标题',
      onReload: () => gate,
    });
    expect(container.querySelector('.doc-loading')).toBeNull();
    await openMore();
    await click([...container.querySelectorAll('.doc-info-action')]
      .find((b) => b.textContent.includes('重新加载')));
    // the feedback IS the loading page — no toast, and it must be visible even for an instant reload
    expect(container.querySelector('.doc-loading')).not.toBeNull();
    expect(container.querySelector('.doc-md')).toBeNull();
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 320)); // ≥ MIN_RELOAD_MS
    });
    expect(container.querySelector('.doc-loading')).toBeNull();
    expect(container.querySelector('.doc-md')).not.toBeNull();
  });

  it('重新加载 re-reads the file and gets the popover out of the way', async () => {
    const reloads = [];
    await render({
      type: 'markdown', name: 'a.md', path: '/a.md', content: 'x',
      mtimeMs: Date.UTC(2026, 0, 2, 3, 4), onReload: () => reloads.push(1),
    });
    await openMore();
    const button = [...container.querySelectorAll('.doc-info-action')]
      .find((b) => b.textContent.includes('重新加载'));
    expect(button).not.toBeUndefined();
    await click(button);
    expect(reloads).toHaveLength(1);
    expect(container.querySelector('.doc-info-pop')).toBeNull(); // document visible again
  });

  it('shows 字数/字符数 and copies the Markdown source', async () => {
    const written = [];
    installClipboard(written);
    const source = '# 标题\n\nhello world 中文。';
    await render({ type: 'markdown', name: 'a.md', path: '/a.md', content: source });
    await openMore();
    const rows = [...container.querySelectorAll('.doc-info-row')].map((row) => row.textContent);
    expect(rows.some((row) => row.includes('字数'))).toBe(true);
    expect(rows.some((row) => row.includes('字符数'))).toBe(true);
    const copySource = [...container.querySelectorAll('.doc-info-action')]
      .find((b) => b.textContent.includes('复制原文'));
    await click(copySource);
    expect(written).toEqual([source]); // the RAW source, not the rendered text
    expect(copySource.textContent).toContain('已复制');
  });

  it('gives every code block a one-tap copy that never starts read-aloud', async () => {
    const written = [];
    installClipboard(written);
    installSpeechMock();
    await render({
      type: 'markdown', name: 'a.md', path: '/a.md',
      content: '说明。\n\n```bash\necho hello\n```\n\n```js\nconst x = 1;\n```',
    });
    await flush();
    const buttons = [...container.querySelectorAll('.doc-code-copy')];
    expect(buttons).toHaveLength(2);
    await click(buttons[0]);
    expect(written).toEqual(['echo hello\n']);
    expect(container.querySelector('[aria-label="朗读"]')).not.toBeNull(); // never entered read-aloud
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
  });

  it('jumps to an in-document #anchor, using the same heading ids as the 目录', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await render({
        type: 'markdown', name: 'a.md', path: '/a.md',
        content: '# 第一章\n\n正文。\n\n## 小节 A\n\n内容。\n\n[跳转](#小节-a)',
      });
      const heading = [...container.querySelectorAll('.doc-md h2')].find((h) => h.textContent === '小节 A');
      expect(heading.id).toBe('小节-a'); // slug ids, so in-doc links resolve
      // marked percent-encodes a CJK fragment href; the handler decodes it back to the slug.
      const anchor = container.querySelector('.doc-md a[href^="#"]');
      expect(anchor.getAttribute('href')).toContain('%E5%B0%8F%E8%8A%82-a');
      await click(anchor);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.at(-1).top).toBeGreaterThanOrEqual(0);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('jumps to the heading named by an anchorRequest from a terminal link', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await render({
        type: 'markdown', name: 'notes.md', path: '/docs/notes.md',
        content: '# 开头\n\n正文。\n\n## 小节 A\n\n内容。\n\n## 结尾\n\n完。',
        anchorRequest: { anchor: '小节-a', at: 1234 },
      });
      expect(calls.length).toBeGreaterThan(0); // jumped on open
      const first = calls.length;
      // the same LINK tapped again issues a new request object → jumps again
      await render({
        type: 'markdown', name: 'notes.md', path: '/docs/notes.md',
        content: '# 开头\n\n正文。\n\n## 小节 A\n\n内容。\n\n## 结尾\n\n完。',
        anchorRequest: { anchor: '小节-a', at: 9999 },
      });
      expect(calls.length).toBeGreaterThan(first);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('says so when the requested anchor matches no heading (instead of doing nothing)', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await render({
        type: 'markdown', name: 'a.md', path: '/a.md', content: '# 标题\n\n正文。',
        anchorRequest: { anchor: '不存在的标题', at: 1 },
      });
      expect(calls).toEqual([]);
      expect(container.querySelector('.doc-info-note')?.textContent).toContain('不存在的标题');
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it('opens an http link in the app instead of navigating away', async () => {
    const opened = [];
    await render({
      type: 'markdown', name: 'a.md', path: '/a.md',
      content: '[站点](https://example.com/x)',
      onOpenUrl: (url) => opened.push(url),
    });
    const link = container.querySelector('.doc-md a');
    await act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }));
    });
    expect(opened).toEqual(['https://example.com/x']);
  });

  it('restores the remembered reading position for a document', async () => {
    localStorage.setItem('tw_doc_scroll', JSON.stringify({ '/a.md': 0.5 }));
    // jsdom has no layout, so give the container a scrollable size BEFORE the restore effect runs.
    const proto = Object.getPrototypeOf(document.createElement('div'));
    const sh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    Object.defineProperty(proto, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(proto, 'clientHeight', { get: () => 100, configurable: true });
    try {
      await render({ type: 'markdown', name: 'a.md', path: '/a.md', content: '# 标题\n\n正文。' });
      expect(container.querySelector('.doc-md-wrap').scrollTop).toBe(450); // 0.5 × (1000 − 100)
    } finally {
      if (sh) Object.defineProperty(proto, 'scrollHeight', sh);
      if (ch) Object.defineProperty(proto, 'clientHeight', ch);
    }
  });

  it('remembers the position when leaving the document', async () => {
    await render({ type: 'markdown', name: 'a.md', path: '/a.md', content: '# 标题\n\n正文。' });
    const wrap = container.querySelector('.doc-md-wrap');
    Object.defineProperty(wrap, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(wrap, 'clientHeight', { value: 100, configurable: true });
    wrap.scrollTop = 450;
    await act(() => root.unmount()); // leaving the tab flushes the position
    root = createRoot(container);
    expect(JSON.parse(localStorage.getItem('tw_doc_scroll'))['/a.md']).toBeCloseTo(0.5);
  });
});

describe('DocView read-aloud toolbar', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; });

  const DOC = '第一句话。第二句话。第三句话。';

  it('hides read-aloud entirely when the browser has no speech synthesis', async () => {
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    expect(container.querySelector('[aria-label="朗读"]')).toBeNull();
    expect(container.querySelector('.doc-player')).toBeNull();
  });

  it('starts reading from the beginning on ▶, and the button becomes pause', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(spoken[0]).toBe('第一句话。');
    expect(container.querySelector('[aria-label="暂停朗读"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="停止朗读"]').disabled).toBe(false);
  });

  it('tapping a sentence does NOT start reading while idle', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('.tts-sent[data-tts="2"]'));
    expect(spoken).toEqual([]); // a tap on idle text must not start playback
    expect(container.querySelector('[aria-label="朗读"]')).not.toBeNull();
  });

  it('tapping a sentence mid-read jumps there', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    await click(container.querySelector('.tts-sent[data-tts="2"]'));
    expect(spoken.at(-1)).toBe('第三句话。');
  });

  it('⏹ stops the read and returns the bar to ▶', async () => {
    installSpeechMock();
    const synth = window.speechSynthesis;
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    await click(container.querySelector('[aria-label="停止朗读"]'));
    expect(synth.cancel).toHaveBeenCalled();
    expect(container.querySelector('[aria-label="朗读"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="暂停朗读"]')).toBeNull();
  });

  it('倍速 cycles 1× → 1.25× → 1.5× and persists', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    const rate = () => container.querySelector('[aria-label="语速"]').textContent;
    expect(rate()).toBe('1×');
    await click(container.querySelector('[aria-label="语速"]'));
    expect(rate()).toBe('1.25×');
    await click(container.querySelector('[aria-label="语速"]'));
    expect(rate()).toBe('1.5×');
    expect(localStorage.getItem('tw_doc_rate')).toBe('1.5');
  });

  it('更多 opens a small popover with the file info and copies the path', async () => {
    const written = [];
    installClipboard(written);
    await render({
      type: 'markdown', name: 'a.md', path: '/docs/notes/a.md',
      size: 2048, mtimeMs: Date.UTC(2026, 0, 2, 3, 4), birthtimeMs: Date.UTC(2025, 11, 31, 1, 2),
      content: '# Title',
    });
    expect(container.querySelector('.doc-info-pop')).toBeNull();
    await click(container.querySelector('[aria-label="文件信息"]'));
    const pop = container.querySelector('.doc-info-pop');
    expect(pop).not.toBeNull();
    expect(pop.textContent).toContain('/docs/notes/a.md');
    expect(pop.textContent).toContain('2.0 KB');
    const copy = pop.querySelector('.doc-info-copy');
    expect(copy.getAttribute('aria-label')).toBe('复制路径');
    await click(copy);
    expect(written).toEqual(['/docs/notes/a.md']);
    expect(pop.querySelector('[aria-label="已复制"]')).not.toBeNull(); // icon swaps to a check mark
  });

  it('更多 shows 修改时间/创建时间 rows', async () => {
    await render({
      type: 'markdown', name: 'a.md', path: '/a.md', size: 512,
      mtimeMs: Date.UTC(2026, 0, 2, 3, 4), birthtimeMs: Date.UTC(2025, 11, 31, 1, 2),
      content: '# Title',
    });
    await click(container.querySelector('[aria-label="文件信息"]'));
    const pop = container.querySelector('.doc-info-pop');
    expect(pop.textContent).toContain('修改时间');
    expect(pop.textContent).toContain('创建时间');
    // every row resolved to a real value — the "—" placeholder means a field went missing
    expect(pop.textContent.match(/—/g) ?? []).toHaveLength(0);
    expect(pop.textContent).toContain('512 B');
  });

  it('a failed read-aloud says so instead of looking like a dead tap', async () => {
    installSpeechMock();
    installedSynth().speak = (utterance) => {
      // iOS reports not-allowed when speak() wasn't allowed to start.
      if (utterance.onerror) utterance.onerror({ error: 'not-allowed' });
    };
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('.doc-speak-error')).not.toBeNull();
    expect(container.querySelector('[aria-label="朗读"]')).not.toBeNull(); // back to idle, not stuck
  });

  it('a cancel() that throws still lets the tap respond (UI flips before the engine is touched)', async () => {
    installSpeechMock();
    // WebKit builds that throw synchronously out of speechSynthesis.cancel() used to leave the button
    // looking untouched, because the engine call ran before the state change.
    installedSynth().cancel = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('[aria-label="暂停朗读"]')).not.toBeNull();
  });

  it('a speak() that throws reports the engine error instead of failing silently', async () => {
    installSpeechMock();
    installedSynth().speak = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    const notice = container.querySelector('.doc-speak-error');
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('SecurityError');
    expect(container.querySelector('[aria-label="朗读"]')).not.toBeNull(); // recovered to idle
  });

  it('reads a REALISTIC document: prose AND code are read, frontmatter is not', async () => {
    const spoken = installSpeechMock();
    const markdown = [
      '---',
      'title: 测试文档',
      '---',
      '',
      '# 一级标题',
      '',
      '开头的一句话。',
      '',
      '## 小节',
      '',
      '```js',
      'const shouldBeRead = 1;',
      '```',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '参考 [链接](https://example.com) 与 `inline`。',
      '',
      '结尾的话。',
    ].join('\n');
    await render({ type: 'markdown', name: 'a.md', path: '/docs/a.md', content: markdown });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(spoken.length).toBeGreaterThan(0); // the tap must produce speech, not a silent no-op
    expect(spoken[0]).toContain('一级标题');
    expect(spoken.join(' ')).toContain('开头的一句话。');
    // The chain advances on each utterance's end, which the mock never fires — so assert the marked
    // sentence list instead: code is part of what will be read.
    const sentences = [...container.querySelectorAll('.doc-md .tts-sent[data-tts]')]
      .map((span) => span.textContent);
    expect(sentences.join(' ')).toContain('const shouldBeRead = 1;');
    expect(sentences.join(' ')).toContain('结尾的话。');
    expect(sentences.join(' ')).not.toContain('title:'); // frontmatter is not read aloud
  });

  it('a document with NO readable content still says so instead of a dead tap', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: '![](missing.png)' });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('.doc-speak-error')?.textContent).toContain('没有可朗读的正文');
  });

  it('a document with NO readable content still says so instead of a dead tap', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: '![](missing.png)' });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('.doc-speak-error')?.textContent).toContain('没有可朗读的正文');
  });

  it('a manual scroll pauses following, and the pill comes back to the spoken sentence', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('.doc-follow-pill')).toBeNull();
    // Our own scrollIntoView arms a short guard window; step past it to simulate the READER scrolling.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    await act(() => { container.querySelector('.doc-md-wrap').dispatchEvent(new Event('scroll')); });
    const pill = container.querySelector('.doc-follow-pill');
    expect(pill).not.toBeNull();
    await click(pill);
    expect(container.querySelector('.doc-follow-pill')).toBeNull(); // following resumed
    vi.restoreAllMocks();
  });
});
