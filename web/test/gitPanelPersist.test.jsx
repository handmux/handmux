// Reproduction: bound git repos must survive close→reopen of the GitPanel.
// Uses REAL storage.js (not mocked) so we exercise the actual persistence path; only api.js is mocked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  UnauthorizedError: class extends Error {},
  fetchPaneCwd: vi.fn(async () => ({ cwd: '/home/u/proj' })),
  // discovery: cwd → repo proj; the picked subdir → repo other
  gitRepos: vi.fn(async (dir) => {
    if (dir === '/home/u/proj') return { repos: [{ name: 'proj', path: '/home/u/proj' }] };
    if (dir === '/home/u/proj/other') return { repos: [{ name: 'other', path: '/home/u/proj/other' }] };
    return { repos: [] };
  }),
  gitStatus: vi.fn(async () => ({ changes: [] })),
  gitLog: vi.fn(async () => ({ commits: [] })),
  gitBranches: vi.fn(async () => ({ branches: [{ name: 'main', current: true }] })),
  gitDiff: vi.fn(async () => ({ diff: '', truncated: false })),
  gitCommit: vi.fn(async () => ({ message: '', files: [] })),
  // FileBrowser inside DirPicker. The cwd lists one subdir 'other' to navigate into and pick.
  fetchDir: vi.fn(async (p) => {
    const path = p || '/home/u/proj';
    const entries = path === '/home/u/proj' ? [{ name: 'other', type: 'dir' }] : [];
    return { path, home: '/home/u', parent: '/home/u', entries };
  }),
  downloadFile: vi.fn(async () => {}),
  uploadFile: vi.fn(async () => ({ name: 'x', size: 1 })),
}));

import GitPanel from '../src/components/GitPanel.jsx';
import { getGitRepos } from '../src/storage.js';
import { gitRepos } from '../src/api.js';

let container, root;
beforeEach(() => { localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

const render = (props) => act(async () => root.render(<GitPanel onClose={vi.fn()} windowId="@1" pane="%1" {...props} />));
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)].map((b) => b.textContent);
const click = (el) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('GitPanel persistence across close→reopen', () => {
  it('closes the bind picker from an empty Git panel without closing the panel', async () => {
    gitRepos.mockResolvedValueOnce({ repos: [] });
    const onClose = vi.fn();
    await render({ open: true, onClose });
    await settle();
    expect(q('.git-tab-label')).toBeNull();

    click(q('.git-tab-add'));
    await settle();
    expect(q('.dirpick-card')).not.toBeNull();

    click(q('.dirpick-card .settings-close'));
    await settle();
    expect(q('.dirpick-card')).toBeNull();
    expect(q('.git-sheet.open')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('auto-discovered repo persists and reappears on reopen', async () => {
    await render({ open: true });
    await settle();
    expect(qa('.git-tab-label')).toEqual(['proj']);
    expect(getGitRepos('@1')).toEqual(['/home/u/proj']);

    await render({ open: false });
    await settle();
    await render({ open: true });
    await settle();
    expect(qa('.git-tab-label')).toEqual(['proj']);
  });

  it('a repo added via the + picker APPENDS (not overwrite) and survives reopen', async () => {
    await render({ open: true });
    await settle();
    expect(qa('.git-tab-label')).toEqual(['proj']);

    // tap + → picker opens (seeded at the pane cwd /home/u/proj)
    click(q('.git-tab-add'));
    await settle();
    expect(q('.dirpick-card')).not.toBeNull();

    // navigate into subdir 'other', then confirm-pick it
    const otherEntry = [...document.querySelectorAll('.browse-entry')].find((b) => b.textContent.includes('other'));
    expect(otherEntry).toBeTruthy();
    click(otherEntry);
    await settle();
    click(q('.browse-pick-confirm'));
    await settle();

    // both repos now shown AND persisted — NOT an overwrite
    expect(qa('.git-tab-label')).toEqual(['proj', 'other']);
    expect(getGitRepos('@1')).toEqual(['/home/u/proj', '/home/u/proj/other']);

    // close → reopen: both must still be there
    await render({ open: false });
    await settle();
    await render({ open: true });
    await settle();
    expect(qa('.git-tab-label')).toEqual(['proj', 'other']);
  });
});
