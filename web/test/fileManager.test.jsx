// web/test/fileManager.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// fetchDir tracks the requested dir so we can assert the browser restores it across a tab switch.
vi.mock('../src/api.js', () => ({
  fetchDir: vi.fn(async (p) => {
    const path = p || '/home/u';
    const entries = path === '/home/u'
      ? [{ name: 'docs', type: 'dir' }, { name: 'a.md', type: 'doc' }]
      : [{ name: 'nested.md', type: 'doc' }];
    return { path, home: '/home/u', parent: path === '/home/u' ? null : '/home/u', entries };
  }),
  // No pane passed in these tests → cwd null, so the open-seed leaves the browser at $HOME.
  fetchPaneCwd: vi.fn(async () => ({ cwd: null })),
}));
vi.mock('../src/storage.js', () => ({
  getRecentDocs: vi.fn(() => []), removeRecentDoc: vi.fn(),
  getBrowseDir: vi.fn(() => null), setBrowseDir: vi.fn(),
  // DocView (rendered for the active doc tab) reads these; provide them so the mock is complete.
  getDocFontIndex: vi.fn(() => 4), setDocFontIndex: vi.fn(), DOC_FONT_SIZES: [10, 11, 12, 13, 14, 16, 18, 20, 22],
}));

import FileManager from '../src/components/FileManager.jsx';
import { fetchPaneCwd, fetchDir } from '../src/api.js';
import { setBrowseDir } from '../src/storage.js';
import { HOME_TAB } from '../src/hooks/useDocTabs.js';

const popBack = () => act(async () => window.dispatchEvent(new PopStateEvent('popstate')));

// The sheet renders through a portal on <body>, so query the document, not the mount container.
let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
const render = (props) => act(async () => root.render(<FileManager {...props} />));
const settle = async () => { await act(async () => {}); await act(async () => {}); };
const click = (node) => act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const seg = (label) => qa('.file-seg-btn').find((b) => b.textContent.includes(label));

const docTab = { key: '/home/u/a.md', type: 'markdown', name: 'a.md', content: '# a', path: '/home/u/a.md' };
const base = {
  open: true, tabs: [HOME_TAB, docTab], active: '/home/u/a.md',
  onActivate: vi.fn(), onCloseTab: vi.fn(), onMinimize: vi.fn(), onOpenDoc: vi.fn(),
};

