// web/test/gitPanel.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  UnauthorizedError: class extends Error {},
  fetchPaneCwd: vi.fn(async () => ({ cwd: '/home/u/proj' })),
  gitRepos: vi.fn(async () => ({ repos: [{ name: 'proj', path: '/home/u/proj', branch: 'main', dirty: false }] })),
  gitStatus: vi.fn(async () => ({ changes: [{ x: 'M', y: ' ', path: 'src/a.js' }] })),
  gitLog: vi.fn(async () => ({ commits: [{ hash: 'abc123', short: 'abc123', subject: 'init', author: 'me', relDate: '1d' }] })),
  gitBranches: vi.fn(async () => ({ branches: [{ name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 0 }] })),
  gitDiff: vi.fn(async () => ({ diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n', truncated: false })),
  gitCommit: vi.fn(async () => ({ message: 'init', files: [{ x: 'A', y: ' ', path: 'src/a.js' }] })),
  // DirPicker (embedded) → FileBrowser reads fetchDir.
  fetchDir: vi.fn(async (p) => ({ path: p || '/home/u', home: '/home/u', parent: null, entries: [] })),
  downloadFile: vi.fn(async () => {}),
  uploadFile: vi.fn(async () => ({ name: 'x', size: 1 })),
}));

let store = [];
vi.mock('../src/storage.js', () => ({
  getGitRepos: vi.fn((_win) => store),
  addGitRepos: vi.fn((_win, paths) => { for (const p of paths) if (!store.includes(p)) store.push(p); return [...store]; }),
  removeGitRepo: vi.fn((_win, p) => { store = store.filter((x) => x !== p); return [...store]; }),
  // FileBrowser (inside DirPicker) touches these.
  getBrowseDir: vi.fn(() => null), setBrowseDir: vi.fn(),
  // DiffView's font-size stepper. DOC_FONT_SIZES is read at module-eval time, so it must be a real array.
  getDiffFontIndex: vi.fn(() => 4), setDiffFontIndex: vi.fn(),
  DOC_FONT_SIZES: [10, 11, 12, 13, 14, 16, 18, 20, 22],
}));

import GitPanel, { basename } from '../src/components/GitPanel.jsx';

