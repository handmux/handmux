import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  getSessions: vi.fn(),
  createSession: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  fetchDir: vi.fn((path) => Promise.resolve({
    path: path ?? '/home/u',
    home: '/home/u',
    parent: path && path !== '/home/u' ? '/home/u' : null,
    entries: [{ name: 'sub', type: 'dir' }],
  })),
  fetchPaneCwd: vi.fn(),
}));

import BindSession from '../src/components/BindSession.jsx';
import { getSessions, createSession, UnauthorizedError } from '../src/api.js';

let container;
let root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = {
  open: true,
  bound: [],
  onBound: vi.fn(),
  onClose: vi.fn(),
  onAuthFail: vi.fn(),
};

const render = (props) => act(async () => root.render(<BindSession {...base} {...props} />));
const fire = (node, type) => act(async () => { node.dispatchEvent(new MouseEvent(type, { bubbles: true })); });
// Flush the async getSessions/createSession and the re-renders they trigger.
const settle = async () => { await act(async () => {}); await act(async () => {}); };
// React tracks the controlled value via the native setter; set it then fire `input` so onChange runs.
const typeInto = (node, text) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});
// Click an existing-session chip by its visible text (only shown in "existing" mode).
const target = (text) => [...container.querySelectorAll('.orphan-targets .fontbtn')].find((b) => b.textContent === text);
// Click a top mode segment ('新建会话' / '已有会话') by its text.
const seg = (text) => [...container.querySelectorAll('.bind-mode .seg')].find((b) => b.textContent === text);

describe('BindSession', () => {
  it('binds a picked existing session directly (no create)', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }]);
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(target('main'), 'click');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(onBound).toHaveBeenCalledWith('main');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('binds an existing spaced (PC-made) name — charset rule is create-only', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'Typeless Session' }]);
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(target('Typeless Session'), 'click');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(onBound).toHaveBeenCalledWith('Typeless Session');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('hides already-bound sessions from the pick list', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }, { id: '$1', name: 'other' }]);
    await render({ bound: ['main'] });
    await settle();
    expect(target('main')).toBeUndefined();
    expect(target('other')).toBeDefined();
  });

  it('rejects malformed session data at the API boundary', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 7 }]);
    await render({});
    await settle();
    expect(container.querySelector('.bind-error')?.textContent).toContain('校验失败');
    expect(container.querySelector('.orphan-targets')).toBeNull();
  });

  it('confirm is disabled until something is picked', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }]);
    await render({});
    await settle();
    expect(container.querySelector('.bind-confirm').disabled).toBe(true);
    await fire(target('main'), 'click');
    expect(container.querySelector('.bind-confirm').disabled).toBe(false);
  });

  it('creates a new session via the ＋ entry', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }]);
    createSession.mockResolvedValue({ id: '$7', name: 'new-sess' });
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'new-sess');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(createSession).toHaveBeenCalledWith('new-sess', undefined, undefined);
    expect(onBound).toHaveBeenCalledWith('new-sess');
  });

  it('rejects creating a name that already exists — no network call', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }]);
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'main');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(container.querySelector('.bind-error').textContent).toContain('已存在');
    expect(createSession).not.toHaveBeenCalled();
    expect(onBound).not.toHaveBeenCalled();
  });

  it('rejects an invalid new name (charset)', async () => {
    getSessions.mockResolvedValue([]);
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'bad name');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(container.querySelector('.bind-error')).not.toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(onBound).not.toHaveBeenCalled();
  });

  it('shows create failure and stays put', async () => {
    getSessions.mockResolvedValue([]);
    createSession.mockRejectedValueOnce(new Error('boom'));
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'newsess');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(onBound).not.toHaveBeenCalled();
    const btn = container.querySelector('.bind-confirm');
    expect(btn.disabled).toBe(false);
    expect(container.querySelector('.bind-error').textContent).toContain('新建失败');
  });

  it('calls onAuthFail (no error text) when create hits an auth error', async () => {
    getSessions.mockResolvedValue([]);
    createSession.mockRejectedValueOnce(new UnauthorizedError());
    const onAuthFail = vi.fn();
    const onBound = vi.fn();
    await render({ onAuthFail, onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'newsess');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(onAuthFail).toHaveBeenCalled();
    expect(onBound).not.toHaveBeenCalled();
    expect(container.querySelector('.bind-error')).toBeNull();
  });

  it('hides the 起始目录 segment until ＋ 新建 is chosen', async () => {
    getSessions.mockResolvedValue([{ id: '$0', name: 'main' }]);
    await render({});
    await settle();
    expect(container.textContent).not.toContain('起始目录');
    await fire(seg('新建会话'), 'click');
    expect(container.textContent).toContain('起始目录');
  });

  it('creates with the picked cwd', async () => {
    getSessions.mockResolvedValue([]);
    createSession.mockResolvedValue({ id: '$7', name: 'newsess' });
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'newsess');
    // Open the picker via the start-dir field
    await fire(container.querySelector('.cwd-field'), 'click');
    await settle();
    expect(container.querySelector('[aria-label="选择目录"]')).not.toBeNull();
    // fetchDir boots with null (home) → entries has 'sub'; navigate into it
    await fire(container.querySelector('.browse-entry'), 'click');
    await settle();
    await fire(container.querySelector('.browse-pick-confirm'), 'click');
    await settle();
    expect(container.querySelector('[aria-label="选择目录"]')).toBeNull();
    expect(container.textContent).toContain('/home/u/sub');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(createSession).toHaveBeenCalledWith('newsess', '/home/u/sub', undefined);
    expect(onBound).toHaveBeenCalledWith('newsess');
  });

  it('creates with no cwd when the dir is left default', async () => {
    getSessions.mockResolvedValue([]);
    createSession.mockResolvedValue({ id: '$7', name: 'newsess' });
    const onBound = vi.fn();
    await render({ onBound });
    await settle();
    await fire(seg('新建会话'), 'click');
    typeInto(container.querySelector('.bind-input'), 'newsess');
    await fire(container.querySelector('.bind-confirm'), 'click');
    await settle();
    expect(createSession).toHaveBeenCalledWith('newsess', undefined, undefined);
    expect(onBound).toHaveBeenCalledWith('newsess');
  });
});
