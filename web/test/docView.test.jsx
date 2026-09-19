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
