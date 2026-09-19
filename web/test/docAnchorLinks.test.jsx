// web/test/docAnchorLinks.test.js — the anchor test document must have NO dead links.
//
// The same fixture is what the user opens by hand in the app (/tmp/doc-anchor-test.md), so this test is
// the guarantee that hand-verifying it cannot fail for a silly reason: every in-document link must
// resolve to a heading id the app generated. Slug rules (see DocView.slugifyHeading): lowercase, spaces
// → '-', punctuation stripped, CJK kept, duplicates get -1/-2, all-punctuation → 'section'.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import DocView from '../src/components/DocView.jsx';

const markdown = readFileSync(`${process.cwd()}/test/fixtures/anchor-doc.md`, 'utf8');

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const anchorOf = (href) => decodeURIComponent(href.slice(1));

describe('anchor test document', () => {
  it('has no dead in-document links', async () => {
    await act(() => root.render(<DocView type="markdown" name="anchor-doc.md" path="/tmp/anchor-doc.md" content={markdown} />));
    const links = [...container.querySelectorAll('.doc-md a[href^="#"]')];
    expect(links.length).toBeGreaterThan(5);
    const ids = new Set([...container.querySelectorAll('.doc-md [id]')].map((el) => el.id));
    const dead = links.map((a) => anchorOf(a.getAttribute('href'))).filter((id) => !ids.has(id));
    expect(dead).toEqual([]);
  });

  it('assigns the documented slug ids (so the fixture stays honest)', async () => {
    await act(() => root.render(<DocView type="markdown" name="anchor-doc.md" path="/tmp/anchor-doc.md" content={markdown} />));
    const ids = [...container.querySelectorAll('.doc-md h1, .doc-md h2')].map((h) => h.id);
    expect(ids).toContain('锚点跳转验证');
    expect(ids).toContain('1-中文标题');
    expect(ids).toContain('英文-title-with-caps');
    expect(ids).toContain('带标点这里有个问号');
    expect(ids).toContain('duplicate');
    expect(ids).toContain('duplicate-1');
    expect(ids).toContain('只有标点');
    expect(ids).toContain('section'); // the all-punctuation heading
    expect(ids).toContain('末尾目标');
  });

  it('jumps to the target when a link is tapped', async () => {
    const calls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function scrollTo(opts) { calls.push(opts); };
    try {
      await act(() => root.render(<DocView type="markdown" name="anchor-doc.md" path="/tmp/anchor-doc.md" content={markdown} />));
      const links = [...container.querySelectorAll('.doc-md a[href^="#"]')];
      const last = links.find((a) => anchorOf(a.getAttribute('href')) === '末尾目标');
      expect(last).toBeTruthy();
      await act(() => last.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });
});
