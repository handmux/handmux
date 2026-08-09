// web/test/fileBrowser.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// fetchDir returns the dir's real (absolute, no trailing slash) path + entries. Entries vary by path
// so navigation is observable.
vi.mock('../src/api.js', () => ({
  UnauthorizedError: class extends Error {},
  fetchDir: vi.fn(async (p) => {
    const path = p || '/home/u';
    const entries = path === '/home/u'
      ? [
          { name: 'docs', type: 'dir' },
          { name: 'report.md', type: 'doc', size: 100 },
          { name: 'readme.md', type: 'doc', size: 200 },
          { name: 'data.bin', type: 'file', size: 2048 },
          { name: 'photo.gif', type: 'image', size: 999 },
        ]
      : [{ name: 'nested.md', type: 'doc', size: 10 }];
    return { path, home: '/home/u', parent: path === '/home/u' ? null : '/home/u', entries };
  }),
  downloadFile: vi.fn(async () => {}),
  uploadFile: vi.fn(async () => ({ name: 'x', size: 1 })),
  createDir: vi.fn(async (dir, name) => ({ path: `${dir}/${name}` })),
  UploadAbort: class UploadAbort extends Error {},
}));

// Mixed entries used by pickMode tests (exposed so individual tests can install them).
const MIXED_ENTRIES = [
  { name: 'sub', type: 'dir' },
  { name: 'a.md', type: 'doc', size: 50 },
  { name: 'b.bin', type: 'file', size: 100 },
];

import FileBrowser, { splitPath } from '../src/components/FileBrowser.jsx';
import { fetchDir, downloadFile, uploadFile, createDir } from '../src/api.js';

let container, root;
beforeEach(() => { vi.useFakeTimers(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); vi.useRealTimers(); });
const render = (props) => act(async () => root.render(<FileBrowser onOpenDoc={vi.fn()} onNavigate={vi.fn()} {...props} />));
const settle = async () => { await act(async () => {}); await act(async () => {}); };
const click = (node) => act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const type = (el, value) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const input = () => container.querySelector('.browse-input');

describe('splitPath', () => {
  it('splits dir and trailing fragment', () => {
    expect(splitPath('/a/b/c')).toEqual({ dir: '/a/b/', frag: 'c' });
    expect(splitPath('/a/b/')).toEqual({ dir: '/a/b/', frag: '' });
    expect(splitPath('foo')).toEqual({ dir: '', frag: 'foo' });
  });
});

