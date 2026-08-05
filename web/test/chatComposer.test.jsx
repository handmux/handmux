import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  sendCodexMessage: vi.fn(async () => ({ ok: true })),
  compactCodexSession: vi.fn(async () => ({ ok: true })),
  interruptCodexSession: vi.fn(async () => ({ interrupted: true })),
  getPaneContext: vi.fn(() => new Promise(() => {})), // no context chip by default
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const voice = vi.hoisted(() => ({ state: 'idle', partial: '', start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import ChatComposer from '../src/components/ChatComposer.jsx';
import { sendText, sendCodexMessage, compactCodexSession, interruptCodexSession, getPaneContext } from '../src/api.js';

// No globals:true → register cleanup manually so DOM doesn't leak between tests.
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getPaneContext.mockImplementation(() => new Promise(() => {}));
  localStorage.clear();
  voice.state = 'idle';
});

const typeInto = (el, text) => fireEvent.change(el, { target: { value: text } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('ChatComposer', () => {
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

  it('hands every Codex slash command to the terminal because rollout does not reliably log them', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" agent="codex" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    const input = screen.getByPlaceholderText('和 Agent 对话…');
    typeInto(input, '/compact');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onInteractiveSlash).toHaveBeenCalledWith('/compact'));
  });

  it('sends managed Codex messages and compaction through App Server without terminal handoff', async () => {
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
    expect(onInteractiveSlash).not.toHaveBeenCalled();
  });

  it('shows App Server model and effort only after they are confirmed', () => {
    const { container } = render(<ChatComposer pane="%1" agent="codex" kind="idle" codexSession={{
      managed: true, settings: { model: 'gpt-5.6-terra', effort: 'medium' },
    }} />);
    expect(container.querySelector('.cc-ctx-model').textContent).toBe('gpt-5.6-terra');
    expect(container.querySelector('.cc-ctx-pct').textContent).toBe('medium');
  });

  it('sends one structured interrupt and disables repeated stop taps', async () => {
    const request = deferred();
    interruptCodexSession.mockReturnValueOnce(request.promise);
    render(<ChatComposer pane="%1" agent="codex" kind="working" codexSession={{ managed: true }} />);
    const stop = screen.getByRole('button', { name: '停止' });
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(interruptCodexSession).toHaveBeenCalledTimes(1);
    expect(stop.disabled).toBe(true);
    request.resolve({ interrupted: true });
  });

  it('a saved chip that is a bare interactive command also hands off to the terminal lens', async () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([{ kind: 'cmd', text: '/plugin' }]));
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    fireEvent.click(screen.getByRole('button', { name: '/plugin' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/plugin', true));
    expect(onInteractiveSlash).toHaveBeenCalledTimes(1);
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
