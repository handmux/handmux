import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentConversationView from '../src/components/AgentConversationView.js';
import { formatMessageTime } from '../src/components/ConversationEntry.js';
import { projectConversationMessages } from '../src/conversationPresentation.js';
import type { AgentConversationController } from '../src/hooks/useAgentConversation.js';

afterEach(cleanup);

const sourceCreatedAt = new Date(2026, 7, 29, 9, 7).getTime();

function transcript(): AgentConversationController['items'] {
  return [
    {
      key: 'user-1', provisional: false,
      item: {
        id: 'user-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'message', role: 'user', content: [{ type: 'text', text: '检查项目' }],
      },
    },
    {
      key: 'assistant-1', provisional: false,
      item: {
        id: 'assistant-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'message', role: 'assistant', content: [{
          type: 'text', text: '| 文件 | 状态 |\n| --- | --- |\n| README.md | 正常 |',
        }],
      },
    },
    {
      key: 'tool-call-1', provisional: false,
      item: {
        id: 'tool-call-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'tool_call', callId: 'call-1', name: 'exec_command',
        summary: '检查仓库', input: { cmd: 'git status --short' },
      },
    },
    {
      key: 'tool-result-1', provisional: false,
      item: {
        id: 'tool-result-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'tool_result', callId: 'call-1',
        content: [{ type: 'text', text: 'tool output only inside detail' }],
      },
    },
    {
      key: 'compaction-1', provisional: false,
      item: {
        id: 'compaction-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'compaction', summary: 'private retained summary',
      },
    },
    {
      key: 'error-1', provisional: false,
      item: {
        id: 'error-1', sessionId: 'session-1', status: 'complete', sourceCreatedAt,
        kind: 'notice', level: 'error', code: 'provider_error', message: '请求失败，请重试',
      },
    },
    {
      key: 'assistant-live', provisional: true,
      item: {
        kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }],
      },
    },
  ] as AgentConversationController['items'];
}

function controller(agentId: string): AgentConversationController {
  return {
    status: 'ready', error: null,
    descriptor: {
      session: { agentId, sessionId: 'session-1' },
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    },
    items: transcript(), hasMore: false, loadingOlder: false, sending: false, interrupting: false,
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
    loadOlder: vi.fn(async () => {}), downloadResource: vi.fn(async () => {}),
  };
}

function timelineSignature(agentId: string): string {
  const view = render(<AgentConversationView conversation={controller(agentId)} />);
  const html = view.container.querySelector('.chat-scroll')?.innerHTML ?? '';
  view.unmount();
  return html;
}