describe('FileBrowser', () => {
  it('loads $HOME when path is null: fixed ~/ prefix outside the box, box empty', async () => {
    await render({ path: null });
    await settle();
    expect(fetchDir).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('.browse-home').textContent).toBe('~/');
    expect(input().value).toBe('');
    expect(container.textContent).toContain('report.md');
  });

  it('rejects a malformed directory response at the API boundary', async () => {
    fetchDir.mockResolvedValueOnce({ path: '/home/u', home: '/home/u', parent: null, entries: [{ name: 'bad', type: 'unknown' }] });
    await render({ path: null });
    await settle();
    expect(container.querySelector('.browse-err').textContent).toContain('无法打开该目录');
    expect(container.querySelector('.browse-entry')).toBeNull();
  });

  it('restores the persisted directory on (re)mount via the path prop', async () => {
    await render({ path: '/home/u/docs' });
    await settle();
    expect(fetchDir).toHaveBeenCalledWith('/home/u/docs');
    expect(input().value).toBe('docs/');
    expect(container.textContent).toContain('nested.md');
  });

  it('tapping a folder navigates, rewrites the box, and reports the new dir', async () => {
    const onNavigate = vi.fn();
    await render({ path: null, onNavigate });
    await settle();
    await click([...container.querySelectorAll('.browse-entry')].find((b) => b.textContent.includes('docs')));
    await settle();
    expect(fetchDir).toHaveBeenLastCalledWith('/home/u/docs');
    expect(input().value).toBe('docs/');
    expect(onNavigate).toHaveBeenCalledWith('/home/u/docs');
  });

  it('typing a trailing fragment live-filters without refetching (above → below)', async () => {
    await render({ path: null });
    await settle();
    type(input(), 'rep');
    await settle();
    expect(container.textContent).toContain('report.md');
    expect(container.textContent).not.toContain('readme.md');
    expect(fetchDir).toHaveBeenCalledTimes(1); // same dir → no refetch
  });

  it('typing a different directory (debounced) refetches it', async () => {
    await render({ path: null });
    await settle();
    type(input(), 'docs/');
    await act(async () => { vi.advanceTimersByTime(260); });
    await settle();
    expect(fetchDir).toHaveBeenLastCalledWith('/home/u/docs');
    expect(container.textContent).toContain('nested.md');
  });

  it('pasted absolute/~ paths fold into the current-root-relative form (prefix can\'t be doubled)', async () => {
    await render({ path: null });
    await settle();
    type(input(), '/home/u/docs/');
    expect(input().value).toBe('docs/');
    type(input(), '~/rep');
    expect(input().value).toBe('rep');
    type(input(), '/etc/');
    expect(input().value).toBe('etc/'); // with no extra roots, an absolute path folds under home
  });

  it('root prefix becomes a dropdown that switches into a non-home root (box stays root-relative, upload enabled)', async () => {
    const ROOTS = ['/home/u', '/private/tmp'];
    const orig = fetchDir.getMockImplementation();
    fetchDir.mockImplementation(async (p) => {
      const path = p || '/home/u';
      if (path === '/private/tmp') return { path, home: '/home/u', roots: ROOTS, parent: null, entries: [{ name: 'a.png', type: 'image', size: 1 }] };
      return { path, home: '/home/u', roots: ROOTS, parent: path === '/home/u' ? null : '/home/u', entries: [{ name: 'docs', type: 'dir' }] };
    });
    try {
      await render({ path: null });
      await settle();
      // the static ~/ span is replaced by a root dropdown; it shows the home root to start
      expect(container.querySelector('.browse-home')).toBeNull();
      const trigger = container.querySelector('.browse-root');
      expect(trigger.textContent).toContain('~/');
      // open the menu → an option per root
      await click(trigger);
      await settle();
      expect([...container.querySelectorAll('.dd-option-label')].map((o) => o.textContent)).toEqual(['~/', 'tmp/']);
      // pick tmp → loads /private/tmp, prefix flips to tmp/, box is empty (relative to the new root)
      await click([...container.querySelectorAll('.dd-option')].find((o) => o.textContent.includes('tmp/')));
      await settle();
      expect(fetchDir).toHaveBeenLastCalledWith('/private/tmp');
      expect(container.querySelector('.browse-root').textContent).toContain('tmp/');
      expect(input().value).toBe('');                                       // root-relative, not absolute
      expect(container.querySelector('.browse-upload').disabled).toBe(false); // temp root uploadable directly
      expect(container.textContent).toContain('a.png');
    } finally { fetchDir.mockImplementation(orig); }
  });

  it('clearing the box navigates back to $HOME', async () => {
    await render({ path: '/home/u/docs' });
    await settle();
    type(input(), '');
    await act(async () => { vi.advanceTimersByTime(260); });
    await settle();
    expect(fetchDir).toHaveBeenLastCalledWith('/home/u');
    expect(container.textContent).toContain('report.md');
  });

  it('Enter on a home-relative doc path opens it with the absolute path', async () => {
    const onOpenDoc = vi.fn();
    await render({ path: null, onOpenDoc });
    await settle();
    type(input(), 'report.md');
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onOpenDoc).toHaveBeenCalledWith('/home/u/report.md');
  });

  it('tapping a file opens it via onOpenDoc with the absolute path', async () => {
    const onOpenDoc = vi.fn();
    await render({ path: null, onOpenDoc });
    await settle();
    await click([...container.querySelectorAll('.browse-entry')].find((b) => b.textContent.includes('report.md')));
    expect(onOpenDoc).toHaveBeenCalledWith('/home/u/report.md');
  });

  it('tapping an image file opens it inline via onOpenDoc (not a download notice)', async () => {
    const onOpenDoc = vi.fn();
    await render({ path: null, onOpenDoc });
    await settle();
    await click([...container.querySelectorAll('.browse-entry')].find((b) => b.textContent.includes('photo.gif')));
    expect(onOpenDoc).toHaveBeenCalledWith('/home/u/photo.gif');
    expect(container.querySelector('.browse-notice')).toBeNull(); // not the no-preview path
    // image rows still keep a download button alongside the inline-open tap
    const row = [...container.querySelectorAll('.browse-entry-row')].find((r) => r.textContent.includes('photo.gif'));
    expect(row.querySelector('.browse-dl')).toBeTruthy();
  });

  it('shows non-doc files with a human size and a download button', async () => {
    await render({ path: null });
    await settle();
    expect(container.textContent).toContain('data.bin');
    expect(container.textContent).toContain('2 KB');
    const row = [...container.querySelectorAll('.browse-entry-row')].find((r) => r.textContent.includes('data.bin'));
    expect(row.querySelector('.browse-dl')).toBeTruthy();
  });

  it('tapping a non-doc file shows a no-preview notice, not a download or onOpenDoc', async () => {
    const onOpenDoc = vi.fn();
    await render({ path: null, onOpenDoc });
    await settle();
    await click([...container.querySelectorAll('.browse-entry')].find((b) => b.textContent.includes('data.bin')));
    expect(container.querySelector('.browse-notice').textContent).toContain('暂不支持该类型文件的预览');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it('the download button asks for confirmation, then downloads on confirm', async () => {
    await render({ path: null });
    await settle();
    const row = [...container.querySelectorAll('.browse-entry-row')].find((r) => r.textContent.includes('data.bin'));
    await click(row.querySelector('.browse-dl'));
    // confirmation sheet shows the file name; nothing downloaded yet
    expect(container.textContent).toContain('下载 data.bin');
    expect(downloadFile).not.toHaveBeenCalled();
    // confirm
    await click([...container.querySelectorAll('.sheet-action')].find((b) => b.textContent.trim() === '下载'));
    expect(downloadFile).toHaveBeenCalledWith('/home/u/data.bin', expect.any(Function));
    await settle(); // let the transfer-progress state settle (doDownload's finally) inside act
  });

  it('cancelling the download confirmation downloads nothing', async () => {
    await render({ path: null });
    await settle();
    const row = [...container.querySelectorAll('.browse-entry-row')].find((r) => r.textContent.includes('report.md'));
    await click(row.querySelector('.browse-dl'));
    await click(container.querySelector('.sheet-cancel'));
    expect(downloadFile).not.toHaveBeenCalled();
    expect(container.querySelector('.sheet-action')).toBeNull(); // sheet closed
  });

  it('upload button is disabled at the home root, enabled in a subdir', async () => {
    await render({ path: null }); // home root
    await settle();
    expect(container.querySelector('.browse-upload').disabled).toBe(true);
    await render({ path: '/home/u/docs' }); // a subdir
    await settle();
    expect(container.querySelector('.browse-upload').disabled).toBe(false);
  });

  it('shows a shared-file banner and uploads it to the current dir, then clears it', async () => {
    const file = new File(['hi'], 'shared.txt', { type: 'text/plain' });
    const onPendingConsumed = vi.fn();
    await render({ path: '/home/u/docs', pendingFile: file, onPendingConsumed });
    await settle();
    expect(container.querySelector('.browse-pending').textContent).toContain('shared.txt');
    const btn = container.querySelector('.browse-pending-btn');
    expect(btn.disabled).toBe(false);
    await click(btn);
    await settle();
    expect(uploadFile).toHaveBeenCalledWith('/home/u/docs', file, expect.any(Function), false, { signal: expect.any(Object) });
    expect(onPendingConsumed).toHaveBeenCalled();
  });

  it('disables the shared-file upload at the home root (needs a subdir) and downloads/uploads nothing', async () => {
    const file = new File(['hi'], 'shared.txt', { type: 'text/plain' });
    await render({ path: null, pendingFile: file, onPendingConsumed: vi.fn() });
    await settle();
    expect(container.querySelector('.browse-pending-btn').disabled).toBe(true);
    expect(container.querySelector('.browse-pending').textContent).toContain('请先进入一个子目录');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('choosing a file uploads it to the current dir and reloads', async () => {
    await render({ path: '/home/u/docs' });
    await settle();
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' });
    const fileInput = container.querySelector('.browse-file-input');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(uploadFile).toHaveBeenCalledWith('/home/u/docs', file, expect.any(Function), false, { signal: expect.any(Object) });
    expect(fetchDir).toHaveBeenLastCalledWith('/home/u/docs'); // reloaded after success
  });
});

describe('pickMode', () => {
  beforeEach(() => {
    // Override fetchDir for pickMode tests: mixed entries so dirs-only filter is observable.
    fetchDir.mockImplementation(async (p) => {
      const path = p || '/home/u';
      return { path, home: '/home/u', parent: path === '/home/u' ? null : '/home/u', entries: MIXED_ENTRIES };
    });
  });

  it('lists only directories and hides upload/download', async () => {
    const onPick = vi.fn();
    await render({ path: null, pickMode: true, onPick });
    await settle();
    expect(container.querySelector('.browse-upload')).toBeNull();
    const names = [...container.querySelectorAll('.browse-entry-name')].map((n) => n.textContent);
    expect(names).toEqual(['sub']);  // doc + file rows filtered out
    expect(container.querySelector('.browse-dl')).toBeNull();
  });

  it('confirm button reports the current dir via onPick', async () => {
    const onPick = vi.fn();
    await render({ path: null, pickMode: true, onPick });
    await settle();
    container.querySelector('.browse-pick-confirm').click();
    expect(onPick).toHaveBeenCalledWith('/home/u');
  });

  it('falls back to $HOME when the seeded path fails to load', async () => {
    fetchDir.mockImplementation(async (p) => {
      const path = p || '/home/u';
      if (path === '/home/u/gone') throw new Error('not found');
      return { path, home: '/home/u', parent: null, entries: MIXED_ENTRIES };
    });
    const onPick = vi.fn();
    await render({ path: '/home/u/gone', pickMode: true, onPick });
    await settle();
    expect(container.querySelector('.browse-err')).toBeNull();
    const names = [...container.querySelectorAll('.browse-entry-name')].map((n) => n.textContent);
    expect(names).toContain('sub');
  });
});

describe('button order + new folder', () => {
  it('renders the locate (⊙) button before the up (↑) button', async () => {
    await render({ path: null, onJumpToCwd: vi.fn() });
    await settle();
    const bar = container.querySelector('.browse-bar');
    const btns = [...bar.querySelectorAll('button')];
    const cwdIdx = btns.findIndex((b) => b.classList.contains('browse-cwd'));
    const upIdx = btns.findIndex((b) => b.classList.contains('browse-up'));
    expect(cwdIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(cwdIdx); // locate comes first
  });

  it('hides the new-folder button in pickMode by default (a picker selects, not manages)', async () => {
    await render({ path: null, pickMode: true, onPick: vi.fn() });
    await settle();
    expect(container.querySelector('.browse-mkdir')).toBeNull();
  });

  it('shows the new-folder button in pickMode when allowMkdir is set (create flows)', async () => {
    await render({ path: null, pickMode: true, allowMkdir: true, onPick: vi.fn() });
    await settle();
    expect(container.querySelector('.browse-mkdir')).not.toBeNull();
  });

  it('creates a folder in the current dir and refreshes', async () => {
    await render({ path: null });
    await settle();
    expect(fetchDir).toHaveBeenCalledTimes(1);
    await click(container.querySelector('.browse-mkdir')); // open inline row
    await settle();
    const nameInput = container.querySelector('.browse-newfolder input');
    expect(nameInput).not.toBeNull();
    type(nameInput, 'newdir');
    await click([...container.querySelectorAll('.browse-newfolder button')].find((b) => b.textContent.trim() === '创建'));
    await settle();
    expect(createDir).toHaveBeenCalledWith('/home/u', 'newdir');
    expect(fetchDir).toHaveBeenLastCalledWith('/home/u'); // reloaded after create
    expect(fetchDir).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.browse-newfolder')).toBeNull(); // closed after success
  });

  it('caps a huge listing at 300 rows and shows the overflow hint; typing filters it away', async () => {
    const orig = fetchDir.getMockImplementation();
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `f${String(i).padStart(4, '0')}.bin`, type: 'file', size: 1 }));
    fetchDir.mockImplementation(async () => ({ path: '/home/u', home: '/home/u', parent: null, entries: many }));
    try {
      await render({ path: null });
      await settle();
      expect(container.querySelectorAll('.browse-entry').length).toBe(300); // capped
      const hint = container.querySelector('.browse-overflow');
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain('1000'); // total
      expect(hint.textContent).toContain('300');  // shown

      type(input(), 'f0001'); // a unique fragment → one match, no overflow
      await settle();
      expect(container.querySelectorAll('.browse-entry').length).toBe(1);
      expect(container.querySelector('.browse-overflow')).toBeNull();
    } finally { fetchDir.mockImplementation(orig); }
  });
});
