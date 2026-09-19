// web/test/docMermaid.test.js — mermaid fences.
//
// mermaid itself cannot render in jsdom (it needs a real layout/SVG engine), so these tests pin the
// CONTRACT around it: the fence is recognised and prepared, the library is imported lazily and only when
// a diagram exists, the returned SVG is inserted, and a failure gives the source back with a reason.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';
import { prepareMermaid } from '../src/docMermaid.js';

const render = vi.fn(async (id, source) => ({ svg: `<svg data-id="${id}">${source.length}</svg>` }));
const initialize = vi.fn();
vi.mock('mermaid', () => ({ default: { render, initialize } }));

const { useDocMermaid } = await import('../src/docMermaid.js');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

beforeEach(() => { render.mockClear(); initialize.mockClear(); document.body.innerHTML = ''; });

const FENCE = '```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```';

describe('mermaid fences in the pipeline', () => {
  it('keeps the source hidden and adds a placeholder (doc mode)', () => {
    const html = renderMarkdown(FENCE, { baseDir: '/d' });
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain('md-mermaid-source');
    expect(html).toContain('class="md-mermaid is-loading"');
    expect(html).toContain('data-tts-skip'); // never read aloud
  });

  it('leaves an ordinary code block completely alone', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```', { baseDir: '/d' });
    expect(html).not.toContain('md-mermaid');
    expect(html).toContain('<pre><code class="language-js">');
  });

  it('does not prepare diagrams in bubble mode', () => {
    const html = renderMarkdown(FENCE, { links: true });
    expect(html).not.toContain('md-mermaid');
  });
});

describe('the loader', () => {
  it('renders each diagram with the lazily imported library', async () => {
    const md = document.createElement('div');
    md.className = 'doc-md';
    md.innerHTML = renderMarkdown(FENCE, { baseDir: '/d' });
    document.body.append(md);

    const Probe = () => {
      const ref = { current: md };
      useDocMermaid(ref, md.innerHTML, true);
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(initialize).toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
    const block = md.querySelector('.md-mermaid');
    expect(block.classList.contains('is-loading')).toBe(false);
    expect(block.querySelector('svg')).not.toBeNull();
  });

  it('gives the source back with a reason when rendering fails', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram'));
    const md = document.createElement('div');
    md.className = 'doc-md';
    md.innerHTML = renderMarkdown(FENCE, { baseDir: '/d' });
    document.body.append(md);
    const Probe = () => {
      const ref = { current: md };
      useDocMermaid(ref, md.innerHTML, true);
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(md.querySelector('.md-mermaid')).toBeNull();
    const pre = md.querySelector('pre');
    expect(pre.classList.contains('md-mermaid-source')).toBe(false); // shown again
    expect(md.querySelector('.md-mermaid-error').textContent).toContain('bad diagram');
  });
});
