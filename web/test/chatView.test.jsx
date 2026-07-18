import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import ChatView from '../src/components/ChatView.jsx';
import * as api from '../src/api.js';

// This repo doesn't run vitest with `globals: true`, so testing-library's auto-cleanup (which hooks into
// a global afterEach) never registers — without this, DOM from one test leaks into the next.
afterEach(cleanup);

beforeEach(() => { vi.restoreAllMocks(); });

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

  it('permission with no parseable menu → 允许/拒绝 fallback, taps send Enter', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'assistant', type: 'tool', tool: { name: 'Bash', input: { command: 'ls' }, result: null, isError: false } }]);
    vi.spyOn(api, 'getPendingPrompt').mockResolvedValue(null); // menu not scraped → fallback
    const keys = vi.spyOn(api, 'sendKeys').mockResolvedValue({ ok: true });
    render(<ChatView pane="%0" kind="permission" />);
    const allow = await screen.findByRole('button', { name: '允许' });
    fireEvent.click(allow);
    await waitFor(() => expect(keys).toHaveBeenCalledWith('%0', expect.arrayContaining(['Enter'])));
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

    // Near the bottom (within NEAR_BOTTOM_PX) → no jump button.
    setGeometry(el, { scrollTop: 960, scrollHeight: 1000, clientHeight: 300 }); // 1000-960-300 = -260 < 40
    fireEvent.scroll(el);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();

    // Scrolled well away from the bottom → button appears.
    setGeometry(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }); // 1000-0-300 = 700 > 40
    fireEvent.scroll(el);
    const btn = container.querySelector('.new-output');
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    expect(el.scrollTop).toBe(el.scrollHeight);
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

  it('a trailing user message with stale kind="done" still shows typing (bridges the post-send gap before the slow states poll catches up)', async () => {
    mockTranscript([{ k: 0, i: 0, role: 'user', type: 'text', text: 'hi' }]);
    const { container } = render(<ChatView pane="%0" kind="done" />);
    await screen.findByText('hi');
    expect(container.querySelector('.chat-typing')).toBeTruthy();
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
  // "new trailing user message" signal — lastMaxKRef must stay stale through the pendingPrepend-branch
  // run so the run that eventually applies the prepend still recognizes the user message as new and
  // force-scrolls to bottom. Pre-fix, lastMaxKRef advanced on every run (including the prepend branch),
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

      // With the fix, lastMaxKRef was never advanced past 5 during the pendingPrepend run, so this run
      // still sees k=6 as newly-arrived and force-scrolls to bottom.
      expect(el.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });
});
