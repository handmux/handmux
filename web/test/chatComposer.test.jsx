import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  getConfig: vi.fn(async () => ({ asr: false })), // keyless → mic hidden, keeps the DOM simple
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const voice = vi.hoisted(() => ({ state: 'idle', partial: '', start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import ChatComposer from '../src/components/ChatComposer.jsx';
import { sendText } from '../src/api.js';

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

  it('hides key-type favs (terminal keys) from the chip strip; reply/cmd favs still show', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([
      { kind: 'key', text: 'Escape', label: 'ESC' },
      { kind: 'reply', text: '好的' },
      { kind: 'cmd', text: '/compact' },
    ]));
    render(<ChatComposer pane="%1" kind="idle" />);
    expect(screen.queryByRole('button', { name: 'ESC' })).toBeNull();
    expect(screen.getByRole('button', { name: '好的' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '/compact' })).toBeTruthy();
  });
});
