// web/test/docView.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DocView from '../src/components/DocView.jsx';

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (props) => act(() => root.render(<DocView {...props} />));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('DocView', () => {
  beforeEach(() => localStorage.clear());
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
  it('A+/A− step the markdown font level and persist the level index', async () => {
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
  it('has no zoom controls for an html doc', async () => {
    await render({ type: 'html', name: 'r.html', content: '<h1>hi</h1>' });
    expect(container.querySelector('.doc-zoom')).toBeNull();
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
