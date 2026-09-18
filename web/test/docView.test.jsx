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
function installSpeechMock() {
  const spoken = [];
  const synth = {
    speak: (utterance) => { spoken.push(utterance.text); },
    cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    getVoices: () => [{ lang: 'zh-CN', name: 'Fake', default: true }],
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
  };
  return spoken;
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

  it('A+/A− live in the typography sheet, step the font level and persist it', async () => {
    await render({ type: 'markdown', name: 'a.md', content: '# Title' });
    const md = () => container.querySelector('.doc-md');
    expect(md().style.fontSize).toBe('14px'); // default = level index 4
    expect(container.querySelector('[aria-label="放大字体"]')).toBeNull(); // not in the toolbar
    await click(container.querySelector('[aria-label="排版"]'));
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
    await click(container.querySelector('[aria-label="排版"]'));
    expect(container.querySelector('[aria-label="放大字体"]').disabled).toBe(true);
  });
  it('disables A− at the smallest level', async () => {
    localStorage.setItem('tw_doc_font', '0'); // first index → 10px
    await render({ type: 'markdown', name: 'a.md', content: '# Title' });
    expect(container.querySelector('.doc-md').style.fontSize).toBe('10px');
    await click(container.querySelector('[aria-label="排版"]'));
    expect(container.querySelector('[aria-label="缩小字体"]').disabled).toBe(true);
  });
  it('text docs get the toolbar too (Aa / ⋯, no read-aloud)', async () => {
    await render({ type: 'text', name: 'a.log', content: 'line' });
    expect(container.querySelector('.doc-toolbar')).not.toBeNull();
    expect(container.querySelector('[aria-label="排版"]')).not.toBeNull();
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

  it('switches from the idle toolbar to the reading toolbar while playing', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(spoken[0]).toBe('第一句话。');
    const player = container.querySelector('.doc-player');
    expect(player).not.toBeNull();
    expect(container.querySelector('[aria-label="上一句"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="下一句"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="停止朗读"]')).not.toBeNull();
    expect(container.querySelector('.doc-progress-num').textContent).toBe('1/3');
  });

  it('tapping a sentence reads on from that sentence (no scrubber needed)', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush(); // sentence spans are laid down for the tap target
    const third = container.querySelector('.tts-sent[data-tts="2"]');
    expect(third?.textContent).toBe('第三句话。');
    await click(third);
    expect(spoken[0]).toBe('第三句话。'); // starts exactly there, not from the top
    expect(container.querySelector('.doc-progress-num').textContent).toBe('3/3');
  });

  it('⏮/⏭ step one sentence at a time', async () => {
    const spoken = installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('.tts-sent[data-tts="1"]'));
    expect(spoken.at(-1)).toBe('第二句话。');
    await click(container.querySelector('[aria-label="下一句"]'));
    expect(spoken.at(-1)).toBe('第三句话。');
    await click(container.querySelector('[aria-label="上一句"]'));
    expect(spoken.at(-1)).toBe('第二句话。');
    expect(container.querySelector('.doc-progress-num').textContent).toBe('2/3');
  });

  it('⏮ is disabled on the first sentence', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    expect(container.querySelector('[aria-label="上一句"]').disabled).toBe(true);
  });

  it('auto-follow preference lives in the ⋯ sheet and persists', async () => {
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await click(container.querySelector('[aria-label="更多"]'));
    const follow = [...container.querySelectorAll('.sheet-action')]
      .find((b) => b.textContent.includes('自动滚动到朗读位置'));
    expect(follow?.textContent).toContain('开'); // default on
    await click(follow);
    expect(localStorage.getItem('tw_doc_follow')).toBe('0');
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

  it('the pill never appears when auto-follow is off', async () => {
    localStorage.setItem('tw_doc_follow', '0');
    installSpeechMock();
    await render({ type: 'markdown', name: 'a.md', content: DOC });
    await flush();
    await click(container.querySelector('[aria-label="朗读"]'));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    await act(() => { container.querySelector('.doc-md-wrap').dispatchEvent(new Event('scroll')); });
    expect(container.querySelector('.doc-follow-pill')).toBeNull();
    vi.restoreAllMocks();
  });
});
