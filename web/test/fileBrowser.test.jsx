// web/test/fileBrowser.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// fetchDir returns the dir's real (absolute, no trailing slash) path + entries. Entries vary by path
// so navigation is observable. Each entry carries an mtime a comfortable distance inside its
// relative-time bucket, so the "3小时前" column is deterministic whenever the test runs.
vi.mock('../src/api.js', () => ({
  UnauthorizedError: class extends Error {},
  fetchDir: vi.fn(async (p) => {
    const path = p || '/home/u';
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const ago = (ms) => Date.now() - ms;
    const entries = path === '/home/u'
      ? [
          { name: 'docs', type: 'dir', mtimeMs: ago(3 * HOUR) },
          { name: 'report.md', type: 'doc', size: 100, mtimeMs: ago(2 * DAY) },
          { name: 'readme.md', type: 'doc', size: 200, mtimeMs: ago(40 * DAY) },
          { name: 'data.bin', type: 'file', size: 2048, mtimeMs: ago(30 * 60_000) },
          { name: 'photo.gif', type: 'image', size: 999, mtimeMs: ago(10 * 60_000) },
        ]
      : [{ name: 'nested.md', type: 'doc', size: 10, mtimeMs: ago(5 * 60_000) }];
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
import zh from '../src/i18n/zh.js';

let container, root;
beforeEach(() => {
  vi.useFakeTimers();
  // The sort order and the collapse switch are persisted app-wide, so a test that flips one must not
  // leak into the next.
  localStorage.removeItem('tw_browse_sort');
  localStorage.removeItem('tw_browse_collapse');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
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
    // image rows keep their ⋯ actions alongside the inline-open tap
    expect(rowFor('photo.gif').querySelector('.browse-more')).toBeTruthy();
  });

  it('shows non-doc files with a human size', async () => {
    await render({ path: null });
    await settle();
    expect(container.textContent).toContain('data.bin');
    expect(container.textContent).toContain('2.0 KB');
  });

  const rowFor = (name) => [...container.querySelectorAll('.browse-entry-row')].find((r) => r.textContent.includes(name));
  const rowNames = () => [...container.querySelectorAll('.browse-entry-name')].map((n) => n.textContent);

  it('shows when each entry was last modified, directories included', async () => {
    await render({ path: null });
    await settle();
    expect(rowFor('docs').querySelector('.browse-entry-time').textContent).toBe('3小时前');
    expect(rowFor('report.md').querySelector('.browse-entry-time').textContent).toBe('前天');
    expect(rowFor('readme.md').querySelector('.browse-entry-time').textContent).toBe('上个月');
    expect(rowFor('data.bin').querySelector('.browse-entry-time').textContent).toBe('30分钟前');
    // one line, like a desktop file manager: name … time, size
    expect(rowFor('data.bin').querySelector('.browse-entry-size').textContent).toBe('2.0 KB');
    expect(rowFor('docs').querySelector('.browse-entry-size')).toBeNull(); // sizing a dir means walking it
  });

  it('leaves the time column blank when the server had no mtime for an entry', async () => {
    fetchDir.mockResolvedValueOnce({
      path: '/home/u', home: '/home/u', parent: null,
      entries: [{ name: 'stale.md', type: 'doc', size: 12 }],
    });
    await render({ path: null });
    await settle();
    expect(container.textContent).toContain('stale.md');
    expect(container.querySelector('.browse-entry-time')).toBeNull();
    expect(rowFor('stale.md').querySelector('.browse-entry-size').textContent).toBe('12 B');
  });

  const sortTrigger = () => container.querySelector('.browse-sort .dd-trigger');
  const pickSort = async (label) => {
    await click(sortTrigger());
    await click([...container.querySelectorAll('.dd-option')].find((b) => b.textContent.includes(label)));
  };

  it('offers the sort modes in a dropdown, marks the active one, and applies the pick', async () => {
    await render({ path: null });
    await settle();
    expect(sortTrigger().textContent).toContain('默认');
    expect(sortTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.dd-menu')).toBeNull(); // nothing until it is opened
    await click(sortTrigger());
    expect(sortTrigger().getAttribute('aria-expanded')).toBe('true');
    expect([...container.querySelectorAll('.dd-option-label')].map((b) => b.textContent))
      .toEqual(['默认', '名称 ↑', '名称 ↓', '修改时间 ↓', '修改时间 ↑', '大小 ↓', '大小 ↑']);
    // the active mode carries the check mark, and only it
    expect([...container.querySelectorAll('.dd-option.is-selected')].map((b) => b.textContent.trim()))
      .toEqual(['默认✓']);
    // a pick applies without a second tap and closes the menu
    await click([...container.querySelectorAll('.dd-option')].find((b) => b.textContent.includes('名称 ↓')));
    expect(container.querySelector('.dd-menu')).toBeNull();
    expect(sortTrigger().textContent).toContain('名称 ↓');
  });

  it('closes the sort dropdown when a tap lands outside it', async () => {
    await render({ path: null });
    await settle();
    await click(sortTrigger());
    expect(container.querySelector('.dd-menu')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.dd-menu')).toBeNull();
  });

  it.each([
    ['名称 ↑', ['docs', 'data.bin', 'photo.gif', 'readme.md', 'report.md']],
    ['名称 ↓', ['docs', 'report.md', 'readme.md', 'photo.gif', 'data.bin']],
    ['修改时间 ↓', ['docs', 'photo.gif', 'data.bin', 'report.md', 'readme.md']],
    ['修改时间 ↑', ['docs', 'readme.md', 'report.md', 'data.bin', 'photo.gif']],
    ['大小 ↓', ['docs', 'data.bin', 'photo.gif', 'readme.md', 'report.md']],
    ['大小 ↑', ['docs', 'report.md', 'readme.md', 'photo.gif', 'data.bin']],
  ])('%s orders the rows, with directories still first', async (label, expected) => {
    await render({ path: null });
    await settle();
    await pickSort(label);
    expect(rowNames()).toEqual(expected);
    // the trigger reports the mode and it persists for the next folder
    expect(sortTrigger().textContent).toContain(label);
    expect(localStorage.getItem('tw_browse_sort')).toBe(
      { '名称 ↑': 'name-asc', '名称 ↓': 'name-desc', '修改时间 ↓': 'mtime-desc', '修改时间 ↑': 'mtime-asc', '大小 ↓': 'size-desc', '大小 ↑': 'size-asc' }[label],
    );
  });

  it('maps the sort value written by the earlier two-state control', async () => {
    localStorage.setItem('tw_browse_sort', 'modified'); // what the old chip persisted
    await render({ path: null });
    await settle();
    expect(sortTrigger().textContent).toContain('修改时间 ↓');
  });

  it('names the time modes 修改时间 in full, never an abbreviation', () => {
    expect(zh['filebrowser.sortTimeDesc']).toBe('修改时间 ↓');
    expect(zh['filebrowser.sortTimeAsc']).toBe('修改时间 ↑');
  });

  it('lists the folder as it is, and the 收起隐藏项 switch tucks the dotfiles away', async () => {
    fetchDir.mockResolvedValueOnce({
      path: '/home/u', home: '/home/u', parent: null,
      entries: [
        { name: '.git', type: 'dir', mtimeMs: Date.now() - 60_000 },
        { name: 'node_modules', type: 'dir', mtimeMs: Date.now() - 60_000 },
        { name: 'src', type: 'dir', mtimeMs: Date.now() - 60_000 },
        { name: 'notes.md', type: 'doc', size: 10, mtimeMs: Date.now() - 60_000 },
      ],
    });
    await render({ path: null });
    await settle();
    // Default is off, so the count is the folder's real contents.
    const names = rowNames();
    expect(names).toHaveLength(4);
    expect(names).toEqual(expect.arrayContaining(['.git', 'node_modules', 'src', 'notes.md']));
    expect(container.querySelector('.browse-count').textContent).toBe('4 项');
    // The switch is always there, whatever the folder holds, and reads the same either way.
    const chip = container.querySelector('.browse-chip'); // the collapse switch, right of the sort control
    expect(chip.textContent).toBe('收起隐藏项');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await click(chip);
    expect(rowNames()).toEqual(['src', 'notes.md']);
    expect(container.querySelector('.browse-count').textContent).toBe('2 项');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('tw_browse_collapse')).toBe('1');
  });

  it('says the folder is empty (and "only hidden" once they are collapsed) instead of "no match"', async () => {
    fetchDir.mockResolvedValueOnce({ path: '/home/u/empty', home: '/home/u', parent: '/home/u', entries: [] });
    await render({ path: '/home/u/empty' });
    await settle();
    expect(container.textContent).toContain('这个文件夹是空的');
    expect(container.querySelector('.browse-listbar')).toBeNull(); // no count and no switches for nothing

    fetchDir.mockResolvedValueOnce({
      path: '/home/u/dot', home: '/home/u', parent: '/home/u',
      entries: [{ name: '.env', type: 'file', size: 4, mtimeMs: Date.now() }],
    });
    await render({ path: '/home/u/dot' });
    await settle();
    expect(rowNames()).toEqual(['.env']); // shown by default
    await click(container.querySelector('.browse-chip'));
    expect(container.textContent).toContain('这里只有隐藏项');
    expect(container.querySelector('.browse-chip')).toBeTruthy(); // and the way back
  });

  it('shows a loading skeleton instead of an empty-state line until the listing arrives', async () => {
    let release;
    fetchDir.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await render({ path: null });
    expect(container.querySelectorAll('.browse-skeleton-row').length).toBeGreaterThan(0);
    expect(container.querySelector('.browse-empty')).toBeNull();
    expect(container.querySelector('.browse-list').getAttribute('aria-busy')).toBe('true');
    await act(async () => { release({ path: '/home/u', home: '/home/u', parent: null, entries: [] }); });
    await settle();
    expect(container.querySelector('.browse-skeleton-row')).toBeNull();
    expect(container.textContent).toContain('这个文件夹是空的');
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

  it('a file\'s ⋯ menu offers copy + download, and the download needs a second tap', async () => {
    await render({ path: null });
    await settle();
    await click(rowFor('data.bin').querySelector('.browse-more'));
    // the sheet is titled with the entry it belongs to, and nothing has been pulled yet
    expect(container.querySelector('.settings-title').textContent).toBe('data.bin');
    expect([...container.querySelectorAll('.sheet-action')].map((b) => b.textContent.trim()))
      .toEqual(['复制绝对路径', '下载']);
    expect(downloadFile).not.toHaveBeenCalled();
    // first tap arms the destructive-ish action and relabels it with the file it will fetch
    const download = () => [...container.querySelectorAll('.sheet-action')].find((b) => b.textContent.includes('下载'));
    await click(download());
    expect(container.textContent).toContain('下载 data.bin？');
    expect(downloadFile).not.toHaveBeenCalled();
    // second tap on the armed action downloads
    await click(download());
    expect(downloadFile).toHaveBeenCalledWith('/home/u/data.bin', expect.any(Function));
    expect(container.querySelector('.sheet-action')).toBeNull(); // sheet closed so the progress bar shows
    await settle(); // let the transfer-progress state settle (doDownload's finally) inside act
  });

  it('a directory\'s ⋯ menu has no download — there is nothing to pull', async () => {
    await render({ path: null });
    await settle();
    await click(rowFor('docs').querySelector('.browse-more'));
    expect(container.querySelector('.settings-title').textContent).toBe('docs');
    expect([...container.querySelectorAll('.sheet-action')].map((b) => b.textContent.trim()))
      .toEqual(['复制绝对路径']);
  });

  it('cancelling the ⋯ menu downloads nothing', async () => {
    await render({ path: null });
    await settle();
    await click(rowFor('report.md').querySelector('.browse-more'));
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

  it('assembles the rejected-type note from the locale punctuation rather than a hardcoded one', async () => {
    await render({ path: '/home/u/docs' });
    await settle();
    // .exe is not an allowed upload extension, and a name with no extension is refused too.
    const files = [new File(['x'], 'a.exe'), new File(['x'], 'README')];
    const fileInput = container.querySelector('.browse-file-input');
    Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    const expected = zh['filebrowser.uploadRejected']
      .replace('{names}', ['a.exe', 'README'].join(zh['common.listSeparator']));
    expect(container.querySelector('.browse-err').textContent).toBe(expected);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('gives each kind of entry its own icon, so a document reads differently from a plain file', async () => {
    await render({ path: null });
    await settle();
    const iconOf = (name) => rowFor(name).querySelector('.browse-entry-icon').innerHTML;
    const markup = ['docs', 'photo.gif', 'report.md', 'data.bin'].map(iconOf);
    // directory / image / openable document / downloadable file — four distinct glyphs, not three
    // with docs and binaries sharing the generic page.
    expect(new Set(markup).size).toBe(4);
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
    // picking a directory is a one-tap job: no per-row ⋯ here
    expect(container.querySelector('.browse-more')).toBeNull();
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

  it('caps a huge listing at 300 rows and says so in the count; typing filters it away', async () => {
    const orig = fetchDir.getMockImplementation();
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `f${String(i).padStart(4, '0')}.bin`, type: 'file', size: 1 }));
    fetchDir.mockImplementation(async () => ({ path: '/home/u', home: '/home/u', parent: null, entries: many }));
    try {
      await render({ path: null });
      await settle();
      expect(container.querySelectorAll('.browse-entry').length).toBe(300); // capped
      const count = container.querySelector('.browse-count');
      expect(count.textContent).toContain('1000'); // total
      expect(count.textContent).toContain('300');  // shown

      type(input(), 'f0001'); // a unique fragment → one match, no overflow
      await settle();
      expect(container.querySelectorAll('.browse-entry').length).toBe(1);
      expect(container.querySelector('.browse-count').textContent).toBe('1 项');
    } finally { fetchDir.mockImplementation(orig); }
  });
});