describe('shared Conversation Timeline contract', () => {
  it('keeps provider turn grouping separate from submission correlation', () => {
    const items: AgentConversationController['items'] = [
      {
        key: 'user-correlated', provisional: false,
        item: {
          id: 'user-correlated', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'user', groupingId: 'turn-1', correlationId: 'request-1',
          content: [{ type: 'text', text: '开始任务' }],
        },
      },
      {
        key: 'assistant-grouped', provisional: false,
        item: {
          id: 'assistant-grouped', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'assistant', groupingId: 'turn-1',
          content: [{ type: 'text', text: '正在处理' }],
        },
      },
      {
        key: 'tool-grouped', provisional: false,
        item: {
          id: 'tool-grouped', sessionId: 'session-1', status: 'complete',
          kind: 'tool_call', callId: 'call-grouped', name: 'exec_command',
          groupingId: 'turn-1', input: { cmd: 'git status --short' },
        },
      },
      {
        key: 'legacy-correlated', provisional: false,
        item: {
          id: 'legacy-correlated', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'user', correlationId: 'legacy-turn',
          content: [{ type: 'text', text: '兼容旧适配器' }],
        },
      },
    ];

    const projected = projectConversationMessages(items);
    expect(projected.slice(0, 3).map((message) => message.turnId))
      .toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(projected[3]?.turnId).toBe('legacy-turn');
  });

  it('is provider-neutral for the same normalized transcript', () => {
    expect(timelineSignature('pi')).toBe(timelineSignature('codex'));
    expect(timelineSignature('third-party-agent')).toBe(timelineSignature('codex'));
  });

  it('coalesces one callId into one collapsed ToolChip and keeps its result out of the top level', () => {
    const { container } = render(<AgentConversationView conversation={controller('pi')} />);

    expect(container.querySelectorAll('.chat-tool')).toHaveLength(1);
    expect(container.querySelector('.agent-conversation-tool-result')).toBeNull();
    expect(container.querySelector('.chat-scroll')?.textContent)
      .not.toContain('tool output only inside detail');

    fireEvent.click(container.querySelector('.chat-tool-head')!);
    expect(screen.getByRole('dialog').textContent).toContain('tool output only inside detail');
  });

  it('renders a normalized Pi command through the shared command presentation', () => {
    const conversation = controller('pi');
    conversation.items = [transcript().find((item) => item.key === 'tool-call-1')!];
    const { container } = render(<AgentConversationView conversation={conversation} />);

    expect(container.querySelector('.chat-tool-head')?.textContent).toContain('git status --short');
    expect(container.querySelector('.chat-tool-head')?.textContent).not.toContain('{"cmd"');
    fireEvent.click(container.querySelector('.chat-tool-head')!);
    expect(screen.getByRole('dialog').querySelector('.tool-sheet-cmd')?.textContent)
      .toBe('git status --short');
  });

  it('uses the shared TypingIndicator for a generic provisional assistant item', () => {
    const { container } = render(<AgentConversationView conversation={controller('pi')} />);

    expect(container.querySelectorAll('.chat-typing')).toHaveLength(1);
    expect(container.querySelector('.chat-typing-dots')).toBeTruthy();
    expect(container.querySelector('.agent-conversation-pending')).toBeNull();
    expect(container.textContent).not.toContain('•••');
  });

  it('uses the shared timestamp formatter for durable items and never invents provisional time', () => {
    const { container } = render(<AgentConversationView conversation={controller('pi')} />);
    const durable = container.querySelector('[data-completed-entry-key="user-1"] .chat-ts');
    const provisional = container.querySelector('[data-completed-entry-key="assistant-live"] .chat-ts');

    expect(durable).toBeTruthy();
    expect(durable?.textContent)
      .toBe(formatMessageTime(new Date(sourceCreatedAt).toISOString()));
    expect(provisional).toBeNull();
  });

  it('keeps an orphan result hidden until its cross-page tool call is present', () => {
    const result = transcript().find((value) => value.key === 'tool-result-1')!;
    const call = transcript().find((value) => value.key === 'tool-call-1')!;

    expect(projectConversationMessages([result])).toEqual([]);
    const reunited = projectConversationMessages([result, call]);
    const tools = reunited.filter((message) => message.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool?.result).toBe('tool output only inside detail');
  });

  it('lets the canonical normalized result complete a native tool shell', () => {
    const call = transcript().find((value) => value.key === 'tool-call-1')!;
    const result = transcript().find((value) => value.key === 'tool-result-1')!;
    call.item.extensions = { 'conversation.tool': {
      name: 'exec_command', input: { cmd: 'git status --short' }, result: null,
      isError: false, outcome: 'running',
    } };
    result.item = {
      id: 'tool-result-1', sessionId: 'session-1',
      kind: 'tool_result', callId: 'call-1',
      content: [{ type: 'text', text: 'tool output only inside detail' }],
      status: 'error', isError: true,
      error: { code: 'tool_failed', message: '命令执行失败' },
    };

    const [tool] = projectConversationMessages([call, result]);
    expect(tool?.tool).toMatchObject({
      result: 'tool output only inside detail', isError: true, outcome: 'failed',
    });
    const { container } = render(<AgentConversationView conversation={{
      ...controller('pi'), items: [call, result],
    }} />);
    expect(container.querySelector('.chat-tool-err')).toBeTruthy();
    expect(container.querySelector('.chat-turn-error')?.textContent).toBe('命令执行失败');
  });

  it('preserves durable message error and truncation status in the shared renderer', () => {
    const conversation = controller('pi');
    conversation.items = [
      {
        key: 'partial-error', provisional: false,
        item: {
          id: 'partial-error', sessionId: 'session-1', status: 'error',
          kind: 'message', role: 'assistant', content: [{ type: 'text', text: '部分回复' }],
          error: { code: 'provider_failed', message: '回复中断，请重试' },
        },
      },
      {
        key: 'partial-truncated', provisional: false,
        item: {
          id: 'partial-truncated', sessionId: 'session-1', status: 'truncated',
          kind: 'message', role: 'assistant', content: [{ type: 'text', text: '截断回复' }],
          truncation: { reason: 'provider_truncated' },
        },
      },
    ];
    const { container } = render(<AgentConversationView conversation={conversation} />);
    expect(container.textContent).toContain('部分回复');
    expect(container.querySelector('.chat-turn-error')?.textContent).toBe('回复中断，请重试');
    expect(container.textContent).toContain('内容已截断');
  });

  it('shows working for a provisional orphan and a friendly empty state after it settles', () => {
    const orphan = transcript().find((value) => value.key === 'tool-result-1')!;
    const provisional = { ...orphan, key: 'orphan-live', provisional: true };
    const { container, rerender } = render(<AgentConversationView conversation={{
      ...controller('pi'), items: [provisional],
    }} />);
    expect(container.querySelector('.chat-typing')).toBeTruthy();
    expect(container.querySelector('.agent-conversation-state')).toBeNull();

    rerender(<AgentConversationView conversation={{
      ...controller('pi'), items: [{ ...orphan, key: 'orphan-settled' }],
    }} />);
    expect(container.querySelector('.chat-new')).toBeTruthy();
  });

  it('deduplicates native Codex diffs by matching operation, not by swallowing a whole turn', () => {
    const nativeTool = (key: string, callId: string, path: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'tool_call' as const, callId, name: 'apply_patch', correlationId: 'turn-diff',
        extensions: { 'conversation.tool': {
          name: 'apply_patch', input: { file_path: path }, result: 'Done!', isError: false,
          outcome: 'success', diff: {
            added: 1, removed: 1,
            hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }],
          },
        } },
      },
    });
    const normalizedDiff = (key: string, path: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'diff' as const, correlationId: 'turn-diff', path, patch: '-old\n+new',
      },
    });
    const items: AgentConversationController['items'] = [
      nativeTool('native-a', 'call-a', '/work/a.ts'),
      normalizedDiff('normalized-a', '/work/a.ts'),
      nativeTool('native-b', 'call-b', '/work/b.ts'),
      normalizedDiff('normalized-b', '/work/b.ts'),
      // Same turn, but no native tool owns c.ts: this independent diff must remain visible.
      normalizedDiff('normalized-c', '/work/c.ts'),
    ];

    const projected = projectConversationMessages(items);
    const tools = projected.filter((message) => message.type === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools.filter((message) => message.tool?.diff)).toHaveLength(2);
    expect(tools.map((message) => Array.isArray(message.tool?.input)
      ? null : message.tool?.input.file_path)).toEqual([
      '/work/a.ts', '/work/b.ts', '/work/c.ts',
    ]);
  });

  it('renders the same normalized rows for Codex, Pi, and third-party adapters', () => {
    expect(timelineSignature('codex')).toBe(timelineSignature('pi'));
    expect(timelineSignature('third-party-agent')).toBe(timelineSignature('pi'));
  });

  it('uses quiet error styling only for error notices, never for info or warning', () => {
    const conversation = controller('pi');
    conversation.items = ['info', 'warning', 'error'].map((level) => ({
      key: `notice-${level}`, provisional: false,
      item: {
        id: `notice-${level}`, sessionId: 'session-1', status: 'complete' as const,
        kind: 'notice' as const, level: level as 'info' | 'warning' | 'error',
        message: `${level} notice`,
      },
    }));
    const { container } = render(<AgentConversationView conversation={conversation} />);

    expect(container.querySelector('[data-completed-entry-key="notice-info"] .chat-turn-error'))
      .toBeNull();
    expect(container.querySelector('[data-completed-entry-key="notice-warning"] .chat-turn-error'))
      .toBeNull();
    expect(container.querySelector('[data-completed-entry-key="notice-error"] .chat-turn-error'))
      .toBeTruthy();
  });

  it('retains shared Markdown, compaction disclosure, and quiet error presentation', () => {
    const { container } = render(<AgentConversationView conversation={controller('pi')} />);

    expect(container.querySelector('.chat-md table')).toBeTruthy();
    expect(container.textContent).not.toContain('private retained summary');
    fireEvent.click(screen.getByRole('button', { name: /上下文已压缩.*查看详情/ }));
    expect(screen.getByRole('dialog', { name: '上下文压缩' }).textContent)
      .toContain('private retained summary');
    const error = container.querySelector('.chat-turn-error[role="status"]');
    expect(error).toBeTruthy();
    expect(error?.textContent).toContain('请求失败，请重试');
    expect(container.querySelector('.agent-conversation-notice.is-error')).toBeNull();
  });
});
