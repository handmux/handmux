import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import AgentConversationComposer from '../src/components/AgentConversationComposer.js';
import type { AgentConversationController } from '../src/hooks/useAgentConversation.js';

vi.mock('../src/hooks/useUpload.js', () => ({
  useUpload: () => ({ uploadFiles: vi.fn(async () => {}) }),
}));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: () => ({
    state: 'idle', partial: '', start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  }),
}));

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
  else Reflect.deleteProperty(window, 'visualViewport');
});

function installVisualViewport(): { height: number; width: number; offsetTop: number } {
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  const viewport = { height: 800, width: 390, offsetTop: 0 };
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  return viewport;
}

function conversation(send = vi.fn(async () => {})): AgentConversationController {
  return {
    status: 'ready', error: null, canonicalReady: true,
    descriptor: {
      session: { agentId: 'pi', sessionId: 'focus-session' },
      viewId: 'focus-view', historyVersion: 'focus-history',
      capabilities: { history: true, live: 'poll', send: ['prompt'] },
    },
    items: [], hasMore: false, loadingOlder: false, sending: false, interrupting: false,
    send, interrupt: vi.fn(async () => {}), loadOlder: vi.fn(async () => {}),
    downloadResource: vi.fn(async () => {}), retryOutgoing: vi.fn(async () => {}),
  } as AgentConversationController;
}

function PanelControl() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开功能</button>
    {open && <div data-conversation-overlay data-testid="panel-backdrop"
      role="dialog" aria-label="功能面板" onClick={() => setOpen(false)} />}
  </>;
}

function pointerDown(target: Element): Event {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  fireEvent(target, event);
  return event;
}

describe('AgentConversationComposer mobile focus ownership', () => {
  it('releases stale textarea focus when the iOS keyboard is already closed', () => {
    installVisualViewport();
    const { container } = render(<AgentConversationComposer agentId="pi"
      sessionId="closed-keyboard" busy={false} conversation={conversation()}
      actionContent={<PanelControl />} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.focus(); // iOS can leave this focus behind after dismissing the real keyboard.
    const blur = vi.spyOn(input, 'blur');

    const open = screen.getByRole('button', { name: '打开功能' });
    const openPointer = pointerDown(open);
    fireEvent.click(open);

    expect(openPointer.defaultPrevented).toBe(false);
    expect(blur).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(input);
    const backdrop = container.querySelector('[data-testid="panel-backdrop"]')!;
    const closePointer = pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(closePointer.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
    expect(screen.queryByRole('dialog', { name: '功能面板' })).toBeNull();
  });

  it('preserves the focused composer and normal send while the soft keyboard is physically up', async () => {
    const viewport = installVisualViewport();
    const send = vi.fn(async () => {});
    const { container } = render(<AgentConversationComposer agentId="pi"
      sessionId="open-keyboard" busy={false} conversation={conversation(send)} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '继续' } });
    input.focus();
    const blur = vi.spyOn(input, 'blur');
    viewport.height = 430;

    const sendButton = container.querySelector('button.cc-send')!;
    const sendPointer = pointerDown(sendButton);
    fireEvent.click(sendButton);

    expect(sendPointer.defaultPrevented).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    await waitFor(() => expect(send).toHaveBeenCalledWith('继续', { queueHint: false }));
    expect(document.activeElement).toBe(input);
  });
});
