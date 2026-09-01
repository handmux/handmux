import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(), pushSupported: () => false,
}));

import Settings from '../src/components/Settings.jsx';

let container, root;
const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
const render = (props) => act(() => root.render(
  <Settings open onClose={() => {}} termRef={termRef} onOpenChangelog={() => {}}
    changelogUnread={false} {...props} />));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const lensBox = (name) => [...container.querySelectorAll('.settings-page-switch')]
  .find((label) => label.textContent.includes(name))?.querySelector('input[type="checkbox"]');
const conversationRow = (name) => [...container.querySelectorAll('.settings-page-switch')]
  .find((label) => label.textContent.includes(name));
const integrationController = (items, overrides = {}) => ({
  status: 'ready', items, busy: null, error: null,
  refresh: vi.fn(async () => {}), enable: vi.fn(async () => {}),
  ...overrides,
});

describe('Settings catalog-driven Conversation views', () => {
  it('keeps Codex, Claude Code, Pi, and chat colour in one Conversation group', async () => {
    await render({ conversationAgents: [
      { id: 'codex', label: 'Codex', enabled: true, experimental: false },
      { id: 'claude', label: 'Claude Code', enabled: true, experimental: true },
      { id: 'pi', label: 'Pi', enabled: false, experimental: true },
    ] });
    const chatHeading = [...container.querySelectorAll('.settings-page-group > h2')]
      .filter((heading) => heading.textContent === '对话');
    expect(chatHeading).toHaveLength(1);
    const chatGroup = chatHeading[0].closest('.settings-page-group');
    expect(chatGroup.textContent).toContain('Codex 对话视图');
    expect(chatGroup.textContent).toContain('Claude Code 对话视图');
    expect(chatGroup.textContent).toContain('Pi 对话视图');
    expect(chatGroup.textContent).toContain('对话配色');
    const rowLabels = [...chatGroup.querySelectorAll('.settings-page-row-label')];
    expect(rowLabels).toHaveLength(4);
    expect(rowLabels.at(-1)?.textContent).toBe('对话配色');
    expect(conversationRow('Codex').querySelector('.settings-conversation-experimental')).toBeNull();
    expect(conversationRow('Claude Code').querySelector('.settings-conversation-experimental')?.textContent)
      .toBe('实验性');
    expect(conversationRow('Pi').querySelector('.settings-conversation-experimental')?.textContent)
      .toBe('实验性');
  });

  it('drives the inline marker and switch callback only from catalog metadata', async () => {
    const onConversationAgentEnabled = vi.fn();
    await render({
      conversationAgents: [
        { id: 'claude', label: 'Stable Alias', enabled: true, experimental: false },
        { id: 'future', label: 'Future Agent', enabled: false, experimental: true },
      ],
      onConversationAgentEnabled,
    });
    expect(conversationRow('Stable Alias').querySelector('.settings-conversation-experimental')).toBeNull();
    expect(conversationRow('Future Agent').querySelector('.settings-conversation-experimental')).not.toBeNull();
    click(lensBox('Future Agent'));
    expect(onConversationAgentEnabled).toHaveBeenCalledWith('future', true);
  });

  it('keeps an unbroken long catalog label in the shrinkable name slot', async () => {
    const longLabel = 'FutureAgent'.repeat(16);
    await render({ conversationAgents: [
      { id: 'future', label: longLabel, enabled: true, experimental: true },
    ] });
    const row = conversationRow(longLabel);
    expect(row.querySelector('.settings-conversation-agent-name')?.textContent)
      .toBe(`${longLabel} 对话视图`);
    expect(row.querySelector('.settings-conversation-experimental')).not.toBeNull();
    expect(row.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('shows only Claude Code and Pi and enables a disabled integration', async () => {
    const agentIntegrations = integrationController([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
    ]);
    await render({ agentIntegrations, conversationAgents: [] });
    expect(container.textContent).toContain('Agent 集成');
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('Pi');
    expect(container.textContent).toContain('已接入');
    expect(container.textContent).toContain('未启用');
    expect(container.textContent).not.toContain('Codex');
    expect(container.textContent.toLowerCase()).not.toContain('hooks');
    expect(container.textContent.toLowerCase()).not.toContain('extension');
    expect(container.textContent).not.toContain('实验性 Agent 视图');
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === '启用');
    expect(button).toBeTruthy();
    click(button);
    await act(async () => { await Promise.resolve(); });
    expect(agentIntegrations.enable).toHaveBeenCalledWith('pi');
  });

  it('repairs owned setup and gives a safe computer-side command for conflicts', async () => {
    const agentIntegrations = integrationController([
      { name: 'claude', status: 'needs-repair' },
      { name: 'pi', status: 'conflict' },
    ]);
    await render({ agentIntegrations, conversationAgents: [] });
    expect(container.textContent).toContain('需要修复');
    expect(container.textContent).toContain('需要处理');
    expect(container.textContent).toContain('handmux agent status pi');
    const repair = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === '修复');
    expect(repair).toBeTruthy();
    click(repair);
    await act(async () => { await Promise.resolve(); });
    expect(agentIntegrations.enable).toHaveBeenCalledWith('claude');
  });

  it('reports a missing Agent without offering an enable action', async () => {
    const agentIntegrations = integrationController([
      { name: 'claude', status: 'not-installed' },
      { name: 'pi', status: 'ready' },
    ]);
    await render({ agentIntegrations, conversationAgents: [] });
    expect(container.textContent).toContain('这台电脑尚未安装 Claude Code。');
    expect([...container.querySelectorAll('button')]
      .some((candidate) => candidate.textContent === '启用' || candidate.textContent === '修复')).toBe(false);
  });

  it('asks for Claude Code first-run initialization instead of offering a no-op action', async () => {
    const agentIntegrations = integrationController([
      { name: 'claude', status: 'not-enabled', reason: 'initialize-first' },
      { name: 'pi', status: 'ready' },
    ]);
    await render({ agentIntegrations, conversationAgents: [] });
    expect(container.textContent).toContain('请先在电脑上运行一次 Claude Code，再回来启用。');
    expect([...container.querySelectorAll('button')]
      .some((candidate) => candidate.textContent === '启用')).toBe(false);
  });

  it('disables every integration action while one Agent is being updated', async () => {
    const agentIntegrations = integrationController([
      { name: 'claude', status: 'not-enabled' },
      { name: 'pi', status: 'needs-repair' },
    ], { busy: 'claude' });
    await render({ agentIntegrations, conversationAgents: [] });
    const actions = [...container.querySelectorAll('.settings-agent-integration-action')];
    expect(actions).toHaveLength(2);
    expect(actions.every((button) => button.disabled)).toBe(true);
    expect(actions.map((button) => button.textContent)).toEqual(['处理中…', '修复']);
  });
});