describe('FileManager', () => {
  it('gets the .open class when open and renders a tab per entry', async () => {
    await render({ ...base });
    expect(q('.file-sheet').classList.contains('open')).toBe(true);
    expect(qa('.file-tab').length).toBe(2);
  });
  it('drops the .open class when minimized', async () => {
    await render({ ...base, open: false });
    expect(q('.file-sheet').classList.contains('open')).toBe(false);
  });
  it('renders the active doc tab content (DocView)', async () => {
    await render({ ...base });
    expect(q('.doc-md')?.querySelector('h1')?.textContent).toBe('a');
  });
  it('home tab opens on the 目录 segment (session dir) by default', async () => {
    await render({ ...base, active: 'home' });
    await settle();
    expect(q('.browse-view')).not.toBeNull();
    expect(q('.home-view')).toBeNull();
  });
  it('switches between 最近 and 目录 via the segmented control', async () => {
    await render({ ...base, active: 'home' });
    await settle();                 // opens on 目录
    await click(seg('最近'));
    expect(q('.home-view')).not.toBeNull();
    expect(q('.browse-view')).toBeNull();
    await click(seg('目录'));
    await settle();
    expect(q('.browse-view')).not.toBeNull();
    expect(q('.home-view')).toBeNull();
  });
  it('keeps the browsed directory after switching to a doc tab and back', async () => {
    // Opens on 目录 at $HOME; navigate into docs/.
    await render({ ...base, active: 'home' });
    await settle();
    await click(qa('.browse-entry').find((b) => b.textContent.includes('docs')));
    await settle();
    expect(q('.browse-input').value).toBe('docs/');
    // Switch to a doc tab (FileBrowser unmounts) then back to home.
    await render({ ...base, active: '/home/u/a.md' });
    await settle();
    await render({ ...base, active: 'home' });
    await settle();
    // Still on 新增, still in docs/ — not reset to $HOME.
    expect(q('.browse-input').value).toBe('docs/');
    expect(document.body.textContent).toContain('nested.md');
  });
  it('re-fetches the directory listing on reopen, even at the same dir (no stale content)', async () => {
    await render({ ...base, active: 'home' });
    await settle();                                        // first open → browser fetched $HOME
    const before = fetchDir.mock.calls.length;
    await render({ ...base, active: 'home', open: false }); // minimize — the sheet/browser stay mounted
    await settle();
    await render({ ...base, active: 'home', open: true });  // reopen → refreshKey bump forces a fresh fetch
    await settle();
    expect(fetchDir.mock.calls.length).toBeGreaterThan(before);
  });
  it('re-seeds to the new window\'s cwd when the window changes while the sheet stays open', async () => {
    // seed is async (fetchPaneCwd → setBrowsePath → FileBrowser fetchDir) — poll until it lands.
    const waitForInput = async (val) => { for (let i = 0; i < 12; i += 1) { await settle(); if (q('.browse-input')?.value === val) return; } };
    fetchPaneCwd.mockImplementation(async (p) => ({ cwd: p === '%1' ? '/home/u/w1' : '/home/u/w2' }));
    await render({ ...base, active: 'home', pane: '%1', windowId: '@1' });
    await waitForInput('w1/');
    expect(q('.browse-input').value).toBe('w1/'); // landed on window @1's cwd
    // Window switches under an open sheet (e.g. a notification-tap navigation).
    await render({ ...base, active: 'home', pane: '%2', windowId: '@2' });
    await waitForInput('w2/');
    expect(q('.browse-input').value).toBe('w2/'); // re-seeded to window @2's cwd, not stranded on w1
  });
  it('fires onActivate when a tab is tapped and onCloseTab on its ✕', async () => {
    await render({ ...base, active: 'home' });
    const labelBtn = qa('.file-tab-label').find((t) => t.textContent.includes('a.md'));
    await click(labelBtn);
    expect(base.onActivate).toHaveBeenCalledWith('/home/u/a.md');
    const closeBtn = labelBtn.closest('.file-tab').querySelector('.file-tab-x');
    await click(closeBtn);
    expect(base.onCloseTab).toHaveBeenCalledWith('/home/u/a.md');
  });
  it('fires onMinimize on the minimize button', async () => {
    await render({ ...base });
    await click(q('.file-min'));
    expect(base.onMinimize).toHaveBeenCalled();
  });

  it('Back on a doc opened directly (sheet was closed) minimizes — never invents a browse level', async () => {
    // The user never browsed here: the sheet opened straight into the preview. Back must retrace the
    // REAL path (one step: open → minimized), not force the 目录 page and strand an unbalanced history.
    const onActivate = vi.fn();
    const onMinimize = vi.fn();
    await render({ ...base, open: false, active: 'home', windowId: '@1', onActivate, onMinimize });
    await settle();
    await render({ ...base, open: true, active: '/home/u/docs/nested.md', windowId: '@1', onActivate, onMinimize });
    await settle();
    await popBack();
    expect(onMinimize).toHaveBeenCalled();                        // direct open → Back just hides
    expect(onActivate).not.toHaveBeenCalledWith('home');          // no forced trip to the home tab
  });

  it('Back on a doc opened from the browser returns to home as it was (retraces the path)', async () => {
    const onActivate = vi.fn();
    const onMinimize = vi.fn();
    // Open on home first (sheet already open), THEN a preview activates — that's a browsed-into doc.
    await render({ ...base, active: 'home', windowId: '@1', onActivate, onMinimize });
    await settle();
    await render({ ...base, active: '/home/u/docs/nested.md', windowId: '@1', onActivate, onMinimize });
    await settle();
    await popBack();
    expect(onActivate).toHaveBeenCalledWith('home');              // leave the preview → home, unchanged
    expect(onMinimize).not.toHaveBeenCalled();                    // sheet stays open
    await popBack();
    expect(onMinimize).toHaveBeenCalled();                        // at the base → hide
  });

  it('Back steps to the previous path while browsing, then closes the sheet at the base', async () => {
    const onMinimize = vi.fn();
    await render({ ...base, active: 'home', windowId: '@1', onMinimize });
    await settle();                                               // opens on 目录 at $HOME
    await click(qa('.browse-entry').find((b) => b.textContent.includes('docs')));
    await settle();
    expect(q('.browse-input').value).toBe('docs/');               // navigated into docs/
    await popBack();
    await settle();
    expect(q('.browse-input').value).toBe('');                    // back → previous path ($HOME)
    expect(onMinimize).not.toHaveBeenCalled();
    await popBack();
    expect(onMinimize).toHaveBeenCalled();                        // back at base → close
  });
});
