import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import ChatView from '../src/components/ChatView.jsx';
import * as api from '../src/api.js';

// This repo doesn't run vitest with `globals: true`, so testing-library's auto-cleanup (which hooks into
// a global afterEach) never registers — without this, DOM from one test leaks into the next.
afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  // Managed-Codex component cases are about rendering/gates unless a test explicitly drives the stream.
  // Keep the long-lived fetch open until unmount so it cannot retry against jsdom's missing network.
  vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, { signal }) => (
    new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  ));
});

function mockTranscript(messages) {
  vi.spyOn(api, 'fetchTranscript').mockResolvedValue({ messages, hash: 'h', session: 's', hasMore: false, firstSeq: messages[0]?.k ?? 0 });
}

// Force the scroll container's geometry (jsdom reports 0 for all of these by default) so the near-bottom
// check and the jump-button/click-to-bottom logic have something real to compute against.
function setGeometry(el, { scrollTop, scrollHeight, clientHeight }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

describe('ChatView', () => {
  it('uses the shared loading view; a loaded-but-empty session shows the friendly first-message nudge', async () => {
    mockTranscript([]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    expect(container.querySelector('.lens-boot')).toBeTruthy();
    expect(container.textContent).toContain('正在加载');
    // First response landed with zero messages → genuinely empty session → static nudge.
    await waitFor(() => expect(container.textContent).toContain('发送你的第一条消息'));
    expect(container.querySelector('.lens-boot')).toBeNull();
    expect(container.textContent).not.toContain('还没有对话内容');
  });

  it.each(['claude', 'codex'])('keeps %s message loading quiet until the first transcript arrives', async (agent) => {
    let resolveTranscript;
    vi.spyOn(api, 'fetchTranscript').mockReturnValue(new Promise((resolve) => { resolveTranscript = resolve; }));
    const { container } = render(<ChatView pane="%0" agent={agent} kind="working" />);

    expect(container.querySelector('.chat-typing')).toBeNull();
    expect(container.querySelector('.chat-typing-dots')).toBeNull();
    expect(container.querySelector('.lens-boot')).toBeTruthy();
    expect(container.querySelector('.lens-boot-hint')?.textContent).toBe('正在加载');

    await act(async () => {
      resolveTranscript({
        messages: [{ k: 0, i: 0, role: 'user', type: 'text', text: '继续' }],
        hash: 'h', session: 's', hasMore: false, firstSeq: 0,
      });
    });
    await waitFor(() => expect(container.querySelector('.chat-typing')).toBeTruthy());
    expect(container.querySelector('.lens-boot')).toBeNull();
  });

  it('buffers a streamed reply until tab history loads, then reveals both together', async () => {
    let resolveTranscript;
    vi.spyOn(api, 'fetchTranscript').mockReturnValue(new Promise((resolve) => {
      resolveTranscript = resolve;
    }));
    let emit;
    api.streamCodexMessages.mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    const { container } = render(<ChatView pane="%1" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1' }} />);

    expect(container.querySelector('.lens-boot')).toBeTruthy();
    await waitFor(() => expect(emit).toBeTypeOf('function'));
    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '实时回复已到达',
    }));

    expect(screen.queryByText('实时回复已到达')).toBeNull();
    expect(container.querySelector('.lens-boot')).toBeTruthy();
    await act(async () => resolveTranscript({
      messages: [{ k: 0, i: 0, role: 'user', type: 'text', text: '历史消息先显示' }],
      hash: 'h', session: 's', hasMore: false, firstSeq: 0,
    }));

    expect(await screen.findByText('历史消息先显示')).toBeTruthy();
    expect(await screen.findByText('实时回复已到达')).toBeTruthy();
    expect(container.querySelector('.lens-boot')).toBeNull();
  });

  it('blocks an unbound Codex chat instead of presenting guessed content', async () => {
    vi.spyOn(api, 'fetchTranscript').mockResolvedValue({
      messages: [], hash: '', session: null, hasMore: false, firstSeq: null, unavailable: 'session-unbound',
    });
    const { container } = render(<ChatView pane="%0" agent="codex" kind="done" />);

    await screen.findByText('无法确认这个 Codex 对话');
    expect(container.textContent).toContain('仍在启动');
    expect(container.textContent).not.toContain('发送你的第一条消息');
    expect(container.querySelector('.chat-gate-backdrop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '返回终端' })).toBeNull();
  });

  it('handles a managed Codex command approval in the chat view', async () => {
    mockTranscript([]);
    vi.spyOn(api, 'answerCodexApproval').mockResolvedValue({ ok: true });
    const { container } = render(<ChatView pane="%7" agent="codex" kind="permission" codexSession={{
      managed: true,
      approvals: [{ id: '91', type: 'command', command: 'npm test', cwd: '/work', decisions: ['accept', 'cancel'] }],
    }} />);
    await screen.findByText('npm test');
    expect(screen.getByText('/work')).toBeTruthy();
    expect(container.querySelector('.codex-approval-gate .chat-gate-decisions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await waitFor(() => expect(api.answerCodexApproval).toHaveBeenCalledWith('%7', '91', 'accept'));
    expect(screen.queryByRole('button', { name: '本次会话始终允许' })).toBeNull();
  });

  it('shows and returns App Server structured remember-command decisions', async () => {
    mockTranscript([]);
    vi.spyOn(api, 'answerCodexApproval').mockResolvedValue({ ok: true });
    render(<ChatView pane="%7" agent="codex" kind="permission" codexSession={{
      managed: true,
      approvals: [{
        id: '94', type: 'command', command: 'uname -s', cwd: '/work',
        decisions: ['accept', { id: 'structured:1', type: 'execpolicy', rule: ['uname', '-s'] }, 'decline'],
      }],
    }} />);
    const remember = await screen.findByRole('button', { name: '允许并记住“uname -s”' });
    fireEvent.click(remember);
    await waitFor(() => expect(api.answerCodexApproval).toHaveBeenCalledWith('%7', '94', 'structured:1'));
  });

  it('wraps long Codex approval decisions in a bounded label', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'text', text: '准备执行' }]);
    render(<ChatView pane="%0" agent="codex" kind="permission" codexSession={{
      managed: true,
      approvals: [{
        id: 'long-rule', type: 'command', command: 'tool run', cwd: '/work',
        decisions: [{ id: 'structured:long', type: 'execpolicy', rule: ['tool', 'argument'.repeat(80)] }],
      }],
    }} />);
    expect((await screen.findByRole('button', { name: /允许并记住/ }))
      .querySelector('.chat-gate-btn-label')).toBeTruthy();
  });

  it('renders user text right and assistant text left', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '帮我跑测试' },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '好的' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="working" />);
    const user = await screen.findByText('帮我跑测试');
    await waitFor(() => expect(container.querySelector('.chat-them')).toBeTruthy());
    expect(user.className).toContain('chat-me');
    const them = container.querySelector('.chat-them');
    expect(them.className).toContain('chat-md');
    expect(them.textContent).toContain('好的');
  });

  it('routes assistant file paths and URLs through the terminal link handler', async () => {
    mockTranscript([{
      k: 0, i: 0, role: 'assistant', type: 'text',
      text: '查看 docs/spec.md 和 http://localhost:3000/preview',
    }]);
    const onDocLinkTap = vi.fn();
    render(<ChatView pane="%0" kind="done" onDocLinkTap={onDocLinkTap} />);

    fireEvent.click(await screen.findByText('docs/spec.md'), { clientX: 21, clientY: 34 });
    expect(onDocLinkTap).toHaveBeenLastCalledWith(
      { kind: 'doc', path: 'docs/spec.md' }, 21, 34,
    );

    fireEvent.click(screen.getByText('http://localhost:3000/preview'), { clientX: 55, clientY: 89 });
    expect(onDocLinkTap).toHaveBeenLastCalledWith({
      kind: 'url', protocol: 'http', port: 3000,
      urlPath: '/preview', raw: 'http://localhost:3000/preview',
    }, 55, 89);
  });

  it('routes explicit Markdown file links through the same handler and strips line suffixes', async () => {
    mockTranscript([{
      k: 0, i: 0, role: 'assistant', type: 'text',
      text: '[打开规格](/work/docs/spec.md:12)',
    }]);
    const onDocLinkTap = vi.fn();
    render(<ChatView pane="%0" kind="done" onDocLinkTap={onDocLinkTap} />);

    fireEvent.click(await screen.findByRole('link', { name: '打开规格' }));
    expect(onDocLinkTap).toHaveBeenCalledWith({ kind: 'doc', path: '/work/docs/spec.md' }, 0, 0);
  });

  it('allows arbitrary text-file targets but renders unrecognized protocols as non-clickable text', async () => {
    mockTranscript([{
      k: 0, i: 0, role: 'assistant', type: 'text',
      text: '[Codex 配置](/home/tester/.codex/config.toml:1) 和 [邮件](mailto:test@example.com)',
    }]);
    const onDocLinkTap = vi.fn();
    const { container } = render(<ChatView pane="%0" kind="done" onDocLinkTap={onDocLinkTap} />);

    fireEvent.click(await screen.findByRole('link', { name: 'Codex 配置' }));
    expect(onDocLinkTap).toHaveBeenCalledWith(
      { kind: 'doc', path: '/home/tester/.codex/config.toml' }, 0, 0,
    );
    expect(container.textContent).toContain('邮件');
    expect(screen.queryByRole('link', { name: '邮件' })).toBeNull();
    expect(onDocLinkTap).toHaveBeenCalledTimes(1);
  });

  it('renders a page-local Codex message immediately with its sending state', async () => {
    mockTranscript([]);
    const { container } = render(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={[{ id: 'optimistic-1', text: '马上显示', status: 'sending' }]} />);
    await screen.findByText('马上显示');
    expect(screen.getByText('正在发送')).toBeTruthy();
    expect(container.querySelector('.chat-optimistic')).toBeTruthy();
    expect(container.textContent).not.toContain('发送你的第一条消息');
  });

  it('does not append an exact live copy after its durable assistant message', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '检查结果' },
      { k: 1, i: 1, turnId: 'turn-1', role: 'assistant', type: 'text', text: '已经完成检查' },
      { k: 2, i: 2, role: 'assistant', type: 'tool', tool: {
        name: 'exec_command', input: { cmd: 'npm test' }, result: 'ok', isError: false,
      } },
    ]);
    let emit;
    api.streamCodexMessages.mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    render(<ChatView pane="%1" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1' }} />);
    await screen.findByText('已经完成检查');
    await waitFor(() => expect(emit).toBeTypeOf('function'));

    act(() => emit({
      type: 'snapshot', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: '已经完成检查', completed: false,
    }));

    expect(screen.getAllByText('已经完成检查')).toHaveLength(1);
  });

  it('keeps an acknowledged queued message visible until the server queue replaces it', async () => {
    mockTranscript([]);
    const optimistic = [{
      id: 'optimistic-1', queueId: 'queued-1', text: '下一轮继续处理', status: 'queued',
    }];
    const onOptimisticCovered = vi.fn();
    const { container, rerender } = render(<ChatView pane="%0" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1', queue: [] }}
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} />);

    await screen.findByText('下一轮继续处理');
    expect(screen.getByText('已加入队列')).toBeTruthy();
    expect(container.querySelector('.chat-optimistic')).toBeTruthy();

    rerender(<ChatView pane="%0" agent="codex" kind="working"
      codexSession={{
        managed: true, threadId: 'thread-1', queue: [{ id: 'queued-1', text: '下一轮继续处理' }],
      }} optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} />);

    await waitFor(() => expect(onOptimisticCovered).toHaveBeenCalledWith(['optimistic-1']));
    expect(container.querySelector('.chat-optimistic')).toBeNull();
  });

  it('keeps ordinary sends instant in chat but leaves queue-targeted sends to the composer', async () => {
    mockTranscript([]);
    const { container, rerender } = render(<ChatView pane="%0" agent="codex" kind="done"
      codexSession={{ managed: true, threadId: 'thread-1', queue: [] }}
      optimisticMessages={[{
        id: 'ordinary-1', text: '普通消息立即显示', source: 'send', status: 'sending',
      }]} />);

    expect(await screen.findByText('普通消息立即显示')).toBeTruthy();
    expect(container.querySelector('.chat-optimistic')).toBeTruthy();

    rerender(<ChatView pane="%0" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1', queue: [] }}
      optimisticMessages={[{
        id: 'queued-1', text: '排队消息不闪进聊天区', source: 'queue', status: 'sending',
      }]} />);
    await waitFor(() => expect(screen.queryByText('普通消息立即显示')).toBeNull());
    expect(screen.queryByText('排队消息不闪进聊天区')).toBeNull();
    expect(container.querySelector('.chat-optimistic')).toBeNull();
  });

  it('reconciles a timed-out queue request from the authoritative request id', async () => {
    mockTranscript([]);
    const optimistic = [{
      id: 'request-1', text: '服务端实际已接收', source: 'queue', status: 'sending',
    }];
    const onOptimisticCovered = vi.fn();
    const { rerender } = render(<ChatView pane="%0" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1', queue: [] }}
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} />);

    expect(screen.queryByText('服务端实际已接收')).toBeNull();
    rerender(<ChatView pane="%0" agent="codex" kind="working" codexSession={{
      managed: true, threadId: 'thread-1',
      queue: [{ id: 'server-queue-1', requestId: 'request-1', text: '服务端实际已接收' }],
    }} optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} />);
    await waitFor(() => expect(onOptimisticCovered).toHaveBeenCalledWith(['request-1']));
  });

  it('renders a composer failure inside the conversation with its actionable reason', async () => {
    mockTranscript([]);
    const { container } = render(<ChatView pane="%0" kind="done"
      actionError={{ id: 'error-1', kind: 'send', detail: '连接已断开，请检查网络' }} />);

    await screen.findByText('消息没有发送成功：连接已断开，请检查网络');
    expect(container.querySelector('.chat-scroll .chat-action-error')).toBeTruthy();
    expect(container.textContent).not.toContain('发送你的第一条消息');
  });

  it('lets a new durable rollout message replace its temporary bubble without duplication', async () => {
    mockTranscript([]);
    const optimistic = [{
      id: 'optimistic-1', text: '不要显示两次', status: 'accepted',
    }];
    const onOptimisticCovered = vi.fn();
    const { rerender } = render(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} refreshToken={0} />);
    await screen.findByText('不要显示两次');

    api.fetchTranscript.mockResolvedValue({
      messages: [{
        k: 0, i: 4, role: 'user', type: 'text', text: '不要显示两次',
      }],
      hash: 'h2', session: 's', hasMore: false, firstSeq: 0,
    });
    rerender(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} refreshToken={1} />);

    await waitFor(() => expect(onOptimisticCovered).toHaveBeenCalledWith(['optimistic-1']));
    expect(screen.getAllByText('不要显示两次')).toHaveLength(1);
  });

  it('uses one authoritative message to cover only one identical temporary bubble', async () => {
    mockTranscript([]);
    const optimistic = [
      { id: 'optimistic-1', text: '相同内容', status: 'steered' },
      { id: 'optimistic-2', text: '相同内容', status: 'steered' },
    ];
    const onOptimisticCovered = vi.fn();
    const { rerender } = render(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} refreshToken={0} />);
    await waitFor(() => expect(screen.getAllByText('相同内容')).toHaveLength(2));

    api.fetchTranscript.mockResolvedValue({
      messages: [{
        k: 0, i: 4, role: 'user', type: 'text', text: '相同内容',
      }],
      hash: 'h2', session: 's', hasMore: false, firstSeq: 0,
    });
    rerender(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} refreshToken={1} />);

    await waitFor(() => expect(onOptimisticCovered).toHaveBeenCalledWith(['optimistic-1']));
    expect(screen.getAllByText('相同内容')).toHaveLength(2);
  });

  it('does not let an already loaded identical history item cover a fresh temporary bubble', async () => {
    mockTranscript([{ k: 2, i: 2, role: 'user', type: 'text', text: '重复问题' }]);
    const optimistic = [{ id: 'optimistic-1', text: '重复问题', status: 'accepted' }];
    const onOptimisticCovered = vi.fn();
    const { rerender } = render(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={[]} onOptimisticCovered={onOptimisticCovered} refreshToken={0} />);
    await screen.findByText('重复问题');

    rerender(<ChatView pane="%0" agent="codex" kind="working"
      optimisticMessages={optimistic} onOptimisticCovered={onOptimisticCovered} refreshToken={0} />);

    await waitFor(() => expect(screen.getAllByText('重复问题')).toHaveLength(2));
    expect(onOptimisticCovered).not.toHaveBeenCalled();
  });

  it('does not surface thinking (reasoning) text — the live animation stands in for it', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'assistant', type: 'thinking', text: '让我想想这个边界情况' },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '答案是四十二' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('答案是四十二');
    expect(screen.queryByText(/让我想想/)).toBeNull();
    expect(container.querySelector('.chat-thinking')).toBeNull();
  });

  it('stamps time on user inputs and each turn\'s LAST ai reply only (not mid-turn text or tools)', async () => {
    const t = '2026-07-17T06:00:00.000Z';
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '问题一', ts: t },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '中间回复', ts: t },
      { k: 2, i: 2, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'x', isError: false }, ts: t },
      { k: 3, i: 3, role: 'assistant', type: 'text', text: '最终回复', ts: t },
      { k: 4, i: 4, role: 'user', type: 'text', text: '问题二', ts: t },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('问题二');
    // 问题一(user) + 最终回复(turn-final ai) + 问题二(user) = 3; 中间回复 & 工具 无
    expect(container.querySelectorAll('.chat-ts').length).toBe(3);
    expect(container.querySelectorAll('.chat-ts.ts-me').length).toBe(2);
    expect(container.querySelectorAll('.chat-ts.ts-them').length).toBe(1);
  });

  it('renders no timestamp when messages carry none (never fabricates one)', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '无时间戳' },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '也无' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('也无');
    expect(container.querySelector('.chat-ts')).toBeNull();
  });

  it('renders an ESC-interrupt as a quiet centered hint, not a user bubble', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '跑测试' },
      { k: 1, i: 1, type: 'interrupt' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await waitFor(() => expect(container.querySelector('.chat-interrupt')).toBeTruthy());
    expect(container.querySelector('.chat-interrupt').textContent).toContain('终止');
    // it must NOT render as a right-aligned user pill
    expect(container.querySelectorAll('.chat-me').length).toBe(1); // only 跑测试
  });

  it('collapses a tool call into a chip with a summary', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'a', isError: false } }]);
    render(<ChatView pane="%0" kind="working" />);
    // chip 文案含工具名/动作，不直接铺原始结果
    await screen.findByText(/Bash|运行|命令/);
    expect(screen.queryByText('a')).toBeNull(); // 结果默认折叠
  });

  it('labels a code change as editing its filename instead of a generic action', async () => {
    mockTranscript([{
      k: 0, role: 'assistant', type: 'tool',
      tool: { name: 'apply_patch', input: { file_path: '/work/web/src/ChatView.jsx' }, result: '', isError: false },
    }]);
    render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('编辑 ChatView.jsx');
    expect(screen.queryByText('应用代码改动')).toBeNull();
  });

  it('does not label a completed file edit as 已结束 in either the chip or detail sheet', async () => {
    mockTranscript([{
      k: 0, role: 'assistant', type: 'tool',
      tool: {
        name: 'apply_patch', input: { file_path: '/work/src/app.js' }, result: '',
        isError: false, outcome: 'completed',
        diff: { added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+const ready = true;'] }] },
      },
    }]);
    render(<ChatView pane="%0" kind="done" />);
    const chip = (await screen.findByText('编辑 app.js')).closest('button');
    expect(screen.queryByText('已结束')).toBeNull();
    fireEvent.click(chip);
    await screen.findByText('const ready = true;');
    expect(screen.queryByText('已结束')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(window.history.state?.chatToolSheet).toBeFalsy());
  });

  it('hides the Codex zsh launch wrapper in command chips and details', async () => {
    mockTranscript([{
      k: 0, role: 'assistant', type: 'tool',
      tool: { name: 'exec_command', input: { cmd: ["/bin/zsh -lc 'npm test'"] }, result: 'passed', isError: false },
    }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    const chip = (await screen.findByText('运行 npm test')).closest('button');
    expect(chip.textContent).not.toContain('/bin/zsh');
    fireEvent.click(chip);
    const command = await waitFor(() => {
      const node = container.querySelector('.tool-sheet-cmd');
      expect(node).toBeTruthy();
      return node;
    });
    expect(command.textContent).toBe('npm test');
  });

  it('uses a complete command label when a running command has no parsed arguments', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: {
      name: 'exec_command', input: {}, result: null, isError: false,
    } }]);
    render(<ChatView pane="%0" agent="codex" kind="working" />);

    expect(await screen.findByText('运行命令')).toBeTruthy();
    expect(screen.queryByText('运行')).toBeNull();
  });

  it('an uncatalogued tool gets a generic 调用工具 verb (never a bare tool name); a skill says 激活技能', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'AskUserQuestion', input: { questions: [] }, result: null, isError: false } },
      { k: 1, i: 1, role: 'assistant', type: 'tool', tool: { name: 'Skill', input: { skill: 'frontend-design' }, result: 'ok', isError: false } },
    ]);
    render(<ChatView pane="%0" kind="working" />);
    await screen.findByText('调用工具 AskUserQuestion');
    await screen.findByText('激活技能 frontend-design');
  });

  it('a finished tool shows a ✓ on success and a ✗ on failure (box stays neutral)', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'ok', isError: false } },
      { k: 1, i: 1, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'bad' }, result: 'boom', isError: true } },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await waitFor(() => expect(container.querySelectorAll('.chat-tool').length).toBe(2));
    expect(container.querySelector('.chat-tool-status.ok')).toBeTruthy();
    expect(container.querySelector('.chat-tool-status.err')).toBeTruthy();
  });

  it('shows persisted declines and unknown dynamic completions neutrally instead of claiming success', async () => {
    mockTranscript([
      {
        k: 0, i: 0, role: 'assistant', type: 'tool',
        tool: { name: 'exec_command', input: { cmd: 'sw_vers' }, result: 'declined', isError: false, outcome: 'declined' },
      },
      {
        k: 1, i: 1, role: 'assistant', type: 'tool',
        tool: { name: 'functions.exec', input: {}, result: 'aborted by user', isError: false, outcome: 'completed' },
      },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('已拒绝');
    await screen.findByText('已结束');
    expect(container.querySelector('.chat-tool-status.ok')).toBeNull();
    expect(container.querySelectorAll('.chat-tool-status.neutral')).toHaveLength(2);
  });

  it('tool chip stays one line (no in-page expand); tapping it opens the detail sheet with mode/command/result', async () => {
    const longCmd = 'echo ' + 'x'.repeat(200);
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: longCmd }, result: 'the output', isError: false } }]);
    const { container } = render(<ChatView pane="%0" kind="working" />);
    const head = await screen.findByRole('button', { name: new RegExp(longCmd.slice(0, 20)) });
    // no in-page expand: no open class, no result rendered inline, no sheet yet
    expect(head.className).not.toContain('chat-tool-head-open');
    expect(screen.queryByText('the output')).toBeNull();
    expect(container.querySelector('.tool-sheet')).toBeNull();
    fireEvent.click(head);
    // the bottom sheet opens with 执行模式 (运行命令), the full command, and the output
    const sheet = await waitFor(() => { const s = container.querySelector('.tool-sheet'); expect(s).toBeTruthy(); return s; });
    expect(sheet.textContent).toContain('运行命令');
    expect(sheet.querySelector('.tool-sheet-cmd').textContent).toContain(longCmd);
    expect(sheet.textContent).toContain('the output');
    // closing the sheet dismisses it
    fireEvent.click(container.querySelector('.tool-sheet-x'));
    await waitFor(() => expect(container.querySelector('.tool-sheet')).toBeNull());
  });

  it('hardware Back closes the tool sheet and stays on the lens (no app navigation)', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'out', isError: false } }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    const head = await screen.findByRole('button', { name: /ls/ });
    fireEvent.click(head);
    await waitFor(() => expect(container.querySelector('.tool-sheet')).toBeTruthy());
    expect(window.history.state?.chatToolSheet).toBe(true); // one entry pushed above the app
    // Faithful hardware-Back: actually traverse jsdom history (fires popstate in a task).
    await act(async () => {
      await new Promise((res) => {
        const h = () => { window.removeEventListener('popstate', h); res(); };
        window.addEventListener('popstate', h);
        window.history.back();
      });
    });
    await waitFor(() => expect(container.querySelector('.tool-sheet')).toBeNull());
    expect(window.history.state?.chatToolSheet).toBeFalsy(); // the sheet's own entry was the one consumed
  });

  it('closing the sheet via ✕ unwinds its history entry (a later Back does not double-pop)', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'out', isError: false } }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    const head = await screen.findByRole('button', { name: /ls/ });
    fireEvent.click(head);
    await waitFor(() => expect(container.querySelector('.tool-sheet')).toBeTruthy());
    fireEvent.click(container.querySelector('.tool-sheet-x'));
    await waitFor(() => expect(container.querySelector('.tool-sheet')).toBeNull());
    // history.go(-1) traversal lands in a task: the current entry must no longer be the sheet's
    await waitFor(() => expect(window.history.state?.chatToolSheet).toBeFalsy());
  });

  it('an edited file shows a +A/−B stat on the chip and a coloured diff in the sheet', async () => {
    mockTranscript([{
      k: 0, i: 0, role: 'assistant', type: 'tool',
      tool: {
        name: 'Edit', input: { file_path: '/a.js' }, result: 'updated', isError: false,
        diff: { added: 2, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new1', '+new2'] }] },
      },
    }]);
    const { container } = render(<ChatView pane="%0" kind="working" />);
    // stat badge visible on the collapsed chip
    expect((await screen.findByText('+2'))).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(container.querySelector('.chat-tool-status.ok')).toBeNull(); // the +A/−B stat already says success — no redundant ✓
    expect(container.querySelector('.chat-diff')).toBeNull(); // no in-page diff
    fireEvent.click(screen.getByRole('button', { name: /a\.js/ }));
    // the dedicated code-review layout opens with the diff viewer
    await waitFor(() => expect(container.querySelector('.tool-sheet-edit .dv')).toBeTruthy());
    const codes = [...container.querySelectorAll('.dv-add .dv-code')].map((el) => el.textContent);
    expect(codes).toEqual(['new1', 'new2']); // sign lives in its own column, code is the bare text
    expect(container.querySelector('.dv-del .dv-code').textContent).toBe('old');
    expect(container.querySelector('.dv-ctx .dv-code').textContent).toBe('keep');
    // new-file line numbers: context 'keep' = line 1, adds = 2 and 3 (oldStart/newStart both 1)
    expect(container.querySelector('.dv-ctx .dv-ln').textContent).toBe('1');
    expect([...container.querySelectorAll('.dv-add .dv-ln')].map((el) => el.textContent)).toEqual(['2', '3']);
    // header shows the filename; meta strip shows the mode
    expect(container.querySelector('.es-name').textContent).toBe('a.js');
    expect(container.querySelector('.tool-sheet').textContent).toContain('编辑文件');
  });

  it('shows an apply_patch hunk as code diff when persisted line numbers are unavailable', async () => {
    mockTranscript([{
      k: 0, i: 0, role: 'assistant', type: 'tool',
      tool: {
        name: 'apply_patch', input: { file_path: '/work/src/app.js' }, result: '', isError: false,
        diff: {
          added: 1, removed: 1,
          hunks: [{ oldStart: null, newStart: null, lines: [' keep', '-old', '+new'] }],
        },
      },
    }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    fireEvent.click(await screen.findByRole('button', { name: /app\.js/ }));
    await waitFor(() => expect(container.querySelector('.tool-sheet-edit .dv')).toBeTruthy());
    expect([...container.querySelectorAll('.dv-ln')].map((el) => el.textContent)).toEqual(['', '', '']);
    expect(container.querySelector('.dv-del .dv-code').textContent).toBe('old');
    expect(container.querySelector('.dv-add .dv-code').textContent).toBe('new');
    expect(screen.queryByText('apply_patch')).toBeNull();
  });

  it('collapses plan updates into one read-only summary after the turn answer', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '实现任务列表', turnId: 'turn-plan' },
      {
        k: 1, i: 1, role: 'assistant', type: 'plan', turnId: 'turn-plan',
        plan: [
          { step: '确认协议', status: 'inProgress' },
          { step: '实现界面', status: 'pending' },
        ],
      },
      {
        k: 2, i: 2, role: 'assistant', type: 'plan', turnId: 'turn-plan',
        plan: [
          { step: '确认协议', status: 'completed' },
          { step: '实现界面', status: 'completed' },
        ],
      },
      { k: 3, i: 3, role: 'assistant', type: 'text', text: '已经完成。', turnId: 'turn-plan' },
    ]);
    const { container } = render(<ChatView pane="%0" agent="codex" kind="done"
      codexSession={{ managed: true, threadId: 'thread-1', activeTurnId: null }} />);
    const answer = await screen.findByText('已经完成。');
    const summary = screen.getByRole('button', { name: /本轮任务/ });
    expect(summary.textContent).toContain('2/2');
    expect(summary.textContent).toContain('已完成');
    expect(answer.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('.chat-plan-summary')).toHaveLength(1);

    fireEvent.click(summary);
    const sheet = screen.getByRole('dialog', { name: '本轮任务' });
    expect(sheet.textContent).toContain('确认协议');
    expect(sheet.textContent).toContain('实现界面');
    expect(sheet.querySelector('input, textarea, [role="checkbox"]')).toBeNull();
  });

  it('renders Goal lifecycle cards and opens their shared read-only Bottom Sheet', async () => {
    const goal = {
      objective: 'Finish the release', status: 'complete', createdAt: 10, updatedAt: 20,
      tokensUsed: 500, timeUsedSeconds: 12, tokenBudget: null,
    };
    mockTranscript([
      { k: 0, i: 0, role: 'assistant', type: 'goal', event: 'set', goal: { ...goal, status: 'active' } },
      { k: 1, i: 1, role: 'assistant', type: 'goal', event: 'complete', goal },
    ]);
    vi.spyOn(api, 'getCodexGoal').mockResolvedValue({ goal });
    const { container } = render(<ChatView pane="%0" agent="codex" kind="done" />);

    const setCard = await screen.findByRole('button', { name: /已设置目标.*Finish the release/ });
    const completeCard = screen.getByRole('button', { name: /目标已完成.*Finish the release/ });
    expect(container.querySelectorAll('.chat-goal-card')).toHaveLength(2);
    fireEvent.click(setCard);
    let sheet = await waitFor(() => {
      const value = container.querySelector('.codex-goal-menu');
      expect(value).toBeTruthy();
      return value;
    });
    // The earlier set card resolves the same native Goal, so it opens its final state rather than a stale
    // second detail model. The terminal card then opens this exact shared sheet as well.
    expect(sheet.textContent).toContain('已完成');
    fireEvent.click(sheet.querySelector('.codex-goal-sheet-x'));
    await waitFor(() => expect(container.querySelector('.codex-goal-menu')).toBeNull());
    fireEvent.click(completeCard);
    sheet = await screen.findByRole('dialog', { name: '任务目标' });
    expect(sheet.textContent).toContain('Token 500');
    expect(sheet.textContent).toContain('耗时 12 秒');
    expect(sheet.querySelector('.codex-goal-actions')).toBeNull();
    expect(container.querySelector('.codex-goal-backdrop')).toBeTruthy();
  });

  it('keeps an unfinished historical task indicator static', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'assistant', type: 'plan', turnId: 'turn-plan',
        plan: [{ step: '等待复测', status: 'inProgress' }] },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '请复测。', turnId: 'turn-plan' },
    ]);
    render(<ChatView pane="%0" agent="codex" kind="done"
      codexSession={{ managed: true, threadId: 'thread-1', activeTurnId: null }} />);
    fireEvent.click(await screen.findByRole('button', { name: /本轮任务/ }));
    const spinner = screen.getByRole('dialog', { name: '本轮任务' })
      .querySelector('.codex-plan-spinner');
    expect(spinner.classList.contains('is-static')).toBe(true);
  });

  it('permission with no parseable menu → 允许/拒绝 fallback, taps send Enter', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: null, isError: false } }]);
    vi.spyOn(api, 'getPendingPrompt').mockResolvedValue(null); // menu not scraped → fallback
    const keys = vi.spyOn(api, 'sendKeys').mockResolvedValue({ ok: true });
    render(<ChatView pane="%0" kind="permission" />);
    const allow = await screen.findByRole('button', { name: '允许' });
    fireEvent.click(allow);
    await waitFor(() => expect(keys).toHaveBeenCalledWith('%0', expect.arrayContaining(['Enter'])));
  });

  it('handles Codex request_user_input without scraping or driving the terminal', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'text', text: '准备执行' }]);
    const pending = vi.spyOn(api, 'getPendingPrompt');
    vi.spyOn(api, 'answerCodexInput').mockResolvedValue({ ok: true });
    render(<ChatView pane="%0" agent="codex" kind="permission" codexSession={{
      managed: true,
      userInputs: [{
        id: '92', questions: [{
          id: 'color', header: '颜色', question: '选择颜色', isOther: true, isSecret: false,
          options: [{ label: '蓝色', description: '沉稳' }, { label: '红色', description: '醒目' }],
        }],
      }],
    }} />);
    const option = await screen.findByRole('radio', { name: /蓝色/ });
    expect(screen.getByText('Codex 需要你的回答')).toBeTruthy();
    expect(pending).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(api.answerCodexInput).toHaveBeenCalledWith('%0', '92', { color: ['蓝色'] }));
  });

  it('a scraped AskUserQuestion renders its real options as a radio list (not 允许/拒绝)', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    vi.spyOn(api, 'getPendingPrompt').mockResolvedValue({
      kind: 'question', title: '选个颜色?', cursor: 1,
      options: [{ n: 1, label: '红色', description: '热情' }, { n: 2, label: '蓝色', description: '沉稳' }],
    });
    render(<ChatView pane="%0" kind="permission" />);
    await screen.findByRole('radio', { name: /红色/ });
    expect(screen.getByText('选个颜色?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull(); // rich gate, not the fallback
    expect(document.querySelector('.chat-gate-backdrop')).toBeTruthy(); // modal backdrop covers the composer
  });

  it('scopes the gate backdrop to the chat lens (measured from .chat-view), leaving the topbar/tabs uncovered', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    vi.spyOn(api, 'getPendingPrompt').mockResolvedValue({
      kind: 'question', title: '选个颜色?', cursor: 1,
      options: [{ n: 1, label: '红色', description: '' }],
    });
    // jsdom has no layout: feed rects so .chat-view starts 120px below .app's top (the topbar+tabs strip)
    // and .app ends at 800 — the backdrop must span exactly the lens (120→800), composer included.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList?.contains('app')) return { top: 0, bottom: 800, left: 0, right: 375, width: 375, height: 800 };
      if (this.classList?.contains('chat-view')) return { top: 120, bottom: 700, left: 0, right: 375, width: 375, height: 580 };
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    });
    render(<div className="app"><ChatView pane="%0" kind="permission" /></div>);
    await screen.findByRole('radio', { name: /红色/ });
    const bd = document.querySelector('.chat-gate-backdrop');
    await waitFor(() => expect(bd.style.top).toBe('120px'));
    expect(bd.style.height).toBe('680px');
  });

  it('after answering, the 允许/拒绝 fallback does NOT flash while kind is still catching up', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    vi.spyOn(api, 'sendText').mockResolvedValue({ ok: true });
    vi.spyOn(api, 'getPendingPrompt')
      .mockResolvedValueOnce({
        kind: 'question', title: '选个颜色?', cursor: 1,
        options: [{ n: 1, label: '红色', description: '' }, { n: 2, label: '蓝色', description: '' }],
      })
      .mockResolvedValue(null); // answered → the menu is gone from the screen on every later read
    render(<ChatView pane="%0" kind="permission" />);
    await screen.findByRole('radio', { name: /红色/ });       // the rich gate was up
    fireEvent.click(screen.getByRole('button', { name: '确认' })); // answer → post-act refetch (~450ms)
    // kind prop stays 'permission' (the /states poll hasn't caught up) and the menu re-reads as null —
    // the generic fallback must stay suppressed (the episode had a scraped menu).
    await waitFor(() => expect(screen.queryByRole('radio')).toBeNull(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 600)); // let the post-act refetch land
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull();
    expect(document.querySelector('.chat-gate-backdrop')).toBeNull(); // backdrop leaves with the gate
  });

  it('the optimistic slash echo renders a command pill at send time', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="working" slashEcho={{ name: '/compact' }} />);
    await screen.findByText('hi');
    await waitFor(() => expect(container.querySelector('.chat-slash-cmd')?.textContent).toBe('/compact'));
  });

  it('drops the echo (and calls onSlashEchoDone) once the real marker lands in the transcript', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: 'hi' },
      { k: 1, i: 1, type: 'slash', name: '/compact', result: 'Compacted' },
    ]);
    const onDone = vi.fn();
    const { container } = render(<ChatView pane="%0" kind="working" slashEcho={{ name: '/compact' }} onSlashEchoDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('.chat-slash-cmd')).toHaveLength(1)); // only the real marker
    expect(container.querySelector('.chat-slash-result')?.textContent).toBe('Compacted');
  });

  it('a same-named marker from an EARLIER run (already on screen at send time) does NOT kill a fresh echo', async () => {
    mockTranscript([
      { k: 0, i: 0, type: 'slash', name: '/compact', result: 'Compacted' },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '接着干活' },
    ]);
    const onDone = vi.fn();
    const { container, rerender } = render(<ChatView pane="%0" kind="working" />);
    await screen.findByText('接着干活'); // messages loaded BEFORE the echo appears
    rerender(<ChatView pane="%0" kind="working" slashEcho={{ name: '/compact' }} onSlashEchoDone={onDone} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(onDone).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.chat-slash-cmd').length).toBe(2); // old marker + the fresh echo
  });

  it('renders markdown in an assistant text bubble — a table becomes a real <table>', async () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'text', text: md }]);
    const { container } = render(<ChatView pane="%0" kind="working" />);
    await waitFor(() => expect(container.querySelector('table')).toBeTruthy());
  });

  it('jump-to-bottom button is hidden near the bottom, appears when scrolled up, and clicking it snaps to bottom', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="working" />);
    await screen.findByText('hi');
    const el = container.querySelector('.chat-scroll');

    setGeometry(el, { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });
    fireEvent.scroll(el);

    // A small upward pull that remains within NEAR_BOTTOM_PX keeps following and must not flash the button.
    setGeometry(el, { scrollTop: 680, scrollHeight: 1000, clientHeight: 300 }); // 20px from bottom
    fireEvent.scroll(el);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();

    // Once the pull leaves the bottom buffer, the button appears.
    setGeometry(el, { scrollTop: 640, scrollHeight: 1000, clientHeight: 300 }); // 60px from bottom
    fireEvent.scroll(el);
    const btn = container.querySelector('.new-output');
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(container.querySelector('.new-output')).toBeNull();
  });

  it('anchors a long streamed Codex answer at its beginning, then follows only after the user asks for latest', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: '写一份长说明' }]);
    let emit;
    api.streamCodexMessages.mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (this.classList?.contains('chat-scroll')) return { top: 0, bottom: 300, height: 300, left: 0, right: 320, width: 320 };
      if (this.dataset?.codexStream === 'active') return { top: 8, bottom: 328, height: 320, left: 0, right: 320, width: 320 };
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    });
    const { container, rerender } = render(<ChatView pane="%1" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1' }} />);
    await screen.findByText('写一份长说明');
    await waitFor(() => expect(emit).toBeTypeOf('function'));
    const el = container.querySelector('.chat-scroll');
    setGeometry(el, { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 });

    act(() => {
      emit({ type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '' });
      emit({ type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '第一段正在生成' });
    });
    await screen.findByText('第一段正在生成');
    await waitFor(() => expect(container.querySelector('.new-output')?.textContent).toContain('查看最新回答'));
    const anchoredTop = el.scrollTop;

    Object.defineProperty(el, 'scrollHeight', { value: 1400, configurable: true });
    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '，后续内容继续增长',
    }));
    await screen.findByText('第一段正在生成，后续内容继续增长');
    expect(el.scrollTop).toBe(anchoredTop);

    fireEvent.click(container.querySelector('.new-output'));
    Object.defineProperty(el, 'scrollHeight', { value: 1600, configurable: true });
    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '，现在跟随最新',
    }));
    await screen.findByText('第一段正在生成，后续内容继续增长，现在跟随最新');
    expect(el.scrollTop).toBe(1600);

    rerender(<ChatView pane="%1" agent="codex" kind="working"
      codexSession={{ managed: true, threadId: 'thread-1' }}
      optimisticMessages={[{ id: 'queued-1', text: '排队处理下一项', status: 'sending' }]} />);
    await screen.findByText('排队处理下一项');
    Object.defineProperty(el, 'scrollHeight', { value: 1800, configurable: true });
    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '，当前回答仍在继续',
    }));
    await screen.findByText('第一段正在生成，后续内容继续增长，现在跟随最新，当前回答仍在继续');
    expect(el.scrollTop).toBe(1800);
    expect(container.querySelector('.new-output')).toBeNull();
  });

  it('a newly-arrived trailing user message forces the view back to the bottom, even if scrolled up', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'fetchTranscript');
      spy.mockResolvedValueOnce({ messages: [{ k: 0, i: 0, role: 'assistant', type: 'text', text: 'first' }], hash: 'h1', hasMore: false, firstSeq: 0 });
      const { container } = render(<ChatView pane="%0" kind="working" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); }); // flush initial fetch

      const el = container.querySelector('.chat-scroll');
      setGeometry(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }); // scrolled up, away from bottom
      fireEvent.scroll(el);

      // Next poll delivers a NEW trailing user message (k=1 > previous max k=0).
      spy.mockResolvedValueOnce({
        messages: [
          { k: 0, i: 0, role: 'assistant', type: 'text', text: 'first' },
          { k: 1, i: 1, role: 'user', type: 'text', text: 'second' },
        ],
        hash: 'h2', hasMore: false, firstSeq: 0,
      });
      // Growing the scrollHeight to simulate the new message actually adding content, so scrollTop===scrollHeight is meaningful.
      Object.defineProperty(el, 'scrollHeight', { value: 1400, configurable: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      expect(el.scrollTop).toBe(1400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the typing indicator while working with a trailing user message, hides it when done (trailing assistant message)', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'fetchTranscript');
      spy.mockResolvedValue({
        messages: [{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }],
        hash: 'h1', hasMore: false, firstSeq: 0,
      });
      const { container, rerender } = render(<ChatView pane="%0" kind="working" />);
      await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('.chat-typing')).toBeTruthy();

      // kind flips to 'done' AND the trailing message becomes an assistant reply — the normal end-of-turn case.
      spy.mockResolvedValue({
        messages: [
          { k: 0, i: 0, role: 'user', type: 'text', text: 'hi' },
          { k: 1, i: 1, role: 'assistant', type: 'text', text: 'reply' },
        ],
        hash: 'h2', hasMore: false, firstSeq: 0,
      });
      rerender(<ChatView pane="%0" kind="done" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      expect(screen.queryByText('reply')).toBeTruthy();
      expect(container.querySelector('.chat-typing')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Claude\'s trailing-user bridge while its Hook state catches up', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('hi');
    expect(container.querySelector('.chat-typing')).toBeTruthy();
  });

  it('does not infer Codex activity from a trailing user message when App Server reports idle', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" agent="codex" kind="done" />);
    await screen.findByText('hi');
    expect(container.querySelector('.chat-typing')).toBeNull();
  });

  it('renders a compaction marker as a centered divider, not a bubble', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '压缩前' },
      { k: 1, i: 1, type: 'compact' },
      { k: 2, i: 2, role: 'assistant', type: 'text', text: '压缩后' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('压缩后');
    const div = container.querySelector('.chat-compact-divider');
    expect(div).toBeTruthy();
    expect(div.textContent).toContain('上下文已压缩');
    expect(container.querySelectorAll('.chat-me').length).toBe(1); // only 压缩前 is a user bubble
  });

  it('renders only the newest compaction marker when Codex compacts twice nearby', async () => {
    mockTranscript([
      { k: 0, i: 0, role: 'user', type: 'text', text: '第一次提问' },
      { k: 1, i: 1, type: 'compact' },
      { k: 2, i: 2, role: 'assistant', type: 'text', text: '第一次回答' },
      { k: 3, i: 3, type: 'compact' },
      { k: 4, i: 4, role: 'user', type: 'text', text: '继续' },
    ]);
    const { container } = render(<ChatView pane="%0" agent="codex" kind="done" />);
    await screen.findByText('继续');
    expect(container.querySelectorAll('.chat-compact-divider')).toHaveLength(1);
  });

  it('a slash command splits into a right-aligned command pill and a separate left-aligned result line', async () => {
    mockTranscript([
      { k: 0, i: 0, type: 'slash', name: '/model', result: 'Set model to Opus 4.8' },
      { k: 1, i: 1, role: 'assistant', type: 'text', text: '好的' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('好的');
    const cmd = container.querySelector('.chat-slash-cmd');
    const result = container.querySelector('.chat-slash-result');
    expect(cmd.textContent).toBe('/model');              // the command the user ran (its own element)
    expect(result.textContent).toBe('Set model to Opus 4.8'); // the result, a SEPARATE element
    expect(cmd.contains(result)).toBe(false);             // not merged into one row
    expect(container.querySelectorAll('.chat-me').length).toBe(0); // never a normal user bubble
    expect(container.querySelector('.chat-slash-goterm')).toBeNull(); // no in-transcript hand-off button
  });

  it('a slash command with args shows the args in the pill; a result-less command renders just the pill', async () => {
    mockTranscript([
      { k: 0, i: 0, type: 'slash', name: '/model', args: 'sonnet' },
      { k: 1, i: 1, type: 'slash', name: '/clear' },
    ]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await waitFor(() => expect(container.querySelectorAll('.chat-slash-cmd').length).toBe(2));
    const pills = [...container.querySelectorAll('.chat-slash-cmd')].map((el) => el.textContent);
    expect(pills).toEqual(['/model sonnet', '/clear']);
    expect(container.querySelector('.chat-slash-result')).toBeNull(); // neither has a result
  });

  it('kind="compacting" shows the 压缩中 indicator, not the plain typing wave', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="compacting" />);
    await screen.findByText('hi');
    const c = container.querySelector('.chat-compacting');
    expect(c).toBeTruthy();
    expect(c.textContent).toContain('正在压缩上下文');
    expect(c.textContent).not.toContain('…'); // the wave dots carry the "in progress" cue, not a fake ellipsis
    // the wave trails the label (label first, dots last)
    const label = c.querySelector('.chat-compacting-label');
    expect(label.nextElementSibling.classList.contains('chat-typing-dots')).toBe(true);
    expect(container.querySelector('.chat-typing')).toBeNull(); // compacting suppresses the plain wave
  });

  it('kind="error" shows a turn-error note with the reason and suppresses typing (even after a trailing user message)', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="error" msg="服务过载" />);
    await screen.findByText('hi');
    const e = container.querySelector('.chat-turn-error');
    expect(e).toBeTruthy();
    expect(e.textContent).toContain('本轮出错');
    expect(e.textContent).toContain('服务过载');
    expect(container.querySelector('.chat-typing')).toBeNull(); // error is not "generating a reply"
  });

  it('a running tool (result:null, last, working) shows a running marker and suppresses the typing bubble; clears once result arrives', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'fetchTranscript');
      spy.mockResolvedValueOnce({
        messages: [{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: null, isError: false } }],
        hash: 'h1', hasMore: false, firstSeq: 0,
      });
      const { container } = render(<ChatView pane="%0" kind="working" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      // running marker is the wave (no "运行中" label — the pulse already conveys in-progress)
      expect(container.querySelector('.chat-tool-head-running .chat-typing-dots')).toBeTruthy();
      expect(container.querySelector('.chat-typing')).toBeNull();
      const chip = container.querySelector('.chat-tool');
      expect(chip.className).toContain('chat-tool-running');

      spy.mockResolvedValueOnce({
        messages: [{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: 'ok', isError: false } }],
        hash: 'h2', hasMore: false, firstSeq: 0,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      expect(container.querySelector('.chat-tool-head-running')).toBeNull();
      expect(container.querySelector('.chat-tool').className).not.toContain('chat-tool-running');
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression for the priority-ordering bug: a loadOlder() prepend in flight must NOT consume the
  // "new trailing user message" signal — the last trailing identity must stay stale through the pendingPrepend branch
  // run so the run that eventually applies the prepend still recognizes the user message as new and
  // force-scrolls to bottom. Pre-fix, the trailing marker advanced on every run (including the prepend branch),
  // so a user message that arrived mid-prepend was marked "already seen" and the user's own send never
  // got scrolled to.
  it('a new user message that arrives mid-prepend still forces bottom once the prepend resolves', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'fetchTranscript');
      spy.mockResolvedValueOnce({
        messages: [{ k: 5, i: 5, role: 'assistant', type: 'text', text: 'first' }],
        hash: 'h1', hasMore: true, firstSeq: 5,
      });
      const { container } = render(<ChatView pane="%0" kind="working" />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      const el = container.querySelector('.chat-scroll');
      // Scrolled near the top → triggers loadOlder() on the next scroll event.
      setGeometry(el, { scrollTop: 10, scrollHeight: 500, clientHeight: 300 });

      let resolveOlder;
      spy.mockImplementationOnce(() => new Promise((res) => { resolveOlder = res; }));
      fireEvent.scroll(el); // scrollTop(10) < NEAR_TOP_PX(80) && hasMoreOlder → loadOlder() fires, stays pending

      // While the prepend is in flight, a recent-window poll (1500ms cadence) lands with a genuinely new
      // trailing USER message (k=6 > last-seen max k=5) — e.g. the user sent something while scrolled up.
      spy.mockResolvedValueOnce({
        messages: [
          { k: 5, i: 5, role: 'assistant', type: 'text', text: 'first' },
          { k: 6, i: 6, role: 'user', type: 'text', text: 'sent while scrolled up' },
        ],
        hash: 'h2', hasMore: true, firstSeq: 5,
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      // This run took the pendingPrepend branch (scroll delta restore, early return) — it must NOT have
      // force-scrolled to bottom, and must NOT have consumed the new-user-message signal.
      expect(el.scrollTop).toBe(10);

      // Now the loadOlder() fetch resolves, prepending older history — this drives another messages update.
      Object.defineProperty(el, 'scrollHeight', { value: 900, configurable: true });
      await act(async () => {
        resolveOlder({ messages: [{ k: 3, i: 3, role: 'assistant', type: 'text', text: 'older' }], hasMore: false, firstSeq: 3 });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });

      // The trailing identity was not advanced during the pending prepend, so this run still sees the user
      // message as newly arrived and force-scrolls to bottom.
      expect(el.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-pulls the previous page when every message is small (window shorter than the viewport, nothing to scroll)', async () => {
    const spy = vi.spyOn(api, 'fetchTranscript');
    let resolveFirst;
    spy.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }));
    const { container } = render(<ChatView pane="%0" kind="done" />);
    const el = container.querySelector('.chat-scroll');
    // One tiny message: the content (200px) doesn't fill the viewport (600px) — scrollTop is pinned at 0,
    // so the scroll-up trigger for loadOlder can never fire. The auto-fill must pull instead.
    setGeometry(el, { scrollTop: 0, scrollHeight: 200, clientHeight: 600 });
    spy.mockResolvedValueOnce({
      messages: [{ k: 5, i: 5, role: 'assistant', type: 'text', text: 'older page' }], hasMore: false, firstSeq: 5,
    });
    await act(async () => {
      resolveFirst({
        messages: [{ k: 10, i: 10, role: 'assistant', type: 'text', text: 'hi' }],
        hash: 'h1', hasMore: true, firstSeq: 10,
      });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    await screen.findByText('older page'); // pulled with no scrolling at all
    expect(spy).toHaveBeenCalledWith('%0', expect.objectContaining({ before: 10, limit: 20 }));
    // and it stops: hasMore is now false, so no third fetch chain forms
  });

  it('auto-pulls after a zero-height first layout later becomes visible', async () => {
    const observers = [];
    const OriginalResizeObserver = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
    };
    try {
      const spy = vi.spyOn(api, 'fetchTranscript');
      let resolveFirst;
      spy.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
      const { container } = render(<ChatView pane="%0" kind="done" />);
      const el = container.querySelector('.chat-scroll');
      setGeometry(el, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
      spy.mockResolvedValueOnce({
        messages: [{ k: 5, i: 5, role: 'assistant', type: 'text', text: 'older after layout' }],
        hasMore: false, firstSeq: 5,
      });
      await act(async () => {
        resolveFirst({
          messages: [{ k: 10, i: 10, role: 'assistant', type: 'text', text: 'latest' }],
          hash: 'h1', hasMore: true, firstSeq: 10,
        });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      expect(spy).toHaveBeenCalledTimes(1); // the zero-height one-shot measurement cannot pull yet

      setGeometry(el, { scrollTop: 0, scrollHeight: 200, clientHeight: 600 });
      await act(async () => {
        observers.at(-1).callback();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      await screen.findByText('older after layout');
      expect(spy).toHaveBeenCalledWith('%0', expect.objectContaining({ before: 10, limit: 20 }));
    } finally {
      global.ResizeObserver = OriginalResizeObserver;
    }
  });
});
