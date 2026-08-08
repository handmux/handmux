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

describe('Settings agent chat-view switches', () => {
  it('shows separate Claude experimental and Codex stable switches; tone appears when either is enabled', async () => {
    await render({ claudeChatLensEnabled: false, codexChatLensEnabled: false });
    expect(container.textContent).toContain('Claude Code 对话视图（实验性）');
    expect(container.textContent).toContain('Codex CLI 对话视图');
    expect(container.textContent).not.toContain('Codex CLI 对话视图（实验性）');
    expect([...container.querySelectorAll('.settings-page-row-label')]
      .some((label) => label.textContent === '对话配色')).toBe(false);

    await render({ claudeChatLensEnabled: false, codexChatLensEnabled: true });
    const toneRow = [...container.querySelectorAll('.settings-page-row')]
      .find((row) => row.querySelector('.settings-page-row-label')?.textContent === '对话配色');
    expect(toneRow).toBeTruthy();
    click(toneRow);
    expect([...container.querySelectorAll('.settings-choice-row')].some((b) => b.textContent === '暖夜')).toBe(true);
  });

  it('reports each iOS switch independently', async () => {
    const onClaudeChatLensEnabled = vi.fn();
    const onCodexChatLensEnabled = vi.fn();
    await render({
      claudeChatLensEnabled: false, codexChatLensEnabled: true,
      onClaudeChatLensEnabled, onCodexChatLensEnabled,
    });
    expect(lensBox('Claude Code').checked).toBe(false);
    expect(lensBox('Codex CLI').checked).toBe(true);
    click(lensBox('Claude Code'));
    expect(onClaudeChatLensEnabled).toHaveBeenCalledWith(true);
    expect(onCodexChatLensEnabled).not.toHaveBeenCalled();
    click(lensBox('Codex CLI'));
    expect(onCodexChatLensEnabled).toHaveBeenCalledWith(false);
  });

  const lensBox = (name) => [...container.querySelectorAll('.settings-page-switch')]
    .find((label) => label.textContent.includes(name))?.querySelector('input[type="checkbox"]');

  it('hooks absent locks only Claude and offers hook installation', async () => {
    const onEnableHooks = vi.fn(async () => ({ status: 'installed' }));
    await render({
      claudeChatLensEnabled: false, codexChatLensEnabled: false, hooksStatus: 'absent', onEnableHooks,
    });
    expect(lensBox('Claude Code').disabled).toBe(true);
    expect(lensBox('Codex CLI').disabled).toBe(false);
    expect(container.textContent).toContain('需先安装 Agent hooks');
    expect(container.textContent).toContain('普通 Codex 仍可使用终端，但不会同步状态和通知');
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '一键安装 hooks');
    expect(btn).toBeTruthy();
    click(btn);
    await act(async () => { await Promise.resolve(); });
    expect(onEnableHooks).toHaveBeenCalled();
  });

  it('hooks absent but Claude is already enabled still allows turning Claude off', async () => {
    await render({ claudeChatLensEnabled: true, hooksStatus: 'absent' });
    expect(lensBox('Claude Code').disabled).toBe(false);
    expect(lensBox('Claude Code').checked).toBe(true);
  });

  it('no Claude Code locks only Claude and does not imply Codex is missing', async () => {
    await render({ claudeChatLensEnabled: false, codexChatLensEnabled: false, hooksStatus: 'no-claude' });
    expect(lensBox('Claude Code').disabled).toBe(true);
    expect(lensBox('Codex CLI').disabled).toBe(false);
    expect(container.textContent).toContain('未检测到 Claude Code');
    expect(container.textContent).not.toContain('未检测到 Claude Code 或 Codex CLI');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '一键安装 hooks')).toBe(false);
  });

  it('hooks installed or still unknown keeps the Claude switch usable', async () => {
    await render({ claudeChatLensEnabled: false, hooksStatus: 'installed' });
    expect(lensBox('Claude Code').disabled).toBe(false);
    await render({ claudeChatLensEnabled: false, hooksStatus: null });
    expect(lensBox('Claude Code').disabled).toBe(false);
  });
});