let container, root;
beforeEach(() => { store = []; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

const render = (props) => act(async () => root.render(<GitPanel onClose={vi.fn()} windowId="w1" {...props} />));
const settle = async () => { await act(async () => {}); await act(async () => {}); await act(async () => {}); };
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
// Faithful hardware-Back: actually traverse jsdom history (which fires popstate), not a bare dispatch.
const back = async () => {
  await act(async () => {
    await new Promise((res) => {
      const h = () => { window.removeEventListener('popstate', h); res(); };
      window.addEventListener('popstate', h);
      window.history.back();
      setTimeout(res, 150); // fallback so a boundary no-op back can't hang the suite
    });
  });
  await settle();
};

describe('GitPanel', () => {
  it('stays mounted but not open when closed (so it can slide up)', async () => {
    await render({ open: false });
    const sheet = q('.git-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet.classList.contains('open')).toBe(false);
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
  });

  it('basename returns the last path segment', () => {
    expect(basename('/home/u/proj')).toBe('proj');
    expect(basename('/home/u/proj/')).toBe('proj');
  });

  it('renders a repo tab per bound repo (from getGitRepos)', async () => {
    store = ['/home/u/proj', '/home/u/other'];
    await render({ open: true });
    await settle();
    const labels = qa('.git-tab-label').map((b) => b.textContent);
    expect(labels).toEqual(['proj', 'other']);
  });

  it('lists changes for the active repo and drills into a diff', async () => {
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    const row = q('.git-row');
    expect(row.textContent).toContain('src/a.js');
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    // diff lines render with the right classes; long lines scroll (white-space:pre on .git-diff)
    expect(q('.git-diff')).not.toBeNull();
    expect(q('.git-diff-add')?.textContent).toContain('new');
    expect(q('.git-diff-del')?.textContent).toContain('old');
  });

  it('routes malformed Git API data to the error state', async () => {
    const api = await import('../src/api.js');
    api.gitStatus.mockResolvedValueOnce({ changes: [{ x: 'M', y: '', path: 7 }] });
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    expect(q('.git-error')).not.toBeNull();
    expect(q('.git-row')).toBeNull();
  });

  it('shows the truncation banner when the diff is capped', async () => {
    const api = await import('../src/api.js');
    api.gitDiff.mockResolvedValueOnce({ diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n', truncated: true });
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    act(() => q('.git-row').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-diff-trunc')).not.toBeNull();
  });

  it('Back steps one drill level at a time, closing only at the repo home', async () => {
    const onClose = vi.fn();
    store = ['/home/u/proj'];
    await render({ open: true, onClose });
    await settle();
    // home shows every section at once → open the commit (提交 is expanded) → open a file (2 levels deep)
    act(() => q('.git-commit-row').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-commit-msg')).not.toBeNull();       // level 1: commit detail
    act(() => q('.git-row').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-diff')).not.toBeNull();             // level 2: file diff

    await back();                                      // → level 1: commit detail
    expect(q('.git-diff')).toBeNull();
    expect(q('.git-commit-msg')).not.toBeNull();
    await back();                                      // → home (branch picker visible), panel still open
    expect(q('.git-branch-trigger')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await back();                                      // → close (return to main page)
    expect(onClose).toHaveBeenCalled();
  });

  it('shows changes and commits together, with the branch picker in the header', async () => {
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    expect(q('.git-branch-bar-name').textContent).toContain('main'); // current branch on the left
    expect(q('.git-branch-cur-tag')).not.toBeNull();                 // tagged 当前分支 on entry (HEAD)
    expect(q('.git-branch-trigger')).not.toBeNull();                 // switch-branch dropdown on the right
    expect(q('.git-row .git-row-path')?.textContent).toContain('src/a.js'); // 变更 row
    expect(q('.git-commit-row')).not.toBeNull();                    // 提交 row, no tab switch needed
    // 分支 is a header dropdown, closed by default → open it.
    expect(q('.git-dd-menu')).toBeNull();
    act(() => q('.git-branch-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-dd-menu')).not.toBeNull();
  });

  it('picking a branch from the dropdown re-points 提交 (read-only, no checkout)', async () => {
    const api = await import('../src/api.js');
    api.gitBranches.mockResolvedValue({ branches: [
      { name: 'main', current: true, upstream: 'origin/main', ahead: 0, behind: 0 },
      { name: 'feature', current: false, upstream: null, ahead: 0, behind: 0 },
    ] });
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    api.gitLog.mockClear();
    act(() => q('.git-branch-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const featureItem = qa('.git-dd-item .git-row-path').find((s) => s.textContent === 'feature');
    act(() => featureItem.closest('.git-dd-item').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    // commits re-fetched for the picked branch via the read-only ref arg (never a checkout)
    expect(api.gitLog).toHaveBeenCalledWith('/home/u/proj', { ref: 'feature', limit: 20 });
    // left label follows the picked branch, and the 当前分支 tag is gone (feature isn't HEAD)
    expect(q('.git-branch-bar-name').textContent).toContain('feature');
    expect(q('.git-branch-cur-tag')).toBeNull();
    expect(q('.git-dd-menu')).toBeNull();                              // menu closes after picking
  });

  it('re-picking the branch already shown is a no-op (提交 stays, never stuck on 加载中)', async () => {
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    expect(q('.git-commit-row')).not.toBeNull();  // commits visible on entry
    act(() => q('.git-branch-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    // default branches = [main(current)] → tap main, the branch already on screen
    const mainItem = qa('.git-dd-item .git-row-path').find((s) => s.textContent === 'main');
    act(() => mainItem.closest('.git-dd-item').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-dd-menu')).toBeNull();          // menu closed
    expect(q('.git-loading')).toBeNull();          // NOT hung on 加载中
    expect(q('.git-commit-row')).not.toBeNull();   // commits still there
  });

  // The reported bug: open → drill ONE level → Back to home → Back should close the panel (return to
  // the main page), NOT exit the whole app. Faithful history traversal so the entry accounting is real.
  it('after a 1-level drill, Back→home then Back closes (not exit app)', async () => {
    const onClose = vi.fn();
    store = ['/home/u/proj'];
    await render({ open: true, onClose });
    await settle();
    act(() => q('.git-row').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(q('.git-diff')).not.toBeNull();             // detail
    await back();                                      // → home
    expect(q('.git-diff')).toBeNull();
    expect(q('.git-branch-trigger')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();            // home-back must NOT close yet
    await back();                                      // → close panel (return to main page)
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('提交 starts at 20 and pulls the next page when scrolled to the bottom', async () => {
    const api = await import('../src/api.js');
    const page = (n) => Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, short: `h${i}`, subject: `c${i}`, author: 'me', relDate: '1d' }));
    api.gitLog.mockResolvedValue({ commits: page(20) }); // a full page → there may be more
    store = ['/home/u/proj'];
    await render({ open: true });
    await settle();
    expect(api.gitLog).toHaveBeenCalledWith('/home/u/proj', { ref: undefined, limit: 20 });
    expect(q('.git-more')).not.toBeNull();              // "下拉加载更多" footer on a full page
    api.gitLog.mockClear();
    // jsdom has no layout (scrollHeight/clientHeight = 0) → the handler reads "at the bottom".
    const body = q('.git-section--mid .git-section-body');
    act(() => body.dispatchEvent(new Event('scroll', { bubbles: true })));
    await settle();
    expect(api.gitLog).toHaveBeenCalledWith('/home/u/proj', { ref: undefined, limit: 40 });
  });
});
