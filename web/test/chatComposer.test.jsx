import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  getConfig: vi.fn(async () => ({ asr: false })), // keyless → mic hidden, keeps the DOM simple
  getPaneContext: vi.fn(async () => ({ model: null, usedPercent: null })), // no context chip by default
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const voice = vi.hoisted(() => ({ state: 'idle', partial: '', start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import ChatComposer from '../src/components/ChatComposer.jsx';
import { sendText, getPaneContext } from '../src/api.js';

// No globals:true → register cleanup manually so DOM doesn't leak between tests.
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); voice.state = 'idle'; });

const typeInto = (el, text) => fireEvent.change(el, { target: { value: text } });

describe('ChatComposer', () => {
  it('send is disabled until there is non-blank text', () => {
    render(<ChatComposer pane="%1" kind="idle" />);
    const send = screen.getByRole('button', { name: '发送' });
    expect(send.disabled).toBe(true);
    typeInto(screen.getByPlaceholderText('和 Claude 对话…'), '  ');
    expect(screen.getByRole('button', { name: '发送' }).disabled).toBe(true); // blank stays disabled
    typeInto(screen.getByPlaceholderText('和 Claude 对话…'), '你好');
    expect(screen.getByRole('button', { name: '发送' }).disabled).toBe(false);
  });

  it('tapping send types the text + Enter and clears the box', async () => {
    const onSent = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onSent={onSent} />);
    const ta = screen.getByPlaceholderText('和 Claude 对话…');
    typeInto(ta, '继续实现');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(ta.value).toBe(''));
    expect(sendText).toHaveBeenCalledWith('%1', '继续实现', true);
    expect(onSent).toHaveBeenCalledWith('继续实现');
  });

  it('sending a bare non-one-shot slash command hands off to the terminal lens — incl. unrecognized ones', async () => {
    const onInteractiveSlash = vi.fn();
    render(<ChatComposer pane="%1" kind="idle" onInteractiveSlash={onInteractiveSlash} />);
    const ta = screen.getByPlaceholderText('和 Claude 对话…');
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
    const ta = screen.getByPlaceholderText('和 Claude 对话…');
    typeInto(ta, '/model sonnet');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/model sonnet', true));
    typeInto(ta, '/clear');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendText).toHaveBeenCalledWith('%1', '/clear', true));
    expect(onInteractiveSlash).not.toHaveBeenCalled();
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
    const ta = screen.getByPlaceholderText('和 Claude 对话…');
    const actions = container.querySelector('.cc-actions');
    expect(document.activeElement).not.toBe(ta);
    fireEvent.pointerDown(actions, { clientX: 50, clientY: 100 });
    fireEvent.pointerUp(actions, { clientX: 50, clientY: 100 });
    expect(document.activeElement).toBe(ta);
  });

  it('tapping a control in the row does not trigger tap-to-focus (only blank space does)', () => {
    const { container } = render(<ChatComposer pane="%1" kind="idle" />);
    const ta = screen.getByPlaceholderText('和 Claude 对话…');
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

    getPaneContext.mockResolvedValue({ model: null, usedPercent: null });
    cleanup();
    const { container: c2 } = render(<ChatComposer pane="%2" kind="idle" />);
    // give the poll a tick; the chip must stay absent
    await Promise.resolve();
    expect(c2.querySelector('.cc-ctx')).toBeNull();
  });

  it('while the agent is working the send button becomes a Stop that sends Escape', () => {
    const onKey = vi.fn();
    render(<ChatComposer pane="%1" kind="working" onKey={onKey} />);
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onKey).toHaveBeenCalledWith('Escape');
    expect(sendText).not.toHaveBeenCalled();
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

  it('passes required presets into the locked editor section', () => {
    const shortcuts = { command: [], chat: [{ type: 'text', text: 'required', enter: true }] };
    const { container } = render(<ChatComposer pane="%1" kind="idle" shortcuts={shortcuts} />);
    fireEvent.click(screen.getByRole('button', { name: '常用消息' }));
    expect(container.querySelector('.cmd-config-section').textContent).toContain('required');
    expect(container.querySelector('.cmd-config-section button')).toBeNull();
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
