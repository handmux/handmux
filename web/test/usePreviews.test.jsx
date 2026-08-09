import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const api = vi.hoisted(() => {
  return {
    reset() {},
    createPreview: vi.fn(async (name, { dir }) => {
      return { name, dir, url: `/preview/${name}/token-${name}/` };
    }),
    deletePreview: vi.fn(async () => {}),
  };
});

vi.mock('../src/api.js', () => ({
  createPreview: api.createPreview,
  deletePreview: api.deletePreview,
}));

import { usePreviews } from '../src/hooks/usePreviews.js';

let container;
let root;
let model;
const current = {
  session: { name: 'dev' },
  window: { id: '@3', name: 'site' },
  paneId: '%8',
};

function Harness() {
  model = usePreviews(current);
  return null;
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(async () => {
  localStorage.clear();
  api.reset();
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  await flush();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe('usePreviews static tabs', () => {
  const remount = async () => {
    await act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    await flush();
  };

  it('automatically restores an open static tab after remount', async () => {
    await act(async () => { await model.startPreview('/home/u/site'); });
    const name = model.tabs[0].name;
    const createdAt = model.tabs[0].createdAt;
    api.createPreview.mockClear();

    await remount();

    expect(api.createPreview).toHaveBeenCalledWith(name, { dir: '/home/u/site' });
    expect(model.tabs[0]).toMatchObject({
      status: 'ready', url: `/preview/${name}/token-${name}/`, createdAt,
    });
  });

  it('reuses a restored tab when history opens the same directory from another window identity', async () => {
    localStorage.setItem('hm_static_preview_tabs1', JSON.stringify([
      { name: 'other-window-9', dir: '/home/u/site', createdAt: 100 },
    ]));
    await remount();
    api.createPreview.mockClear();

    await act(async () => { await model.startPreview('/home/u/site'); });

    expect(model.tabs).toHaveLength(1);
    expect(model.tabs[0]).toMatchObject({ name: 'other-window-9', dir: '/home/u/site' });
    expect(model.activeName).toBe('other-window-9');
    expect(model.selected).toBe(true);
    expect(api.createPreview).not.toHaveBeenCalled();
  });

  it('repairs persisted duplicate directories and releases only the redundant lease', async () => {
    localStorage.setItem('hm_static_preview_tabs1', JSON.stringify([
      { name: 'original-1', dir: '/home/u/site', createdAt: 100 },
      { name: 'duplicate-2', dir: '/home/u/site', createdAt: 200 },
      { name: 'docs-3', dir: '/home/u/docs', createdAt: 300 },
    ]));
    await remount();

    expect(model.tabs.map(({ name, dir }) => ({ name, dir }))).toEqual([
      { name: 'original-1', dir: '/home/u/site' },
      { name: 'docs-3', dir: '/home/u/docs' },
    ]);
    expect(api.deletePreview).toHaveBeenCalledWith('duplicate-2');
    expect(api.deletePreview).not.toHaveBeenCalledWith('original-1');
    expect(JSON.parse(localStorage.getItem('hm_static_preview_tabs1'))).toEqual([
      { name: 'original-1', dir: '/home/u/site', createdAt: 100 },
      { name: 'docs-3', dir: '/home/u/docs', createdAt: 300 },
    ]);
  });

  it('foregrounds by ensuring the lease without a periodic heartbeat', async () => {
    await act(async () => { await model.startPreview('/home/u/site'); });
    const name = model.tabs[0].name;
    api.createPreview.mockClear();

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(api.createPreview).toHaveBeenCalledTimes(1);
    expect(api.createPreview).toHaveBeenCalledWith(name, { dir: '/home/u/site' });
    expect(model.tabs[0].status).toBe('ready');
  });

  it('closes the device tab and releases its server lease together', async () => {
    await act(async () => { await model.startPreview('/home/u/site'); });
    expect(model.selected).toBe(true);
    expect(model.tabs).toHaveLength(1);
    expect(model.tabs[0]).toMatchObject({ dir: '/home/u/site', status: 'ready' });

    const name = model.tabs[0].name;
    await act(async () => { await model.closeTab(name); });
    expect(model.tabs).toHaveLength(0);
    expect(api.deletePreview).toHaveBeenCalledWith(name);
    expect(JSON.parse(localStorage.getItem('hm_static_preview_tabs1'))).toEqual([]);
  });

  it('serializes close and reopen so a late delete cannot remove the new directory', async () => {
    await act(async () => { await model.startPreview('/home/u/old'); });
    const name = model.tabs[0].name;
    let resolveDelete;
    api.deletePreview.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve; }));

    let closing;
    let reopening;
    act(() => {
      closing = model.closeTab(name);
      reopening = model.startPreview('/home/u/new');
    });
    await flush();

    expect(api.createPreview).toHaveBeenCalledTimes(1);
    resolveDelete();
    await act(async () => { await Promise.all([closing, reopening]); });
    expect(api.createPreview).toHaveBeenLastCalledWith(name, { dir: '/home/u/new' });
    expect(model.tabs).toEqual([expect.objectContaining({ name, dir: '/home/u/new' })]);
  });

  it('keeps a failed restored tab and exposes retry with the real error', async () => {
    localStorage.setItem('hm_static_preview_tabs1', JSON.stringify([
      { name: 'dev-site-3', dir: '/home/u/site' },
    ]));
    api.createPreview.mockRejectedValueOnce(new Error('directory not found'));

    await remount();

    expect(model.tabs[0]).toMatchObject({ status: 'error' });
    expect(model.tabs[0].error.message).toBe('directory not found');
    await act(async () => { await model.retryPreview('dev-site-3'); });
    expect(model.tabs[0].status).toBe('ready');
  });

  it('rejects a malformed preview lease before adding a static tab', async () => {
    api.createPreview.mockResolvedValueOnce({ name: 'dev-site-3', dir: '/home/u/site' });
    let created;

    await act(async () => { created = await model.startPreview('/home/u/site'); });

    expect(created).toBeNull();
    expect(model.tabs).toEqual([]);
    expect(model.error?.message).toBe('preview URL unavailable');
  });
});
