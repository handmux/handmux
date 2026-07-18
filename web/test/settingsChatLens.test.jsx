import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(), pushSupported: () => false,
}));
vi.mock('../src/api.js', () => ({ fetchPaneCwd: vi.fn(async () => ({ cwd: '/home/u/proj' })) }));

import Settings from '../src/components/Settings.jsx';

let container, root;
const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
const render = (props) => act(() => root.render(
  <Settings open onClose={() => {}} termRef={termRef}
    onColAdjust={() => {}} onColRestore={() => {}} onOpenChangelog={() => {}} changelogUnread={false}
    {...props} />));
const click = (n) => act(() => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('Settings 对话镜头 experimental gate', () => {
  it('always shows the 启用对话镜头（实验性功能）toggle; the tone picker only appears when enabled', async () => {
    await render({ chatLensEnabled: false });
    expect(container.textContent).toContain('启用对话镜头（实验性功能）');
    // tone picker hidden while the lens is off (its option buttons are gone; the section label too —
    // scoped to buttons so the toggle's own hint text mentioning 对话配色 doesn't false-positive)
    expect([...container.querySelectorAll('.fontbtn')].some((b) => b.textContent === '暖夜')).toBe(false);

    await render({ chatLensEnabled: true });
    expect(container.textContent).toContain('对话配色');
    expect([...container.querySelectorAll('.fontbtn')].some((b) => b.textContent === '暖夜')).toBe(true);
  });

  it('the toggle is an iOS-style switch whose checkbox mirrors chatLensEnabled and reports changes', async () => {
    const onChatLensEnabled = vi.fn();
    await render({ chatLensEnabled: false, onChatLensEnabled });
    const label = [...container.querySelectorAll('.settings-toggle')]
      .find((l) => l.textContent.includes('启用对话镜头'));
    expect(label).toBeTruthy();
    const box = label.querySelector('input[type="checkbox"]');
    expect(box.checked).toBe(false);
    click(box);
    expect(onChatLensEnabled).toHaveBeenCalledWith(true);
  });

  const lensBox = () => [...container.querySelectorAll('.settings-toggle')]
    .find((l) => l.textContent.includes('启用对话镜头'))?.querySelector('input[type="checkbox"]');

  it('hooks absent → toggle locked with the need-hooks hint and a one-tap install button', async () => {
    const onEnableHooks = vi.fn(async () => ({ status: 'installed' }));
    await render({ chatLensEnabled: false, hooksStatus: 'absent', onEnableHooks });
    expect(lensBox().disabled).toBe(true);
    expect(container.textContent).toContain('需先安装 Claude hooks');
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '一键安装 hooks');
    expect(btn).toBeTruthy();
    click(btn);
    await act(async () => { await Promise.resolve(); });
    expect(onEnableHooks).toHaveBeenCalled();
  });

  it('hooks absent but lens already enabled → still allows turning it OFF (no dead-end)', async () => {
    await render({ chatLensEnabled: true, hooksStatus: 'absent' });
    expect(lensBox().disabled).toBe(false);
    expect(lensBox().checked).toBe(true);
  });

  it('no Claude Code at all → locked with the no-claude hint and NO install button', async () => {
    await render({ chatLensEnabled: false, hooksStatus: 'no-claude' });
    expect(lensBox().disabled).toBe(true);
    expect(container.textContent).toContain('未检测到 Claude Code');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '一键安装 hooks')).toBe(false);
  });

  it('hooks installed (or still unknown) → toggle stays usable', async () => {
    await render({ chatLensEnabled: false, hooksStatus: 'installed' });
    expect(lensBox().disabled).toBe(false);
    await render({ chatLensEnabled: false, hooksStatus: null });
    expect(lensBox().disabled).toBe(false);
  });
});
