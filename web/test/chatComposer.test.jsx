import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  sendCodexMessage: vi.fn(async () => ({ ok: true })),
  steerCodexQueuedMessage: vi.fn(async () => ({ steered: true })),
  removeCodexQueuedMessage: vi.fn(async () => ({ removed: true })),
  beginCodexQueuedEdit: vi.fn(async (_pane, id) => ({
    editing: true, token: 'edit-token', item: { id, text: '再整理结果', editing: true },
  })),
  commitCodexQueuedEdit: vi.fn(async (_pane, id, _token, text) => ({
    edited: true, item: { id, text },
  })),
  cancelCodexQueuedEdit: vi.fn(async () => ({ editing: false })),
  compactCodexSession: vi.fn(async () => ({ ok: true })),
  clearCodexSession: vi.fn(async () => ({ threadId: 'thread-new' })),
  interruptCodexSession: vi.fn(async () => ({ interrupted: true })),
  getCodexModels: vi.fn(async () => ({ models: [] })),
  getCodexGoal: vi.fn(async () => ({ goal: null })),
  updateCodexGoal: vi.fn(async (_pane, updates) => ({ goal: {
    objective: updates.objective || 'Current goal', status: updates.status || 'active',
  } })),
  clearCodexGoal: vi.fn(async () => ({ cleared: true })),
  updateCodexSettings: vi.fn(async (_pane, settings) => ({ settings })),
  getPaneContext: vi.fn(() => new Promise(() => {})), // no context chip by default
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const voice = vi.hoisted(() => ({ state: 'idle', partial: '', start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import ChatComposer, { clearCodexModelsCache } from '../src/components/ChatComposer.jsx';
import {
  sendText, sendCodexMessage, compactCodexSession, clearCodexSession, interruptCodexSession,
  steerCodexQueuedMessage, removeCodexQueuedMessage,
  beginCodexQueuedEdit, commitCodexQueuedEdit, cancelCodexQueuedEdit,
  getCodexModels, getCodexGoal, updateCodexGoal, clearCodexGoal,
  updateCodexSettings, getPaneContext,
} from '../src/api.js';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

// No globals:true → register cleanup manually so DOM doesn't leak between tests.
afterEach(cleanup);
beforeEach(() => {
  clearCodexModelsCache();
  vi.clearAllMocks();
  getPaneContext.mockImplementation(() => new Promise(() => {}));
  getCodexModels.mockResolvedValue({ models: [] });
  getCodexGoal.mockResolvedValue({ goal: null });
  updateCodexGoal.mockImplementation(async (_pane, updates) => ({ goal: {
    objective: updates.objective || 'Current goal', status: updates.status || 'active',
  } }));
  clearCodexGoal.mockResolvedValue({ cleared: true });
  updateCodexSettings.mockImplementation(async (_pane, settings) => ({ settings }));
  localStorage.clear();
  voice.state = 'idle';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

const typeInto = (el, text) => fireEvent.change(el, { target: { value: text } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('ChatComposer', () => {
  it('keeps vertical swipes on the horizontal shortcut strip from panning the page', () => {
    expect(styles).toMatch(/\.cc-quick\s*\{[^}]*overflow-y:\s*hidden[^}]*overscroll-behavior:\s*contain[^}]*touch-action:\s*pan-x/);
  });

  it('renders the same device-local merged order as the editor', () => {
    localStorage.setItem('hm_favs7_agent', JSON.stringify([
      { kind: 'reply', text: 'local', enter: true },
    ]));
    localStorage.setItem('hm_shortcut_layout1_chat', JSON.stringify({
      hidden: [], order: ['text:local:enter', 'key:C-c'],
    }));
    render(<ChatComposer pane="%1" kind="idle" shortcuts={{
      command: [], chat: [{ type: 'key', key: 'C-c', label: 'Ctrl+C' }],
    }} />);
    expect([...screen.getAllByRole('button')].slice(0, 2).map((node) => node.textContent))
      .toEqual(['local', 'Ctrl+C']);
  });

  it('send is disabled until there is non-blank text', () => {
    render(<ChatComposer pane="%1" kind="idle" />);
    expect(screen.getByPlaceholderText('和 Agent 对话…').rows).toBe(2);
    const send = screen.getByRole('button', { name: '发送' });
    expect(send.disabled).toBe(true);
    typeInto(screen.getByPlaceholderText('和 Agent 对话…'), '  ');
    expect(screen.getByRole('button', { name: '发送' }).disabled).toBe(true); // blank stays disabled
    typeInto(screen.getByPlaceholderText('和 Agent 对话…'), '你好');
    expect(screen.getByRole('button', { name: '发送' }).disabled).toBe(false);
  });

  it('tapping send types the text + Enter and clears the box', async () => {
    const onSent = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onSent={onSent} />);
    const ta = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(ta, '继续实现');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(ta.value).toBe(''));
    expect(sendText).toHaveBeenCalledWith('%1', '继续实现', true);
    expect(onSent).toHaveBeenCalledWith('继续实现');
  });

  it('reports a terminal-backed send failure to the conversation instead of rendering red text under the composer', async () => {
    const onActionError = vi.fn();
    sendText.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { serverError: '连接已断开' }));
    render(<ChatComposer pane="%1" kind="idle" onActionError={onActionError} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '重试这条消息');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(onActionError).toHaveBeenLastCalledWith({
      kind: 'send', detail: '连接已断开',
    }));
    expect(document.querySelector('.cc-error')).toBeNull();
    expect(input.value).toBe('重试这条消息');
  });

  it('locks editing and ignores repeated Enter while a send is in flight', async () => {
    const request = deferred();
    sendText.mockReturnValueOnce(request.promise);
    render(<ChatComposer pane="%1" kind="idle" desktop />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '只发一次');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '发送' }).disabled).toBe(true);
    expect(input.getAttribute('aria-readonly')).toBe('true');
    typeInto(input, '发送中不应改写');
    expect(input.value).toBe('只发一次');

    request.resolve({ ok: true });
    await waitFor(() => expect(input.value).toBe(''));
    expect(input.getAttribute('aria-readonly')).toBe('false');
  });

  it('sending a bare non-one-shot slash command hands off to the terminal lens — incl. unrecognized ones', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    const ta = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(ta, '/model');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/model', true));
    typeInto(ta, '/effort'); // was previously missed — now caught by the unknown-command fallback
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/effort', true));
    expect(onInteractiveSlash).toHaveBeenCalledTimes(2); // both handed off
    expect(onInteractiveSlash).toHaveBeenLastCalledWith('/effort'); // forwards the command (for the toast)
  });

  it('does NOT hand off for a slash command with args or a known one-shot (they finish in chat)', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    const ta = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(ta, '/model sonnet');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/model sonnet', true));
    typeInto(ta, '/clear');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/clear', true));
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('never falls back to terminal input for an unmanaged Codex composer', async () => {
    const onInteractiveSlash = vi.fn();
    const onActionError = vi.fn();
    render(<ChatComposer pane="%1" agent="codex" kind="idle" onInteractiveSlash={onInteractiveSlash}
      onActionError={onActionError} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '/compact');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onActionError).toHaveBeenLastCalledWith({
      kind: 'send', detail: '请先在终端以托管模式重新启动 Codex',
    }));
    expect(sendText).not.toHaveBeenCalled();
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('sends managed Codex messages, compaction, and clear through App Server only', async () => {
    const onInteractiveSlash = vi.fn();
    const props = { pane: '%1', agent: 'codex', kind: 'idle', codexSession: { managed: true }, onInteractiveSlash };
    const { rerender } = render(<ChatComposer {...props} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '继续实现');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendCodexMessage).toHaveBeenCalledWith('%1', '继续实现'));
    rerender(<ChatComposer {...props} />);
    typeInto(input, '/compact');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(compactCodexSession).toHaveBeenCalledWith('%1'));
    rerender(<ChatComposer {...props} />);
    typeInto(input, '/clear');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(clearCodexSession).toHaveBeenCalledWith('%1'));
    expect(sendText).not.toHaveBeenCalled();
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('clears a managed Codex draft and exposes a sending bubble before App Server replies', async () => {
    const request = deferred();
    sendCodexMessage.mockReturnValueOnce(request.promise);
    const onCodexSendStart = vi.fn(() => 'optimistic-1');
    const onCodexSendResult = vi.fn();
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{ managed: true }}
      onCodexSendStart={onCodexSendStart} onCodexSendResult={onCodexSendResult} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '马上显示这条消息');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(input.value).toBe('');
    expect(onCodexSendStart).toHaveBeenCalledWith('%1', '马上显示这条消息', 'send');
    expect(onCodexSendResult).not.toHaveBeenCalled();

    const result = { queued: true, item: { id: 'queued-1', text: '马上显示这条消息' } };
    request.resolve(result);
    await waitFor(() => expect(onCodexSendResult).toHaveBeenCalledWith('optimistic-1', { result }));
  });

  it('rejects unsupported managed Codex slash commands without writing to the terminal', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" agent="codex" kind="idle"
      codexSession={{ managed: true }} onInteractiveSlash={onInteractiveSlash} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '/plugin');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const notice = await screen.findByText('这个命令暂不支持在对话视图中使用');
    expect(notice.classList.contains('cc-notice')).toBe(true);
    expect(document.querySelector('.cc-error')).toBeNull();
    expect(input.value).toBe('/plugin');
    expect(sendText).not.toHaveBeenCalled();
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('runs native /goal actions without sending command text to the terminal or model', async () => {
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{ managed: true }} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');

    typeInto(input, '/goal Finish the release');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(updateCodexGoal).toHaveBeenCalledWith('%1', {
      objective: 'Finish the release',
    }));
    expect(await screen.findByText('任务目标已设置')).toBeTruthy();

    typeInto(input, '/goal pause');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(updateCodexGoal).toHaveBeenCalledWith('%1', { status: 'paused' }));

    typeInto(input, '/goal resume');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(updateCodexGoal).toHaveBeenCalledWith('%1', { status: 'active' }));

    typeInto(input, '/goal clear');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(clearCodexGoal).toHaveBeenCalledWith('%1'));
    expect(sendCodexMessage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('views and edits the authoritative native goal in an in-chat panel', async () => {
    getCodexGoal.mockResolvedValueOnce({ goal: {
      objective: 'Keep tests green', status: 'active', tokensUsed: 120, timeUsedSeconds: 3,
    } });
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{ managed: true }} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '/goal');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const panel = await screen.findByRole('dialog', { name: '任务目标' });
    await waitFor(() => expect(panel.textContent).toContain('Keep tests green'));
    expect(panel.textContent).toContain('进行中');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const objective = screen.getByRole('textbox', { name: '目标内容' });
    typeInto(objective, 'Ship after review');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateCodexGoal).toHaveBeenCalledWith('%1', {
      objective: 'Ship after review',
    }));
    await waitFor(() => expect(panel.textContent).toContain('Ship after review'));

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(screen.getByRole('alertdialog', { name: '清除任务目标？' })).toBeTruthy();
    fireEvent.click(screen.getByRole('alertdialog').querySelector('button.danger'));
    await waitFor(() => expect(clearCodexGoal).toHaveBeenCalledWith('%1'));
  });

  it('keeps App Server model and effort in the footer and edits them in one sheet', async () => {
    getCodexModels.mockResolvedValueOnce({ models: [
      {
        id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-new', model: 'gpt-new', displayName: 'GPT New',
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high',
      },
    ] });
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-5.6-terra', effort: 'medium' },
    }} />);
    expect(container.querySelector('.cc-ctx-model').textContent).toBe('gpt-5.6-terra');
    expect(container.querySelector('.cc-ctx-pct').textContent).toBe('medium');
    fireEvent.click(screen.getByRole('button', { name: '设置模型、Fast 和思考强度' }));
    expect(await screen.findByRole('dialog', { name: '模型设置' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'GPT New' }));
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', {
      model: 'gpt-new', effort: 'high',
    }));
    await waitFor(() => expect(container.querySelector('.cc-ctx-model').textContent).toBe('gpt-new'));
  });

  it('shows Fast only when the selected model advertises it and saves the catalog tier', async () => {
    getCodexModels.mockResolvedValueOnce({ models: [
      {
        id: 'gpt-fast', model: 'gpt-fast', displayName: 'GPT Fast',
        serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-plain', model: 'gpt-plain', displayName: 'GPT Plain', serviceTiers: [],
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
      },
    ] });
    updateCodexSettings.mockImplementation(async (_pane, updates) => ({ settings: {
      model: 'gpt-fast', effort: 'medium', serviceTier: null, ...updates,
    } }));
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{
      managed: true, settings: { model: 'gpt-fast', effort: 'medium', serviceTier: null },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、Fast 和思考强度' }));
    const fast = await screen.findByRole('checkbox', { name: /Fast/ });
    expect(document.querySelector('.codex-fast-title svg')).toBeTruthy();
    expect(document.querySelector('.codex-config-next-turn').previousElementSibling)
      .toBe(document.querySelector('.codex-fast-row'));
    expect(document.querySelector('.cc-fast-indicator')).toBeNull();
    expect(fast.checked).toBe(false);
    fireEvent.click(fast);
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', { serviceTier: 'priority' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Fast/ }).checked).toBe(true));
    expect(document.querySelector('.cc-fast-indicator svg')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'GPT Plain' }));
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', {
      model: 'gpt-plain', serviceTier: null,
    }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Fast/ })).toBeNull());
    expect(document.querySelector('.cc-fast-indicator')).toBeNull();
  });

  it('opens structured App Server session status from the context ring', async () => {
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" micAvailable codexSession={{
      managed: true,
      threadId: 'thread-123',
      gitBranch: 'main',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      approvals: [{ id: 'approval-1' }],
      settings: {
        model: 'gpt-5.6-terra', effort: 'medium', cwd: '/work/project',
        sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      },
      contextUsage: { usedTokens: 159719, totalTokens: 258400 },
    }} />);
    const trigger = screen.getByRole('button', { name: '会话状态，上下文占用 62%' });
    expect(trigger.classList.contains('medium')).toBe(true);
    expect(trigger.nextElementSibling).toBe(screen.getByRole('button', { name: '语音输入' }));

    fireEvent.click(trigger);
    const detail = screen.getByRole('dialog', { name: '会话状态' });
    expect(detail.textContent).toContain('等待审批');
    expect(detail.textContent).toContain('上下文长度用量');
    expect(detail.textContent).toContain('61.8%');
    expect(container.querySelectorAll('.cc-context-ring')).toHaveLength(2);
    expect(detail.textContent).toContain('159,719 / 258,400');
    const usageValue = detail.querySelector('.cc-context-usage-value');
    expect(usageValue.firstElementChild.classList.contains('cc-context-ring')).toBe(true);
    expect(usageValue.textContent).toBe('61.8%');
    const directoryCopy = screen.getByRole('button', { name: '复制目录' });
    const directory = directoryCopy.querySelector('.cc-context-copy-value');
    expect(directory.textContent).toBe('/work/project');
    expect(directory.closest('button')).toBe(directoryCopy);
    expect(fireEvent(directory, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))).toBe(true);
    expect(detail.textContent).toContain('main');
    expect(detail.textContent).toContain('可修改工作区');
    expect(detail.textContent).toContain('默认');
    fireEvent.click(directoryCopy);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/work/project'));
    const sessionCopy = screen.getByRole('button', { name: '复制会话 ID' });
    expect(sessionCopy.classList.contains('cc-context-copy-row')).toBe(true);
    fireEvent.click(sessionCopy);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('thread-123'));
    expect(sessionCopy.getAttribute('aria-label')).toContain('已复制');

    const input = screen.getByPlaceholderText('和 Agent 对话…');
    const backdrop = container.querySelector('.cc-context-backdrop');
    fireEvent.pointerDown(backdrop, { clientX: 2, clientY: 2 });
    fireEvent.pointerUp(backdrop, { clientX: 2, clientY: 2 });
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: '会话状态' })).toBeNull();
    expect(document.activeElement).not.toBe(input);
  });

  it('changes the TUI-compatible permission mode inline without closing session status', async () => {
    const settings = {
      model: 'gpt-test', effort: 'medium', cwd: '/work/project',
      sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
    };
    updateCodexSettings.mockResolvedValueOnce({
      settings: { ...settings, approvalsReviewer: 'auto_review' },
    });
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{
      managed: true,
      settings,
      contextUsage: { usedTokens: 120_000, totalTokens: 258_400 },
    }} />);

    fireEvent.click(screen.getByRole('button', { name: '会话状态，上下文占用 46%' }));
    fireEvent.click(screen.getByRole('button', { name: '设置权限模式，当前为默认' }));
    const status = screen.getByRole('dialog', { name: '会话状态' });
    const choices = screen.getByRole('radiogroup', { name: '权限模式' });
    expect(status.contains(choices)).toBe(true);
    expect(choices.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('默认');
    expect(choices.textContent).toContain('联网或访问其他位置时会询问你');
    expect(choices.textContent).toContain('Codex 自动判断批准或拒绝');
    expect(choices.textContent).toContain('仅在完全信任当前任务时使用');
    expect(choices.textContent).toContain('修改从下一条消息生效');

    fireEvent.click(screen.getByRole('radio', { name: /自动审批/ }));
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', {
      permissionMode: 'auto-review',
    }));
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: '权限模式' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '会话状态' })).toBe(status);
    expect(screen.getByRole('status').textContent).toContain('权限模式已更新，下条消息生效');
    expect(screen.getByRole('button', { name: '设置权限模式，当前为自动审批' })).toBeTruthy();
  });

  it('labels non-preset App Server permission settings without rendering the raw object', () => {
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true,
      settings: {
        model: 'gpt-test', effort: 'medium',
        approvalPolicy: { granular: { rules: true, sandbox_approval: true, mcp_elicitations: false } },
      },
      contextUsage: { usedTokens: 10_000, totalTokens: 100_000 },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '会话状态，上下文占用 10%' }));
    expect(screen.getByRole('button', { name: '设置权限模式，当前为自定义' })).toBeTruthy();
  });

  it.each([
    [103_359, 'low'],
    [103_360, 'medium'],
    [193_799, 'medium'],
    [193_800, 'high'],
  ])('uses the expected context ring level for %s tokens', (usedTokens, level) => {
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
      contextUsage: { usedTokens, totalTokens: 258400 },
    }} />);
    expect(container.querySelector('.cc-context-trigger').classList.contains(level)).toBe(true);
  });

  it('does not invent a context ring when App Server usage is incomplete', () => {
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
      contextUsage: { usedTokens: 159719, totalTokens: null },
    }} />);
    expect(container.querySelector('.cc-context-trigger')).toBeNull();
  });

  it('keeps reasoning effort pinned in the menu footer and configurable for the next turn while working', async () => {
    getCodexModels.mockResolvedValueOnce({ models: [{
      id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      ],
      defaultReasoningEffort: 'medium',
    }] });
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
    }} />);
    const trigger = screen.getByRole('button', { name: '设置模型、Fast 和思考强度' });
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);

    expect(await screen.findByText('当前回复不变，下条消息生效')).toBeTruthy();
    const body = container.querySelector('.codex-config-body');
    const footer = container.querySelector('.codex-config-footer');
    expect(footer).toBeTruthy();
    expect(body.contains(footer)).toBe(false);
    const effort = await screen.findByRole('slider', { name: '思考强度' });
    expect(effort.getAttribute('aria-valuetext')).toBe('medium');
    effort.getBoundingClientRect = () => ({ left: 0, width: 300 });
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 150 });
    expect(fireEvent(effort, pointerDown)).toBe(false); // custom slider must not steal textarea focus on iOS
    fireEvent(effort, new MouseEvent('pointermove', { bubbles: true, clientX: 275 }));
    expect(effort.getAttribute('aria-valuetext')).toBe('high');
    expect(updateCodexSettings).not.toHaveBeenCalled();
    fireEvent(effort, new MouseEvent('pointerup', { bubbles: true, clientX: 275 }));
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', { effort: 'high' }));
  });

  it('supports keyboard changes on the reasoning-effort step slider', async () => {
    getCodexModels.mockResolvedValueOnce({ models: [{
      id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      ],
      defaultReasoningEffort: 'medium',
    }] });
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、Fast 和思考强度' }));
    const effort = await screen.findByRole('slider', { name: '思考强度' });
    fireEvent.keyDown(effort, { key: 'ArrowRight' });
    expect(effort.getAttribute('aria-valuetext')).toBe('high');
    fireEvent.keyUp(effort, { key: 'ArrowRight' });
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', { effort: 'high' }));
  });

  it('loads models once per app run and refreshes only from the menu action', async () => {
    getCodexModels.mockResolvedValue({ models: [{
      id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
    }] });
    const props = { pane: '%1', agent: 'codex', kind: 'idle', codexSession: {
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
    } };
    const { container } = render(<ChatComposer {...props} />);
    await waitFor(() => expect(getCodexModels).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '设置模型、Fast 和思考强度' }));
    expect(await screen.findByRole('dialog', { name: '模型设置' })).toBeTruthy();
    expect(getCodexModels).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.codex-config-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: '设置模型、Fast 和思考强度' }));
    await screen.findByRole('dialog', { name: '模型设置' });
    expect(getCodexModels).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }));
    await waitFor(() => expect(getCodexModels).toHaveBeenCalledTimes(2));
  });

  it('opening the model menu preserves whether the composer was focused', async () => {
    getCodexModels.mockResolvedValue({ models: [] });
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" desktop codexSession={{
      managed: true, settings: { model: 'gpt-test', effort: 'medium' },
    }} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    const trigger = screen.getByRole('button', { name: '设置模型、Fast 和思考强度' });
    expect(document.activeElement).toBe(input);

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: '模型设置' });
    expect(document.activeElement).toBe(input);

    fireEvent.click(container.querySelector('.codex-config-backdrop'));
    input.blur();
    expect(document.activeElement).not.toBe(input);
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: '模型设置' });
    expect(document.activeElement).not.toBe(input);

    const backdrop = container.querySelector('.codex-config-backdrop');
    fireEvent.pointerDown(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.click(backdrop);
    expect(document.activeElement).not.toBe(input);
  });

  it('handles managed /model and /effort in chat without terminal handoff', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-5.6-terra', effort: 'medium' },
    }} onInteractiveSlash={onInteractiveSlash} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '/model');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('dialog', { name: '模型设置' })).toBeTruthy();
    expect(sendText).not.toHaveBeenCalled();
    expect(onInteractiveSlash).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.codex-config-backdrop'));

    typeInto(input, '/effort high');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(updateCodexSettings).toHaveBeenCalledWith('%1', { effort: 'high' }));
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('sends one structured interrupt and disables repeated stop taps', async () => {
    const request = deferred();
    interruptCodexSession.mockReturnValueOnce(request.promise);
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{ managed: true }} />);
    const stop = screen.getByRole('button', { name: '停止' });
    fireEvent.click(stop);
    let dialog = screen.getByRole('alertdialog', { name: '停止当前任务？' });
    expect(dialog.textContent).toContain('当前正在执行的回合会被中断。');
    expect(dialog.classList.contains('cc-confirm-dialog')).toBe(true);
    expect(styles).toMatch(/\.settings-confirm-actions button\s*\{[^}]*outline:\s*none[^}]*appearance:\s*none[^}]*box-shadow:\s*none/);
    expect(interruptCodexSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(interruptCodexSession).not.toHaveBeenCalled();

    fireEvent.click(stop);
    dialog = screen.getByRole('alertdialog', { name: '停止当前任务？' });
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === '停止'));
    expect(interruptCodexSession).toHaveBeenCalledTimes(1);
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    expect(interruptCodexSession).toHaveBeenCalledTimes(1);
    request.resolve({ interrupted: true });
  });

  it('shows queued messages with compact icon actions, confirmation and in-place editing', async () => {
    const onCodexSendStart = vi.fn(() => 'optimistic-steer');
    const onCodexSendResult = vi.fn();
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="working" keyboardInset={280} codexSession={{
      managed: true,
      queue: [
        { id: 'queued-1', text: '先检查测试' },
        { id: 'queued-2', text: '再整理结果' },
      ],
    }} onCodexSendStart={onCodexSendStart} onCodexSendResult={onCodexSendResult} />);
    expect(container.querySelector('.cc-card .cc-queue')).toBeTruthy();
    expect(screen.getByText('排队消息')).toBeTruthy();
    expect(screen.getByText('当前回合结束后自动逐条发送')).toBeTruthy();
    expect(container.querySelector('.cc-queue-count')?.textContent).toBe('2');
    expect([...container.querySelectorAll('.cc-queue-index')].map((node) => node.textContent)).toEqual(['1', '2']);
    expect(screen.getByText('先检查测试')).toBeTruthy();
    expect(screen.getByText('再整理结果')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    expect(container.querySelector('.cc-queue-head')?.parentElement)
      .toBe(container.querySelector('.cc-queue'));
    expect(container.querySelector('.cc-queue-list')?.parentElement)
      .toBe(container.querySelector('.cc-queue'));
    expect(container.querySelector('.cc-queue-list')?.contains(container.querySelector('.cc-queue-head')))
      .toBe(false);
    expect([...container.querySelectorAll('.cc-queue-item')[0].querySelectorAll('button')]
      .map((button) => button.className)).toEqual([
      'cc-queue-action cc-queue-send',
      'cc-queue-action cc-queue-delete',
    ]);
    expect(container.querySelectorAll('.cc-queue-actions')).toHaveLength(2);

    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '排到最后');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendCodexMessage).toHaveBeenCalledWith('%1', '排到最后'));

    fireEvent.click(screen.getAllByRole('button', { name: '立刻引导' })[0]);
    expect(beginCodexQueuedEdit).not.toHaveBeenCalled();
    expect(onCodexSendStart).toHaveBeenCalledWith('%1', '先检查测试', 'steer');
    await waitFor(() => expect(steerCodexQueuedMessage).toHaveBeenCalledWith('%1', 'queued-1'));
    await waitFor(() => expect(onCodexSendResult).toHaveBeenCalledWith('optimistic-steer', {
      result: { steered: true },
    }));

    fireEvent.click(screen.getByText('再整理结果').closest('.cc-queue-item'));
    await waitFor(() => expect(beginCodexQueuedEdit).toHaveBeenCalledWith('%1', 'queued-2'));
    const editor = await screen.findByRole('dialog', { name: '编辑排队消息' });
    expect(editor.parentElement?.parentElement).toBe(document.body);
    expect(editor.parentElement?.style.bottom).toBe('280px');
    const draft = editor.querySelector('textarea');
    expect(draft.value).toBe('再整理结果');
    expect(draft.selectionStart).toBe(draft.value.length);
    expect(draft.selectionEnd).toBe(draft.value.length);
    typeInto(draft, '重新整理结果');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(commitCodexQueuedEdit)
      .toHaveBeenCalledWith('%1', 'queued-2', 'edit-token', '重新整理结果'));
    expect(cancelCodexQueuedEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除排队消息' }));
    const deleteDialog = screen.getByRole('alertdialog', { name: '删除这条排队消息？' });
    expect(deleteDialog.classList.contains('cc-confirm-dialog')).toBe(true);
    expect(removeCodexQueuedMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(removeCodexQueuedMessage).toHaveBeenCalledWith('%1', 'queued-2'));
  });

  it('opens queued-message editing from the row without focusing the composer and clamps text to two lines', async () => {
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{
      managed: true,
      queue: [{ id: 'queued-1', text: '一段足够长的排队消息，用来验证它不会把整个输入区域一直撑高' }],
    }} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    const queuedText = container.querySelector('.cc-queue-text');
    fireEvent.pointerDown(queuedText, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(queuedText, { clientX: 50, clientY: 50 });
    fireEvent.click(queuedText);
    await waitFor(() => expect(beginCodexQueuedEdit).toHaveBeenCalledWith('%1', 'queued-1'));
    expect(document.activeElement).not.toBe(input);
    expect(styles).toMatch(/\.cc-queue-text\s*\{[^}]*-webkit-line-clamp:\s*2/);
    expect(styles).toMatch(/\.cc-queue-actions\s*\{[^}]*gap:\s*0/);
    expect(styles).toMatch(/\.cc-queue-action\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/);
    expect(styles).toMatch(/\.cc-queue-list\s*\{[^}]*max-height:\s*min\(216px,\s*32dvh\)[^}]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.cc-queue-index\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*border-radius:\s*50%/);
  });

  it('releases the server edit hold when queued-message editing is cancelled', async () => {
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{
      managed: true, queue: [{ id: 'queued-1', text: '保留原文' }],
    }} />);
    fireEvent.keyDown(screen.getByText('保留原文'), { key: 'Enter' });
    await waitFor(() => expect(beginCodexQueuedEdit).toHaveBeenCalledWith('%1', 'queued-1'));
    await screen.findByRole('dialog', { name: '编辑排队消息' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(cancelCodexQueuedEdit)
      .toHaveBeenCalledWith('%1', 'queued-1', 'edit-token'));
    expect(commitCodexQueuedEdit).not.toHaveBeenCalled();
  });

  it('a saved chip that is a bare interactive command also hands off to the terminal lens', async () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([{ kind: 'cmd', text: '/plugin' }]));
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    fireEvent.click(screen.getByRole('button', { name: '/plugin' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/plugin', true));
    expect(onInteractiveSlash).toHaveBeenCalledTimes(1);
  });

  it('hides terminal-key shortcuts from managed Codex chat', () => {
    render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{ managed: true }} />);
    expect(screen.queryByRole('button', { name: 'Ctrl+C' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esc' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ok' })).toBeTruthy();
  });

  // The tap-to-focus target-exclusion is unit-tested here; the MOVEMENT guard (swipe/scroll must not focus)
  // rides on pointer coords, which jsdom delivers as null for pointer events — it's a device gesture, gated
  // on a real-device pass (see CLAUDE.md: touch surfaces are untestable headless).
  it('a stationary tap on the action row blank space focuses the textarea', () => {
    const { container } = render(<ChatComposer pane="%1" kind="idle" />);
    const ta = screen.getByPlaceholderText('和 Agent 对话…');
    const actions = container.querySelector('.cc-actions');
    expect(document.activeElement).not.toBe(ta);
    fireEvent.pointerDown(actions, { clientX: 50, clientY: 100 });
    fireEvent.pointerUp(actions, { clientX: 50, clientY: 100 });
    expect(document.activeElement).toBe(ta);
  });

  it('tapping a control in the row does not trigger tap-to-focus (only blank space does)', () => {
    const { container } = render(<ChatComposer pane="%1" kind="idle" />);
    const ta = screen.getByPlaceholderText('和 Agent 对话…');
    const attach = container.querySelector('.cc-attach'); // the ＋ button
    fireEvent.pointerDown(attach, { clientX: 20, clientY: 100 });
    fireEvent.pointerUp(attach, { clientX: 20, clientY: 100 });
    expect(document.activeElement).not.toBe(ta); // excluded — the button's own handler owns the tap
  });

  it('shows a context chip (model · %) when the pane reports a context %, and none when it does not', async () => {
    getPaneContext.mockResolvedValueOnce({ model: 'Opus 4.8 (1M context)', usedPercent: 24 });
    const { container, rerender } = render(<ChatComposer pane="%1" kind="idle" />);
    await waitFor(() => expect(container.querySelector('.cc-ctx')).toBeTruthy());
    expect(container.querySelector('.cc-ctx-model').textContent).toBe('Opus 4.8'); // "(1M context)" stripped
    expect(container.querySelector('.cc-ctx-pct').textContent).toBe('24%');

    cleanup();
    const { container: c2 } = render(<ChatComposer pane="%2" kind="idle" />);
    expect(c2.querySelector('.cc-ctx')).toBeNull();
  });

  it('does not request Claude context metadata for a Codex composer', async () => {
    render(<ChatComposer pane="%1" agent="codex" kind="idle" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getPaneContext).not.toHaveBeenCalled();
  });

  it('while the agent is working the send button becomes a Stop that sends Escape', () => {
    const onKey = vi.fn();
    render(<ChatComposer pane="%1" kind="working" onKey={onKey} />);
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onKey).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: '停止当前任务？' });
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === '停止'));
    expect(onKey).toHaveBeenCalledWith('Escape');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('desktop focuses the existing textarea and Enter sends while Shift+Enter and IME Enter stay local', async () => {
    render(<ChatComposer pane="%1" kind="idle" desktop />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    expect(document.activeElement).toBe(input);

    typeInto(input, '继续');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '继续', true));
    await waitFor(() => expect(input.value).toBe(''));

    typeInto(input, '第一行');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('desktop working Enter never stops, while Escape keeps the explicit interrupt shortcut', () => {
    const onKey = vi.fn();
    render(<ChatComposer pane="%1" kind="working" desktop onKey={onKey} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '下一条');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKey).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onKey).toHaveBeenCalledWith('Escape');
  });

  it('a quick-reply chip sends its text on tap', async () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([{ text: '继续' }]));
    render(<ChatComposer pane="%1" kind="idle" />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await Promise.resolve();
    expect(sendText).toHaveBeenCalledWith('%1', '继续', true);
  });

  it('shows an optimistic message for a managed Codex quick reply', async () => {
    const request = deferred();
    sendCodexMessage.mockReturnValueOnce(request.promise);
    const onCodexSendStart = vi.fn(() => 'optimistic-quick-reply');
    const onCodexSendResult = vi.fn();
    localStorage.setItem('hm_favs6_agent', JSON.stringify([{ text: '继续' }]));
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{ managed: true }}
      onCodexSendStart={onCodexSendStart} onCodexSendResult={onCodexSendResult} />);

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(onCodexSendStart).toHaveBeenCalledWith('%1', '继续', 'send');
    expect(onCodexSendResult).not.toHaveBeenCalled();

    const result = { turn: { id: 'turn-quick-reply' } };
    request.resolve(result);
    await waitFor(() => expect(onCodexSendResult)
      .toHaveBeenCalledWith('optimistic-quick-reply', { result }));
  });

  it('renders required chat presets and honors key / text Enter behavior', async () => {
    const onKey = vi.fn();
    const shortcuts = {
      command: [],
      chat: [
        { type: 'key', key: 'Escape', label: 'Esc' },
        { type: 'text', text: 'draft only', enter: false },
        { type: 'text', text: 'send now', enter: true },
      ],
    };
    render(<ChatComposer pane="%1" kind="idle" onKey={onKey} shortcuts={shortcuts} />);
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(onKey).toHaveBeenCalledWith('Escape');
    fireEvent.click(screen.getByRole('button', { name: 'draft only' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', 'draft only', false));
    fireEvent.click(screen.getByRole('button', { name: 'send now' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', 'send now', true));
  });

  it('passes required presets into the unified editor list', () => {
    const shortcuts = { command: [], chat: [{ type: 'text', text: 'required', enter: true }] };
    const { container } = render(<ChatComposer pane="%1" kind="idle" shortcuts={shortcuts} />);
    fireEvent.click(screen.getByRole('button', { name: '常用消息' }));
    expect(container.querySelector('.cmd-esection').textContent).toContain('required');
    expect(container.querySelector('.cmd-config-section')).toBeNull();
    expect(container.querySelector('.cmd-row .cmd-del').getAttribute('aria-label')).toBe('从本机移除');
  });

  it('shows explicit phone-local key/reply/cmd items in the chip strip', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([
      { kind: 'key', text: 'Escape', label: 'ESC' },
      { kind: 'reply', text: '好的' },
      { kind: 'cmd', text: '/compact' },
    ]));
    render(<ChatComposer pane="%1" kind="idle" shortcuts={{ command: [], chat: [] }} />);
    expect(screen.getByRole('button', { name: 'ESC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '好的' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '/compact' })).toBeTruthy();
  });
});
