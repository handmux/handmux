import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import AgentConversationView, {
  AgentConversationErrorView,
} from '../src/components/AgentConversationView.js';
import AgentConversationComposer from '../src/components/AgentConversationComposer.js';
import AgentModelControl from '../src/components/AgentModelControl.js';
import {
  AgentConversationContextControl,
  AgentConversationPermissionControl,
} from '../src/components/AgentConversationCapabilityControls.js';
import { OverlayPortal } from '../src/overlays/OverlayHost.js';
import {
  resolveConversationCopyBlock,
  ToolBody,
  ToolSheet,
} from '../src/components/ConversationTool.js';
import {
  conversationTextMap,
  copyTextForRange,
  domRangeForOffsets,
  paragraphRange,
} from '../src/conversationSelection.js';
import {
  ConversationSendError,
  type AgentConversationController,
} from '../src/hooks/useAgentConversation.js';
import type { AgentConversationControlsController } from '../src/hooks/useAgentConversationControls.js';
import type { AgentSessionControlController } from '../src/hooks/useAgentSessionControl.js';
import { projectConversationMessages } from '../src/conversationPresentation.js';

const upload = vi.hoisted(() => ({
  onPaths: (_paths: string[]) => {},
  uploadFiles: vi.fn(async () => {}),
}));
const voice = vi.hoisted(() => ({
  state: 'idle',
  partial: '',
  onText: (_text: string) => {},
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock('../src/hooks/useUpload.js', () => ({
  useUpload: ({ onPaths }: { onPaths: (paths: string[]) => void }) => {
    upload.onPaths = onPaths;
    return { uploadFiles: upload.uploadFiles };
  },
}));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }: { onText: (text: string) => void }) => {
    voice.onText = onText;
    return voice;
  },
}));

const styles = readFileSync('src/styles.css', 'utf8');

afterEach(() => {
  cleanup();
  voice.state = 'idle';
  voice.partial = '';
  voice.start.mockClear();
  voice.stop.mockClear();
  vi.restoreAllMocks();
});

function controller(overrides: Partial<AgentConversationController> = {}): AgentConversationController {
  return {
    status: 'ready', error: null,
    canonicalReady: true,
    descriptor: {
      session: { agentId: 'pi', sessionId: 'session-1' },
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: {
        history: true, live: 'delta', send: ['prompt', 'steer', 'follow_up'], interrupt: true,
      },
    },
    items: [], hasMore: false, loadingOlder: false, sending: false, interrupting: false,
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), loadOlder: vi.fn(async () => {}),
    downloadResource: vi.fn(async () => {}), retryOutgoing: vi.fn(async () => false),
    resendOutgoing: vi.fn(async () => {}),
    ...overrides,
  } as AgentConversationController;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: Record<string, unknown>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, values);
  fireEvent(target, event);
  return event;
}

function PortaledComposerControl({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label={`打开${label}`} onClick={() => setOpen(true)}>{label}</button>
    {open && <OverlayPortal>
      <div data-portaled-composer-control={label} onClick={() => setOpen(false)} />
    </OverlayPortal>}
  </>;
}

function composerControls(
  overrides: Partial<AgentConversationControlsController> = {},
): AgentConversationControlsController {
  return {
    status: 'ready', error: null, busy: false,
    snapshot: null,
    refresh: vi.fn(async () => {}), queueAction: vi.fn(async () => null),
    goalAction: vi.fn(async () => null),
    setPermission: vi.fn(async () => ({
      mode: 'default' as const, options: ['default' as const],
    })),
    command: vi.fn(async () => {}),
    ...overrides,
  };
}

function composerModelControl(
  overrides: Partial<AgentSessionControlController> = {},
): AgentSessionControlController {
  return {
    status: 'ready', error: null, saving: false,
    modelControl: {
      canUpdate: true,
      models: [{ id: 'provider/model', label: 'Model', efforts: [{ id: 'high' }] }],
      selected: { model: 'provider/model', effort: 'high' },
    },
    refresh: vi.fn(async () => {}), update: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('generic Agent Conversation UI', () => {
  it('keeps narrow composer edge controls fixed while only the model label truncates', () => {
    const modelControl = composerModelControl({
      modelControl: {
        canUpdate: true,
        models: [{
          id: 'provider/model', label: 'A very long provider-neutral model name',
          efforts: [{ id: 'xhigh' }], serviceTiers: [{ id: 'priority', label: 'Fast' }],
        }],
        selected: { model: 'provider/model', effort: 'xhigh', serviceTier: 'priority' },
      },
    });
    const { container } = render(
      <AgentConversationComposer agentId="future-agent" sessionId="narrow-composer" busy={false}
        conversation={controller()} sessionControl={
          <AgentModelControl control={modelControl} busy={false} />
        } />,
    );
    const left = container.querySelector('.cc-actions-left')!;
    expect(left.firstElementChild?.classList.contains('cc-attach')).toBe(true);
    expect(left.querySelector('.cc-config-trigger')).toBeTruthy();
    expect(left.querySelector('.cc-ctx-model')?.textContent)
      .toBe('A very long provider-neutral model name');
    expect(left.querySelector('.cc-ctx-pct')?.textContent).toBe('xhigh');
    expect(left.querySelector('.cc-tier-indicator.fast')).toBeTruthy();
    expect(container.querySelector('.cc-actions-right > .cc-send')).toBeTruthy();

    expect(styles).toMatch(/\.cc-actions-left\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto/);
    expect(styles).toMatch(/\.cc-actions-right\s*\{[^}]*flex:\s*none/);
    expect(styles).toMatch(/\.cc-actions-right\s*>\s*\*\s*\{[^}]*flex:\s*none/);
    expect(styles).toMatch(/\.cc-attach\s*\{[^}]*flex:\s*none/);
    expect(styles).toMatch(/\.cc-config-trigger\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto/);
    expect(styles).toMatch(/\.cc-ctx-model\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/);
    expect(styles).toMatch(/\.cc-ctx-pct\s*\{[^}]*flex:\s*none/);
    expect(styles).toMatch(/\.cc-config-trigger svg\s*\{[^}]*flex:\s*none/);
  });

  it('keeps native mouse selection on desktop while touch uses the custom callout', () => {
    expect(styles).toMatch(/\.chat-scroll,\s*\.tool-sheet\[role="dialog"\]\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-select:\s*none;[^}]*-webkit-touch-callout:\s*none/);
    expect(styles).toMatch(/\.app\[data-desktop-input="true"\] \.chat-scroll,\s*\.app\[data-desktop-input="true"\] \.tool-sheet\[role="dialog"\]\s*\{[^}]*user-select:\s*text;[^}]*-webkit-user-select:\s*text/);
    expect(styles).toMatch(/\.chat-copy-active \[data-conversation-copy-root\]\s*\{[^}]*user-select:\s*text;[^}]*-webkit-user-select:\s*text/);
    vi.useFakeTimers();
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'mouse', provisional: false,
          item: {
            id: 'mouse', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'mouse selectable text' }],
          },
        }],
      })} />);
      const bubble = container.querySelector('.chat-bubble') as HTMLElement;
      const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
      Object.assign(pointerDown, { pointerType: 'mouse', clientX: 80, clientY: 100 });
      fireEvent(bubble, pointerDown);
      act(() => vi.advanceTimersByTime(500));
      expect(container.querySelector('.chat-copy-callout')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies the touched word from a long-pressed error', async () => {
    vi.useFakeTimers();
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'error', provisional: false,
          item: {
            id: 'error', sessionId: 'session-1', status: 'complete', kind: 'notice',
            level: 'error', message: '请求失败，请稍后重试',
          },
        }],
      })} />);
      const error = container.querySelector('.chat-turn-error') as HTMLElement;
      Object.defineProperty(error, 'innerText', {
        value: '请求失败，请稍后重试', configurable: true,
      });

      fireEvent.pointerDown(error, { pointerType: 'touch', clientX: 80, clientY: 100 });
      act(() => vi.advanceTimersByTime(480));

      const copy = screen.getByRole('button', { name: '复制' });
      const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
      Object.assign(pointerDown, { pointerType: 'touch', clientX: 80, clientY: 100 });
      fireEvent(copy, pointerDown);
      fireEvent.pointerUp(copy, { pointerType: 'touch', clientX: 80, clientY: 100 });
      expect(screen.getByRole('button', { name: '复制' })).toBe(copy);
      fireEvent.click(copy);
      await act(async () => { await Promise.resolve(); });
      expect(writeText).toHaveBeenCalledWith('请求');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard, configurable: true,
      });
      vi.useRealTimers();
    }
  });

  it('expands a touched Markdown word to its semantic paragraph before copying', async () => {
    vi.useFakeTimers();
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'paragraph', provisional: false,
          item: {
            id: 'paragraph', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text:
              'First **bold phrase** tail.\n\nSecond paragraph.' }],
          },
        }],
      })} />);
      const bold = container.querySelector('.chat-md strong')!;
      fireEvent.pointerDown(bold, { pointerType: 'touch', clientX: 80, clientY: 100 });
      act(() => vi.advanceTimersByTime(480));
      expect(document.getSelection()?.toString()).toBe('bold');
      fireEvent.click(screen.getByRole('button', { name: '整段' }));
      expect(document.getSelection()?.toString()).toBe('First bold phrase tail.');
      fireEvent.click(screen.getByRole('button', { name: '复制' }));
      await act(async () => { await Promise.resolve(); });
      expect(writeText).toHaveBeenCalledWith('First bold phrase tail.');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard, configurable: true,
      });
      vi.useRealTimers();
    }
  });

  it('does not open the copy callout for a short press or a scrolling gesture', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'error', provisional: false,
          item: {
            id: 'error', sessionId: 'session-1', status: 'complete', kind: 'notice',
            level: 'error', message: '请求失败，请稍后重试',
          },
        }],
      })} />);
      const error = container.querySelector('.chat-turn-error') as HTMLElement;
      Object.defineProperty(error, 'innerText', {
        value: '请求失败，请稍后重试', configurable: true,
      });

      fireEvent.pointerDown(error, { pointerType: 'touch', clientX: 80, clientY: 100 });
      fireEvent.pointerUp(error, { pointerType: 'touch', clientX: 80, clientY: 100 });
      act(() => vi.advanceTimersByTime(500));
      expect(container.querySelector('.chat-copy-callout')).toBeNull();

      fireEvent.pointerDown(error, { pointerType: 'touch', clientX: 80, clientY: 100 });
      fireEvent.scroll(container.querySelector('.chat-scroll')!);
      act(() => vi.advanceTimersByTime(500));
      expect(container.querySelector('.chat-copy-callout')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an active selection during an outside scroll gesture and dismisses on an outside tap', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'outside-tap', provisional: false,
          item: {
            id: 'outside-tap', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'alpha beta' }],
          },
        }],
      })} />);
      const bubble = container.querySelector('.chat-bubble')!;
      const scroll = container.querySelector('.chat-scroll')!;
      firePointer(bubble, 'pointerdown', {
        pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20,
      });
      act(() => vi.advanceTimersByTime(480));
      expect(document.getSelection()?.toString()).toBe('alpha');

      firePointer(scroll, 'pointerdown', {
        pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 100,
      });
      firePointer(scroll, 'pointermove', {
        pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 120,
      });
      fireEvent.scroll(scroll);
      firePointer(scroll, 'pointerup', {
        pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 120,
      });
      expect(document.getSelection()?.toString()).toBe('alpha');
      expect(document.querySelector('.chat-copy-callout')).toBeTruthy();

      firePointer(scroll, 'pointerdown', {
        pointerType: 'touch', pointerId: 3, clientX: 200, clientY: 100,
      });
      firePointer(scroll, 'pointerup', {
        pointerType: 'touch', pointerId: 3, clientX: 200, clientY: 100,
      });
      expect(document.getSelection()?.toString()).toBe('');
      expect(document.querySelector('.chat-copy-callout')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('portals copy controls outside transformed content while preserving pointer bubbling', () => {
    expect(styles).toMatch(/\.conversation-copy-overlay\s*\{[^}]*z-index:\s*calc\(var\(--z-overlay-detail\) \+ 1\)/);
    expect(styles).toMatch(/--z-overlay-tool:\s*42;/);
    expect(styles).toMatch(/--z-overlay-detail:\s*46;/);
    expect(styles).toMatch(/\.tool-sheet\s*\{[^}]*z-index:\s*var\(--z-overlay-tool\)/);
    vi.useFakeTimers();
    try {
      const { container } = render(<div data-transformed style={{ transform: 'translateY(120px)' }}>
        <AgentConversationView conversation={controller({
          items: [{
            key: 'portal-copy', provisional: false,
            item: {
              id: 'portal-copy', sessionId: 'session-1', status: 'complete', kind: 'message',
              role: 'assistant', content: [{ type: 'text', text: 'alpha beta' }],
            },
          }],
        })} />
      </div>);
      const bubble = container.querySelector('.chat-bubble')!;
      firePointer(bubble, 'pointerdown', {
        pointerType: 'touch', pointerId: 4, clientX: 20, clientY: 20,
      });
      act(() => vi.advanceTimersByTime(480));

      const overlay = document.querySelector('.conversation-copy-overlay')!;
      const transformed = container.querySelector('[data-transformed]')!;
      expect(transformed.contains(overlay)).toBe(false);
      expect(document.body.contains(overlay)).toBe(true);

      const view = container.querySelector('.chat-view') as HTMLElement;
      const handle = document.querySelector('.chat-copy-handle[data-end="end"]')!;
      (handle as HTMLElement).setPointerCapture = vi.fn();
      (handle as HTMLElement).releasePointerCapture = vi.fn();
      firePointer(handle, 'pointerdown', {
        pointerType: 'touch', pointerId: 5, clientX: 20, clientY: 20,
      });
      expect((handle as HTMLElement).setPointerCapture).toHaveBeenCalledWith(5);
      firePointer(view, 'pointerup', {
        pointerType: 'touch', pointerId: 5, clientX: 20, clientY: 20,
      });
      expect((handle as HTMLElement).releasePointerCapture).toHaveBeenCalledWith(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses from composer and topbar siblings without swallowing their click or focus', () => {
    vi.useFakeTimers();
    const topbarClick = vi.fn();
    const composerClick = vi.fn();
    try {
      const { container } = render(<div>
        <button type="button" data-topbar onClick={topbarClick}>Topbar</button>
        <AgentConversationView conversation={controller({
          items: [{
            key: 'document-outside', provisional: false,
            item: {
              id: 'document-outside', sessionId: 'session-1', status: 'complete', kind: 'message',
              role: 'assistant', content: [{ type: 'text', text: 'alpha beta' }],
            },
          }],
        })} />
        <button type="button" data-composer onClick={composerClick}>Composer</button>
      </div>);
      const bubble = container.querySelector('.chat-bubble')!;
      const topbar = container.querySelector('[data-topbar]')!;
      const composer = container.querySelector('[data-composer]') as HTMLButtonElement;
      const select = (pointerId: number): void => {
        firePointer(bubble, 'pointerdown', {
          pointerType: 'touch', pointerId, clientX: 20, clientY: 20,
        });
        act(() => vi.advanceTimersByTime(480));
        expect(document.querySelector('.chat-copy-callout')).toBeTruthy();
      };

      select(20);
      firePointer(topbar, 'pointerdown', {
        pointerType: 'touch', pointerId: 21, clientX: 20, clientY: 20,
      });
      firePointer(topbar, 'pointermove', {
        pointerType: 'touch', pointerId: 21, clientX: 20, clientY: 40,
      });
      firePointer(topbar, 'pointerup', {
        pointerType: 'touch', pointerId: 21, clientX: 20, clientY: 40,
      });
      fireEvent.click(topbar);
      expect(topbarClick).toHaveBeenCalledOnce();
      expect(document.querySelector('.chat-copy-callout')).toBeTruthy();

      const topbarUp = (() => {
        firePointer(topbar, 'pointerdown', {
          pointerType: 'touch', pointerId: 22, clientX: 20, clientY: 20,
        });
        return firePointer(topbar, 'pointerup', {
          pointerType: 'touch', pointerId: 22, clientX: 20, clientY: 20,
        });
      })();
      fireEvent.click(topbar);
      expect(topbarUp.defaultPrevented).toBe(false);
      expect(topbarClick).toHaveBeenCalledTimes(2);
      expect(document.querySelector('.chat-copy-callout')).toBeNull();

      select(23);
      firePointer(composer, 'pointerdown', {
        pointerType: 'touch', pointerId: 24, clientX: 20, clientY: 20,
      });
      const composerUp = firePointer(composer, 'pointerup', {
        pointerType: 'touch', pointerId: 24, clientX: 20, clientY: 20,
      });
      fireEvent.click(composer);
      composer.focus();
      expect(composerUp.defaultPrevented).toBe(false);
      expect(composerClick).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(composer);
      expect(document.querySelector('.chat-copy-callout')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures and clamps the localized copy callout instead of assuming a fixed width', () => {
    vi.useFakeTimers();
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, right: left + width, top, bottom: top + height, width, height,
      x: left, y: top, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(
      this: HTMLElement,
    ) {
      if (this.classList.contains('chat-copy-callout')) return rect(0, 0, 260, 40);
      if (this.classList.contains('chat-view') || this.classList.contains('chat-scroll')
        || this.classList.contains('chat-bubble')) return rect(10, 0, 300, 400);
      return rect(0, 0, 0, 0);
    });
    const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [rect(280, 100, 10, 20)] as unknown as DOMRectList,
    });
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'wide-callout', provisional: false,
          item: {
            id: 'wide-callout', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'alpha beta' }],
          },
        }],
      })} />);
      firePointer(container.querySelector('.chat-bubble')!, 'pointerdown', {
        pointerType: 'touch', pointerId: 6, clientX: 280, clientY: 100,
      });
      act(() => vi.advanceTimersByTime(480));
      const callout = document.querySelector('.chat-copy-callout') as HTMLElement;
      expect(callout.style.left).toBe('42px');
      expect(callout.style.maxWidth).toBe('284px');
    } finally {
      if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
      else Reflect.deleteProperty(Range.prototype, 'getClientRects');
      vi.useRealTimers();
    }
  });

  it('restores a precise selection after streaming DOM replacement and keeps it while scrolling', () => {
    vi.useFakeTimers();
    const item = (text: string) => ({
      key: 'streaming-answer', provisional: true,
      item: {
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
      },
    });
    try {
      const { container, rerender } = render(<AgentConversationView conversation={controller({
        items: [item('alpha beta')],
      })} />);
      const bubble = container.querySelector('.chat-bubble') as HTMLElement;
      fireEvent.pointerDown(bubble, { pointerType: 'touch', clientX: 40, clientY: 80 });
      act(() => vi.advanceTimersByTime(480));
      expect(document.getSelection()?.toString()).toBe('alpha');
      expect(screen.getByRole('button', { name: '整行' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '整段' })).toBeTruthy();

      fireEvent.scroll(container.querySelector('.chat-scroll')!);
      expect(document.getSelection()?.toString()).toBe('alpha');

      rerender(<AgentConversationView conversation={controller({
        items: [item('alpha beta, appended output')],
      })} />);
      expect(document.getSelection()?.toString()).toBe('alpha');
      expect(document.querySelectorAll('.chat-copy-handle')).toHaveLength(2);

      rerender(<AgentConversationView conversation={controller({
        items: [item('omega beta, appended output')],
      })} />);
      expect(document.querySelector('.chat-copy-callout')).toBeNull();
      expect(document.getSelection()?.toString()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets either handle cross the fixed endpoint and return without an off-by-one jump', () => {
    vi.useFakeTimers();
    const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'drag-answer', provisional: false,
          item: {
            id: 'drag-answer', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'one two three' }],
          },
        }],
      })} />);
      const bubble = container.querySelector('.chat-bubble') as HTMLElement;
      bubble.getBoundingClientRect = () => ({
        left: 0, right: 130, top: 0, bottom: 30, width: 130, height: 30,
        x: 0, y: 0, toJSON: () => ({}),
      });
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: (x: number) => ({
          offsetNode: bubble.querySelector('p')!.firstChild!, offset: Math.floor(x / 10),
        }),
      });
      firePointer(bubble, 'pointerdown', {
        pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 15,
      });
      act(() => vi.advanceTimersByTime(480));
      expect(document.getSelection()?.toString()).toBe('two');

      const start = document.querySelector('.chat-copy-handle[data-end="start"]')!;
      firePointer(start, 'pointerdown', {
        pointerType: 'touch', pointerId: 7, clientX: 40, clientY: 15,
      });
      firePointer(container.querySelector('.chat-view')!, 'pointermove', {
        pointerType: 'touch', pointerId: 7, clientX: 90, clientY: 15,
      });
      expect(document.getSelection()?.toString()).toBe(' th');
      firePointer(container.querySelector('.chat-view')!, 'pointermove', {
        pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 15,
      });
      expect(document.getSelection()?.toString()).toBe('wo');
      firePointer(container.querySelector('.chat-view')!, 'pointerup', {
        pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 15,
      });

      firePointer(container.querySelector('.chat-view')!, 'pointerdown', {
        pointerType: 'touch', pointerId: 9, clientX: 200, clientY: 200,
      });
      firePointer(container.querySelector('.chat-view')!, 'pointerup', {
        pointerType: 'touch', pointerId: 9, clientX: 200, clientY: 200,
      });
      firePointer(bubble, 'pointerdown', {
        pointerType: 'touch', pointerId: 2, clientX: 50, clientY: 15,
      });
      act(() => vi.advanceTimersByTime(480));
      expect(document.getSelection()?.toString()).toBe('two');
      const end = document.querySelector('.chat-copy-handle[data-end="end"]')!;
      firePointer(end, 'pointerdown', {
        pointerType: 'touch', pointerId: 8, clientX: 70, clientY: 15,
      });
      firePointer(container.querySelector('.chat-view')!, 'pointermove', {
        pointerType: 'touch', pointerId: 8, clientX: 10, clientY: 15,
      });
      expect(document.getSelection()?.toString()).toBe('ne ');
      firePointer(container.querySelector('.chat-view')!, 'pointermove', {
        pointerType: 'touch', pointerId: 8, clientX: 50, clientY: 15,
      });
      expect(document.getSelection()?.toString()).toBe('tw');
      firePointer(container.querySelector('.chat-view')!, 'pointerup', {
        pointerType: 'touch', pointerId: 8, clientX: 50, clientY: 15,
      });
    } finally {
      if (originalCaret) Object.defineProperty(document, 'caretPositionFromPoint', originalCaret);
      else Reflect.deleteProperty(document, 'caretPositionFromPoint');
      vi.useRealTimers();
    }
  });

  it('auto-scrolls the conversation while a selection handle stays at its edge', () => {
    vi.useFakeTimers();
    const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 17;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'scroll-select', provisional: false,
          item: {
            id: 'scroll-select', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'one two three' }],
          },
        }],
      })} />);
      const bubble = container.querySelector('.chat-bubble') as HTMLElement;
      const scroll = container.querySelector('.chat-scroll') as HTMLElement;
      bubble.getBoundingClientRect = () => ({
        left: 0, right: 130, top: 0, bottom: 300, width: 130, height: 300,
        x: 0, y: 0, toJSON: () => ({}),
      });
      scroll.getBoundingClientRect = () => ({
        left: 0, right: 130, top: 0, bottom: 100, width: 130, height: 100,
        x: 0, y: 0, toJSON: () => ({}),
      });
      Object.defineProperty(scroll, 'clientHeight', { value: 100, configurable: true });
      Object.defineProperty(scroll, 'scrollHeight', { value: 1_000, configurable: true });
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => ({ offsetNode: bubble.querySelector('p')!.firstChild!, offset: 5 }),
      });
      fireEvent.pointerDown(bubble, { pointerType: 'touch', clientX: 40, clientY: 40 });
      act(() => vi.advanceTimersByTime(480));

      const end = document.querySelector('.chat-copy-handle[data-end="end"]')!;
      fireEvent.pointerDown(end, { pointerType: 'touch', pointerId: 8, clientX: 40, clientY: 40 });
      const move = new Event('pointermove', { bubbles: true, cancelable: true });
      Object.assign(move, { pointerType: 'touch', pointerId: 8, clientX: 40, clientY: 96 });
      fireEvent(container.querySelector('.chat-view')!, move);
      expect(frame).not.toBeNull();
      act(() => { if (frame) (frame as FrameRequestCallback)(16); });
      expect(scroll.scrollTop).toBeGreaterThan(0);
      fireEvent.pointerUp(container.querySelector('.chat-view')!, {
        pointerType: 'touch', pointerId: 8, clientX: 40, clientY: 96,
      });
    } finally {
      if (originalCaret) Object.defineProperty(document, 'caretPositionFromPoint', originalCaret);
      else Reflect.deleteProperty(document, 'caretPositionFromPoint');
      vi.useRealTimers();
    }
  });

  it('swallows the link click produced by a long press', () => {
    vi.useFakeTimers();
    try {
      const onDocLinkTap = vi.fn();
      const { container } = render(<AgentConversationView onDocLinkTap={onDocLinkTap}
        conversation={controller({
          items: [{
            key: 'link-answer', provisional: false,
            item: {
              id: 'link-answer', sessionId: 'session-1', status: 'complete', kind: 'message',
              role: 'assistant', content: [{ type: 'text', text: '[Docs](https://example.com/guide)' }],
            },
          }],
        })} />);
      const link = container.querySelector('.chat-md a')!;
      fireEvent.pointerDown(link, { pointerType: 'touch', clientX: 40, clientY: 80 });
      act(() => vi.advanceTimersByTime(480));
      fireEvent.pointerUp(link, { pointerType: 'touch', clientX: 40, clientY: 80 });
      fireEvent.click(link);
      expect(onDocLinkTap).not.toHaveBeenCalled();
      expect(document.querySelector('.chat-copy-callout')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses an existing selection without opening a different Markdown link', () => {
    vi.useFakeTimers();
    try {
      const onDocLinkTap = vi.fn();
      const { container } = render(<AgentConversationView onDocLinkTap={onDocLinkTap}
        conversation={controller({
          items: [{
            key: 'two-links', provisional: false,
            item: {
              id: 'two-links', sessionId: 'session-1', status: 'complete', kind: 'message',
              role: 'assistant', content: [{ type: 'text', text:
                '[First](https://example.com/first) and [Second](https://example.com/second)' }],
            },
          }],
        })} />);
      const links = container.querySelectorAll('.chat-md a');
      firePointer(links[0]!, 'pointerdown', {
        pointerType: 'touch', pointerId: 40, clientX: 20, clientY: 20,
      });
      act(() => vi.advanceTimersByTime(480));
      firePointer(links[0]!, 'pointerup', {
        pointerType: 'touch', pointerId: 40, clientX: 20, clientY: 20,
      });
      fireEvent.click(links[0]!);
      expect(document.querySelector('.chat-copy-callout')).toBeTruthy();
      expect(onDocLinkTap).not.toHaveBeenCalled();

      firePointer(links[1]!, 'pointerdown', {
        pointerType: 'touch', pointerId: 41, clientX: 120, clientY: 20,
      });
      firePointer(links[1]!, 'pointerup', {
        pointerType: 'touch', pointerId: 41, clientX: 120, clientY: 20,
      });
      fireEvent.click(links[1]!);
      expect(document.querySelector('.chat-copy-callout')).toBeNull();
      expect(onDocLinkTap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses an existing selection without opening a different ToolChip', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'before-tool', provisional: false,
          item: {
            id: 'before-tool', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'select this text' }],
          },
        }, {
          key: 'tap-tool', provisional: false,
          item: {
            id: 'tap-tool', sessionId: 'session-1', status: 'complete', kind: 'tool_call',
            callId: 'tap-tool', name: 'exec_command', input: { cmd: 'pwd' },
          },
        }],
      })} />);
      const bubble = container.querySelector('.chat-bubble')!;
      const tool = container.querySelector('.chat-tool-head')!;
      firePointer(bubble, 'pointerdown', {
        pointerType: 'touch', pointerId: 42, clientX: 20, clientY: 20,
      });
      act(() => vi.advanceTimersByTime(480));
      firePointer(bubble, 'pointerup', {
        pointerType: 'touch', pointerId: 42, clientX: 20, clientY: 20,
      });
      fireEvent.click(bubble);
      expect(document.querySelector('.chat-copy-callout')).toBeTruthy();

      firePointer(tool, 'pointerdown', {
        pointerType: 'touch', pointerId: 43, clientX: 20, clientY: 80,
      });
      firePointer(tool, 'pointerup', {
        pointerType: 'touch', pointerId: 43, clientX: 20, clientY: 80,
      });
      fireEvent.click(tool);
      expect(document.querySelector('.chat-copy-callout')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending long press when the conversation session changes', () => {
    vi.useFakeTimers();
    try {
      const initial = controller({
        items: [{
          key: 'old-error', provisional: false,
          item: {
            id: 'old-error', sessionId: 'session-1', status: 'complete', kind: 'notice',
            level: 'error', message: '旧会话错误',
          },
        }],
      });
      const { container, rerender } = render(<AgentConversationView conversation={initial} />);
      const oldError = container.querySelector('.chat-turn-error') as HTMLElement;
      Object.defineProperty(oldError, 'innerText', { value: '旧会话错误', configurable: true });
      fireEvent.pointerDown(oldError, { pointerType: 'touch', clientX: 80, clientY: 100 });

      rerender(<AgentConversationView conversation={{
        ...initial,
        descriptor: {
          ...initial.descriptor!,
          session: { ...initial.descriptor!.session, sessionId: 'session-2' },
        },
        items: [],
      }} />);
      act(() => vi.advanceTimersByTime(500));

      expect(container.querySelector('.chat-copy-callout')).toBeNull();
      expect(container.querySelector('.chat-view')?.classList.contains('chat-copy-active')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies the standalone non-retrying connection error through the shared callout', () => {
    vi.useFakeTimers();
    try {
      const standalone = render(<AgentConversationErrorView message="Agent 连接失败" resetKey="pane-1" />);
      const connectionError = standalone.container.querySelector('.chat-turn-error') as HTMLElement;
      Object.defineProperty(connectionError, 'innerText', { value: 'Agent 连接失败', configurable: true });
      fireEvent.pointerDown(connectionError, { pointerType: 'touch', clientX: 80, clientY: 100 });
      act(() => vi.advanceTimersByTime(480));
      expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves every conversation error surface without regressing bubble or tool copy targets', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="chat-bubble" data-conversation-copy-root data-conversation-copy-id="bubble"><span id="bubble">bubble</span></div>
      <div class="chat-tool" data-conversation-copy-root data-conversation-copy-id="tool"><span id="tool">tool</span></div>
      <small class="agent-conversation-item-error" data-conversation-copy-root data-conversation-copy-id="item-error" id="item-error">attachment failed</small>
      <button class="chat-history-retry" data-conversation-copy-root data-conversation-copy-id="history-error" id="history-error">history failed</button>
      <div class="agent-conversation-empty is-error" data-conversation-copy-root data-conversation-copy-id="empty-error" id="empty-error">unavailable</div>
    `;
    document.body.append(host);
    const target = (id: string): HTMLElement => host.querySelector(`#${id}`) as HTMLElement;

    expect(resolveConversationCopyBlock(target('bubble'))?.el.classList.contains('chat-bubble')).toBe(true);
    expect(resolveConversationCopyBlock(target('tool'))?.el.classList.contains('chat-tool')).toBe(true);
    expect(resolveConversationCopyBlock(target('item-error'))?.el).toBe(target('item-error'));
    expect(resolveConversationCopyBlock(target('history-error'))?.el).toBe(target('history-error'));
    expect(resolveConversationCopyBlock(target('empty-error'))?.el).toBe(target('empty-error'));
    host.remove();
  });

  it('copies signs but not line numbers across rows from the actual expanded diff DOM', () => {
    const { container } = render(<ToolSheet running={false} onClose={() => {}} copyId="diff-tool"
      tool={{
        name: 'apply_patch', input: { file_path: '/work/file.ts' }, result: 'Done!',
        isError: false, outcome: 'success',
        diff: {
          added: 1, removed: 1,
          hunks: [{ oldStart: 7, newStart: 9, lines: ['-old value', '+new value'] }],
        },
      }} />);
    const diff = container.querySelector('.dv') as HTMLElement;
    const map = conversationTextMap(diff);
    expect(map.text).toBe('-old value\n+new value\n');
    const range = domRangeForOffsets(diff, {
      start: 0,
      end: map.text.lastIndexOf('\n'),
    }, map)!;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selection.toString()).toBe('-old value\n+new value');
    expect(copyTextForRange(range)).toBe(selection.toString());
    expect(selection.toString()).not.toMatch(/7|9|10/);
  });

  it('treats sign-only rows as paragraph breaks in collapsed and detailed diff DOM', () => {
    const tool = {
      name: 'apply_patch', input: { file_path: '/work/file.ts' }, result: 'Done!',
      isError: false, outcome: 'success' as const,
      diff: {
        added: 2, removed: 2,
        hunks: [{ oldStart: 1, newStart: 1, lines: ['-removed', '-', '+', '+added'] }],
      },
    };
    const { container } = render(<>
      <ToolBody tool={tool} copyId="collapsed-diff" />
      <ToolSheet tool={tool} running={false} onClose={() => {}} copyId="detailed-diff" />
    </>);
    const roots = [
      container.querySelector('.chat-diff') as HTMLElement,
      container.querySelector('.dv') as HTMLElement,
    ];
    for (const root of roots) {
      const map = conversationTextMap(root);
      const removed = map.text.indexOf('-removed');
      const added = map.text.indexOf('+added');
      const removedRange = paragraphRange(root, { start: removed + 2, end: removed + 3 }, map);
      const addedRange = paragraphRange(root, { start: added + 2, end: added + 3 }, map);
      expect(map.text.slice(removedRange.start, removedRange.end)).toBe('-removed');
      expect(map.text.slice(addedRange.start, addedRange.end)).toBe('+added');
    }
  });

  it('refreshes and clips selection controls against an inner tool scroller', () => {
    vi.useFakeTimers();
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, right: left + width, top, bottom: top + height, width, height,
      x: left, y: top, toJSON: () => ({}),
    });
    let characterTop = 280;
    const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [rect(40, characterTop, 8, 18)] as unknown as DOMRectList,
    });
    const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'scrolling-diff', provisional: false,
          item: {
            id: 'scrolling-diff', sessionId: 'session-1', status: 'complete',
            kind: 'tool_call', callId: 'scrolling-diff', name: 'apply_patch',
            extensions: { 'conversation.tool': {
              name: 'apply_patch', input: { file_path: '/work/file.ts' }, result: 'Done!',
              isError: false, outcome: 'success',
              diff: {
                added: 1, removed: 1,
                hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }],
              },
            } },
          },
        }],
      })} />);
      fireEvent.click(container.querySelector('.chat-tool-head')!);
      const view = container.querySelector('.chat-view') as HTMLElement;
      const transcript = container.querySelector('.chat-scroll') as HTMLElement;
      const sheet = container.querySelector('.tool-sheet') as HTMLElement;
      const sheetBody = container.querySelector('.tool-sheet-body') as HTMLElement;
      const inner = container.querySelector('.es-diff') as HTMLElement;
      const diff = container.querySelector('.dv') as HTMLElement;
      view.getBoundingClientRect = () => rect(0, 0, 300, 400);
      transcript.getBoundingClientRect = () => rect(0, 0, 300, 80);
      sheet.getBoundingClientRect = () => rect(0, 100, 300, 300);
      sheetBody.getBoundingClientRect = () => rect(10, 110, 240, 280);
      inner.getBoundingClientRect = () => rect(20, 150, 200, 200);
      diff.getBoundingClientRect = () => rect(20, 120, 200, 260);
      const hitText = diff.querySelector('.dv-code')!.firstChild!;
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => ({ offsetNode: hitText, offset: 1 }),
      });

      firePointer(hitText.parentElement!, 'pointerdown', {
        pointerType: 'touch', pointerId: 12, clientX: 44, clientY: 280,
      });
      act(() => vi.advanceTimersByTime(480));
      const start = document.querySelector('.chat-copy-handle[data-end="start"]') as HTMLElement;
      expect(start.style.visibility).toBe('visible');
      expect(start.style.top).toBe('280px');

      characterTop = 120;
      fireEvent.scroll(inner);
      expect(start.style.visibility).toBe('hidden');
      expect(start.style.top).toBe('120px');
      characterTop = 180;
      fireEvent.scroll(inner);
      expect(start.style.visibility).toBe('visible');
      expect(start.style.top).toBe('180px');
    } finally {
      if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
      else Reflect.deleteProperty(Range.prototype, 'getClientRects');
      if (originalCaret) Object.defineProperty(document, 'caretPositionFromPoint', originalCaret);
      else Reflect.deleteProperty(document, 'caretPositionFromPoint');
      vi.useRealTimers();
    }
  });

  it('auto-scrolls a vertical tool ancestor instead of a horizontal-only copy root or transcript', () => {
    vi.useFakeTimers();
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, right: left + width, top, bottom: top + height, width, height,
      x: left, y: top, toJSON: () => ({}),
    });
    const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [rect(40, 300, 8, 18)] as unknown as DOMRectList,
    });
    const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 31;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { container } = render(<AgentConversationView conversation={controller({
        items: [{
          key: 'wide-command', provisional: false,
          item: {
            id: 'wide-command', sessionId: 'session-1', status: 'complete',
            kind: 'tool_call', callId: 'wide-command', name: 'exec_command',
            input: { cmd: 'alpha beta gamma' },
          },
        }],
      })} />);
      fireEvent.click(container.querySelector('.chat-tool-head')!);
      const view = container.querySelector('.chat-view') as HTMLElement;
      const transcript = container.querySelector('.chat-scroll') as HTMLElement;
      const sheet = container.querySelector('.tool-sheet') as HTMLElement;
      const body = container.querySelector('.tool-sheet-body') as HTMLElement;
      const command = container.querySelector('.tool-sheet-cmd') as HTMLElement;
      view.getBoundingClientRect = () => rect(0, 0, 300, 400);
      transcript.getBoundingClientRect = () => rect(0, 0, 300, 80);
      sheet.getBoundingClientRect = () => rect(0, 100, 300, 300);
      body.getBoundingClientRect = () => rect(10, 100, 280, 250);
      command.getBoundingClientRect = () => rect(20, 270, 240, 60);
      Object.defineProperties(command, {
        clientHeight: { value: 60, configurable: true },
        scrollHeight: { value: 60, configurable: true },
        clientWidth: { value: 240, configurable: true },
        scrollWidth: { value: 800, configurable: true },
      });
      Object.defineProperties(body, {
        clientHeight: { value: 250, configurable: true },
        scrollHeight: { value: 1_000, configurable: true },
      });
      Object.defineProperties(transcript, {
        clientHeight: { value: 80, configurable: true },
        scrollHeight: { value: 1_000, configurable: true },
      });
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => ({ offsetNode: command.firstChild!, offset: 2 }),
      });

      firePointer(command, 'pointerdown', {
        pointerType: 'touch', pointerId: 30, clientX: 44, clientY: 300,
      });
      act(() => vi.advanceTimersByTime(480));
      const end = document.querySelector('.chat-copy-handle[data-end="end"]')!;
      firePointer(end, 'pointerdown', {
        pointerType: 'touch', pointerId: 31, clientX: 44, clientY: 300,
      });
      firePointer(view, 'pointermove', {
        pointerType: 'touch', pointerId: 31, clientX: 44, clientY: 345,
      });
      expect(frame).not.toBeNull();
      act(() => { if (frame) (frame as FrameRequestCallback)(16); });
      expect(body.scrollTop).toBeGreaterThan(0);
      expect(command.scrollTop).toBe(0);
      expect(transcript.scrollTop).toBe(0);
      firePointer(view, 'pointerup', {
        pointerType: 'touch', pointerId: 31, clientX: 44, clientY: 345,
      });
    } finally {
      if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
      else Reflect.deleteProperty(Range.prototype, 'getClientRects');
      if (originalCaret) Object.defineProperty(document, 'caretPositionFromPoint', originalCaret);
      else Reflect.deleteProperty(document, 'caretPositionFromPoint');
      vi.useRealTimers();
    }
  });

  it('offers an explicit confirmed resend only when an uncertain send remains unresolved', async () => {
    const retryOutgoing = vi.fn(async (id: string) => id === 'unknown-send');
    const resendOutgoing = vi.fn(async () => {});
    const outgoing = (key: string, status: 'failed' | 'unknown') => ({
      key, provisional: true, live: true,
      item: {
        kind: 'message' as const, role: 'user' as const,
        content: [{ type: 'text' as const, text: `保留的消息 ${status}` }],
      },
      outgoing: { clientRequestId: key, text: `保留的消息 ${status}`, status },
    });
    const { container } = render(<AgentConversationView conversation={controller({
      items: [outgoing('failed-send', 'failed'), outgoing('unknown-send', 'unknown')],
      retryOutgoing, resendOutgoing,
    })} />);

    expect(container.querySelectorAll('.chat-turn-error')).toHaveLength(0);
    expect(container.querySelectorAll('.chat-optimistic-state')).toHaveLength(2);
    expect(container.querySelector('.chat-typing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '查询状态' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(screen.getByText('这条消息可能已经发送。继续会作为一条新消息再次发送，可能导致任务重复执行。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '仍然发送' }));
    await waitFor(() => expect(resendOutgoing).toHaveBeenCalledWith('unknown-send'));
    expect(retryOutgoing).toHaveBeenNthCalledWith(1, 'failed-send');
    expect(retryOutgoing).toHaveBeenNthCalledWith(2, 'unknown-send');
  });

  it('does not offer another send when the status query resolves the uncertainty', async () => {
    const retryOutgoing = vi.fn(async () => false);
    render(<AgentConversationView conversation={controller({
      items: [{
        key: 'unknown-send', provisional: true, live: true,
        item: {
          kind: 'message', role: 'user',
          content: [{ type: 'text', text: 'already resolved' }],
        },
        outgoing: {
          clientRequestId: 'unknown-send', text: 'already resolved', status: 'unknown',
        },
      }],
      retryOutgoing,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: '查询状态' }));
    await waitFor(() => expect(retryOutgoing).toHaveBeenCalledWith('unknown-send'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders normalized Plan history after its answer and opens the shared detail sheet', () => {
    const { container } = render(<AgentConversationView conversation={controller({
      items: [
        {
          key: 'plan', provisional: false,
          item: {
            id: 'plan', sessionId: 'session-1', status: 'complete', kind: 'notice',
            level: 'info', code: 'plan_updated', message: '完成实现', correlationId: 'turn-plan',
            extensions: { 'conversation.plan': [
              { step: '确认协议', status: 'completed' },
              { step: '实现界面', status: 'completed' },
            ] },
          },
        },
        {
          key: 'answer', provisional: false,
          item: {
            id: 'answer', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', correlationId: 'turn-plan',
            content: [{ type: 'text', text: '已经完成。' }],
          },
        },
      ],
    })} />);
    const summary = screen.getByRole('button', { name: /本轮任务.*2\/2/ });
    const answer = screen.getByText('已经完成。');
    expect(answer.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(summary);
    const sheet = screen.getByRole('dialog', { name: '本轮任务' });
    expect(sheet.textContent).toContain('确认协议');
    expect(sheet.textContent).toContain('实现界面');
  });

  it('renders normalized Goal history and opens its existing detail sheet', async () => {
    const goal = {
      objective: '完成统一对话页面', status: 'complete' as const,
      createdAt: 10, updatedAt: 20, tokensUsed: 500, timeUsedSeconds: 12,
    };
    const goalConversation = controller({
      descriptor: {
        session: { agentId: 'third-party-agent', sessionId: 'session-1' },
        run: { agentId: 'third-party-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
        viewId: 'view-1', historyVersion: 'history-1',
        capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
      },
      items: [{
        key: 'goal', provisional: false,
        item: {
          id: 'goal', sessionId: 'session-1', status: 'complete', kind: 'notice',
          level: 'info', code: 'goal_updated', message: goal.objective,
          extensions: { 'conversation.goal': goal, 'conversation.goalEvent': 'complete' },
        },
      }],
    });
    expect(projectConversationMessages(goalConversation.items)).toHaveLength(1);
    render(<AgentConversationView conversation={goalConversation} />);

    fireEvent.click(screen.getByRole('button', { name: /目标已完成.*完成统一对话页面/ }));
    const sheet = await screen.findByRole('dialog', { name: '任务目标' });
    expect(sheet.textContent).toContain('完成统一对话页面');
    expect(sheet.textContent).toContain('Token 500');
  });

  it('shows a compact friendly terminal state without raw connection details', () => {
    const { container, rerender } = render(<AgentConversationView conversation={controller({
      status: 'error', error: '/api/agents/conversation/page -> 404', descriptor: null,
    })} />);

    expect(container.querySelectorAll('.agent-conversation-state')).toHaveLength(1);
    expect(container.querySelector('.agent-conversation-empty')).toBeNull();
    expect(container.querySelector('.chat-scroll')).toBeNull();
    expect(container.querySelectorAll('.agent-conversation-reconnecting')).toHaveLength(1);
    expect(container.querySelector('.lens-boot')).toBeNull();
    expect(container.textContent).toContain('无法连接对话');
    expect(container.textContent).not.toContain('/api/agents');

    rerender(<AgentConversationView conversation={controller({
      status: 'reconnecting', error: null, descriptor: null,
    })} />);
    expect(container.querySelectorAll('.agent-conversation-state')).toHaveLength(1);
    expect(container.querySelector('.agent-conversation-empty')).toBeNull();
    expect(container.querySelectorAll('.agent-conversation-reconnecting')).toHaveLength(1);
  });

  it('keeps LensBoot and Composer during a first timeout without exposing the timeout text', () => {
    const timedOut = controller({
      status: 'loading', canonicalReady: false, error: null, descriptor: null,
    });
    const { container } = render(<>
      <AgentConversationView conversation={timedOut} />
      <AgentConversationComposer agentId="pi" sessionId="first-timeout" busy={false}
        conversation={timedOut} />
    </>);

    expect(container.querySelector('.lens-boot')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect((container.querySelector('button.cc-send') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.agent-conversation-empty.is-error')).toBeNull();
    expect(container.textContent).not.toContain('timeout');
  });

  it('keeps existing history with only the compact reconnect pill after a timeout', () => {
    const { container } = render(<AgentConversationView conversation={controller({
      status: 'reconnecting', canonicalReady: true, error: 'stream timeout',
      items: [{
        key: 'durable-1', provisional: false,
        item: {
          id: 'durable-1', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: '保留已有历史' }],
        },
      }],
    })} />);

    expect(screen.getByText('保留已有历史')).toBeTruthy();
    expect(container.querySelectorAll('.agent-conversation-reconnecting')).toHaveLength(1);
    expect(container.querySelector('.agent-conversation-empty.is-error')).toBeNull();
    expect(container.textContent).not.toContain('stream timeout');
  });

  it('keeps one canonical loading surface regardless of activity or stale session content', () => {
    const staleItems = [{
      key: 'old-user', provisional: false,
      item: {
        id: 'old-user', sessionId: 'session-old', status: 'complete' as const,
        kind: 'message' as const, role: 'user' as const,
        content: [{ type: 'text' as const, text: '旧会话消息' }],
      },
    }, {
      key: 'old-outgoing', provisional: true,
      item: {
        kind: 'message' as const, role: 'user' as const,
        content: [{ type: 'text' as const, text: '旧发送消息' }],
      },
      outgoing: {
        clientRequestId: 'old-outgoing', text: '旧发送消息', status: 'accepted' as const,
      },
    }];
    const loading = controller({
      status: 'loading', canonicalReady: false,
      descriptor: {
        ...controller().descriptor!,
        session: { agentId: 'claude', sessionId: 'session-new' },
      },
      items: staleItems,
    });
    const view = render(<AgentConversationView conversation={loading} working activity="working" />);

    expect(view.container.querySelector('.agent-conversation-state')).toBeTruthy();
    expect(view.container.querySelector('.chat-scroll')).toBeNull();
    expect(view.container.textContent).not.toContain('旧会话消息');
    expect(view.container.textContent).not.toContain('旧发送消息');
    expect(view.container.querySelector('.chat-typing')).toBeNull();

    view.rerender(<AgentConversationView conversation={{
      ...loading, status: 'reconnecting',
      descriptor: {
        ...loading.descriptor!, session: { agentId: 'pi', sessionId: 'session-other' },
      },
    }} activity="compacting" />);
    expect(view.container.querySelector('.agent-conversation-state')).toBeTruthy();
    expect(view.container.querySelector('.chat-scroll')).toBeNull();
    expect(view.container.querySelector('.chat-compacting')).toBeNull();
    expect(view.container.querySelector('.agent-conversation-reconnecting')).toBeNull();
  });

  it('hides a compaction summary behind the shared half-sheet disclosure', () => {
    const summary = '## Pi 保留摘要\n\n继续检查实现。';
    const conversation = controller({
      items: [{
        key: 'compact', provisional: false,
        item: {
          id: 'item-compact', sessionId: 'session-1', status: 'complete',
          kind: 'compaction', summary,
        },
      }],
    });
    const { container } = render(<AgentConversationView conversation={conversation} />);

    expect(container.textContent).not.toContain('继续检查实现');
    fireEvent.click(screen.getByRole('button', { name: /上下文已压缩.*查看详情/ }));
    expect(screen.getByRole('dialog', { name: '上下文压缩' })).toBeTruthy();
    expect(document.querySelector('.compaction-detail-body pre')?.textContent).toBe(summary);
  });

  it('projects normalized durable and provisional item kinds without provider-specific data', () => {
    const conversation = controller({
      items: [
        {
          key: 'message', provisional: false,
          item: {
            id: 'item-1', sessionId: 'session-1', status: 'complete', kind: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Pi' }],
          },
        },
        {
          key: 'tool', provisional: false,
          item: {
            id: 'item-2', sessionId: 'session-1', status: 'complete', kind: 'tool_call',
            callId: 'call-1', name: 'bash', input: { command: 'pwd' },
          },
        },
        {
          key: 'live', provisional: true,
          item: { kind: 'reasoning_summary', text: 'Checking the workspace' },
        },
      ],
    });

    const { container } = render(<AgentConversationView conversation={conversation} />);
    expect(screen.getByText('Hello from Pi')).toBeTruthy();
    expect(screen.getByText('调用工具 bash')).toBeTruthy();
    expect(screen.queryByText(/Checking the workspace/)).toBeNull();
    expect(container.querySelector('.chat-typing')).toBeTruthy();
  });

  it('renders assistant GFM tables while keeping user input literal', () => {
    const markdown = [
      '| Name | State |',
      '| --- | --- |',
      '| Pi | Ready |',
    ].join('\n');
    const conversation = controller({
      items: [
        {
          key: 'assistant-table', provisional: false,
          item: {
            id: 'assistant-table', sessionId: 'session-1', status: 'complete',
            kind: 'message', role: 'assistant', content: [{ type: 'text', text: markdown }],
          },
        },
        {
          key: 'user-table', provisional: false,
          item: {
            id: 'user-table', sessionId: 'session-1', status: 'complete',
            kind: 'message', role: 'user', content: [{ type: 'text', text: markdown }],
          },
        },
      ],
    });

    const { container } = render(<AgentConversationView conversation={conversation} />);
    const assistant = container.querySelector('.chat-them')!;
    expect(assistant.querySelectorAll('table')).toHaveLength(1);
    expect(Array.from(assistant.querySelectorAll('th')).map((cell) => cell.textContent))
      .toEqual(['Name', 'State']);
    expect(Array.from(assistant.querySelectorAll('td')).map((cell) => cell.textContent))
      .toEqual(['Pi', 'Ready']);
    expect(container.querySelector('.chat-me table')).toBeNull();
    expect(container.querySelector('.chat-me')?.textContent).toContain('| Name | State |');
  });

  it('routes sanitized Markdown links through the shared delegated handler', () => {
    const conversation = controller({
      items: [{
        key: 'assistant-links', provisional: false,
        item: {
          id: 'assistant-links', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'assistant', content: [{ type: 'text', text:
            '[Docs](https://example.com/guide) ![Plot](https://example.com/plot.png)' }],
        },
      }],
    });

    const onDocLinkTap = vi.fn();
    const { container } = render(<AgentConversationView conversation={conversation}
      onDocLinkTap={onDocLinkTap} />);
    const assistant = container.querySelector('.chat-them')!;
    const link = assistant.querySelector('a')!;
    expect(link.textContent).toBe('Docs');
    expect(assistant.querySelector('img')?.getAttribute('src')).toBe('https://example.com/plot.png');
    fireEvent.click(link, { clientX: 12, clientY: 18 });
    expect(onDocLinkTap).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'url', raw: 'https://example.com/guide',
    }), 12, 18);
  });

  it('sanitizes executable Markdown HTML and unsafe destinations', () => {
    const conversation = controller({
      items: [{
        key: 'assistant-xss', provisional: false,
        item: {
          id: 'assistant-xss', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'assistant', content: [{ type: 'text', text: [
            '<script>globalThis.__xss = true</script>',
            '<img src="https://example.com/x.png" onerror="globalThis.__xss = true" alt="Safe alt">',
            '[Unsafe](javascript:globalThis.__xss=true)',
          ].join('\n') }],
        },
      }],
    });

    const { container } = render(<AgentConversationView conversation={conversation} />);
    const assistant = container.querySelector('.chat-them')!;
    expect(assistant.querySelector('script, a')).toBeNull();
    expect(assistant.querySelector('img')?.getAttribute('src')).toBe('https://example.com/x.png');
    expect(assistant.innerHTML).not.toContain('onerror');
    expect(assistant.innerHTML).not.toContain('href=');
    expect(assistant.textContent).toContain('Unsafe');
  });

  it('downloads an opaque resource through the authenticated Conversation facade', async () => {
    const conversation = controller({
      items: [{
        key: 'resource', provisional: false,
        item: {
          id: 'item-resource', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'assistant', content: [{
            type: 'resource', resourceId: 'opaque-resource-id-0001', name: 'result.txt',
          }],
        },
      }],
    });
    render(<AgentConversationView conversation={conversation} />);
    fireEvent.click(screen.getByRole('button', { name: 'result.txt' }));
    await waitFor(() => expect(conversation.downloadResource).toHaveBeenCalledWith({
      type: 'resource', resourceId: 'opaque-resource-id-0001', name: 'result.txt',
    }));
  });

  it('keeps projected-empty orphan results pageable instead of stranding a blank view', async () => {
    const loadOlder = vi.fn(async () => {});
    const conversation = controller({
      hasMore: true,
      loadOlder,
      items: [{
        key: 'result-first', provisional: false,
        item: {
          id: 'result-first', sessionId: 'session-1', status: 'complete',
          kind: 'tool_result', callId: 'call-on-older-page',
          content: [{ type: 'text', text: 'latent result' }],
        },
      }],
    });
    const { container } = render(<AgentConversationView conversation={conversation} />);
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;

    expect(scroll).toBeTruthy();
    expect(container.textContent).not.toContain('latent result');
    await act(async () => {
      fireEvent.wheel(scroll, { deltaY: -20 });
      await Promise.resolve();
    });
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  it('uses the shared working state when no provider provisional item exists', () => {
    const createdAt = new Date(2026, 7, 29, 9, 7).getTime();
    const message = (key: string, role: 'user' | 'assistant', text: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const, sourceCreatedAt: createdAt,
        kind: 'message' as const, role, content: [{ type: 'text' as const, text }],
      },
    });
    const { container } = render(<AgentConversationView working conversation={controller({
      items: [message('user-working', 'user', '继续'), message('assistant-working', 'assistant', '阶段结果')],
    })} />);

    expect(container.querySelector('.chat-typing')).toBeTruthy();
    expect(container.querySelector('[data-completed-entry-key="user-working"] .chat-ts')).toBeTruthy();
    expect(container.querySelector('[data-completed-entry-key="assistant-working"] .chat-ts')).toBeNull();
  });

  it('renders live compaction as one public status row without inline compact content', () => {
    const { container } = render(<AgentConversationView activity="compacting"
      conversation={controller()} />);
    expect(container.querySelector('.chat-compacting')?.textContent).toContain('正在压缩上下文');
    expect(container.querySelector('.chat-compacting .chat-typing-dots')).toBeTruthy();
    expect(container.querySelector('.chat-typing')).toBeNull();
  });

  it('keeps an open tool sheet live and lets one Back action close only that sheet', async () => {
    const call = (provisional: boolean) => ({
      key: 'live-tool', provisional,
      item: provisional ? {
        kind: 'tool_call' as const, callId: 'live-call', name: 'exec_command',
        input: { cmd: 'printf ready' },
      } : {
        id: 'live-tool', sessionId: 'session-1', status: 'complete' as const,
        kind: 'tool_call' as const, callId: 'live-call', name: 'exec_command',
        input: { cmd: 'printf ready' },
      },
    });
    const initial = controller({ items: [call(true)] });
    const { container, rerender } = render(<AgentConversationView conversation={initial} />);
    expect(container.querySelector('.chat-tool-head')?.hasAttribute('data-conversation-copy-root')).toBe(true);
    fireEvent.click(container.querySelector('.chat-tool-head')!);
    expect(screen.getByRole('dialog').textContent).toContain('执行中');
    expect(container.querySelector<HTMLElement>('.tool-sheet-cmd')?.dataset.conversationCopyId)
      .toContain(':input');

    rerender(<AgentConversationView conversation={controller({
      items: [call(false), {
        key: 'live-result', provisional: false,
        item: {
          id: 'live-result', sessionId: 'session-1', status: 'complete',
          kind: 'tool_result', callId: 'live-call',
          content: [{ type: 'text', text: 'ready from settled result' }],
        },
      }],
    })} />);
    expect(screen.getByRole('dialog').textContent).toContain('ready from settled result');
    expect(container.querySelector<HTMLElement>('.chat-tool-body')?.dataset.conversationCopyId)
      .toContain(':output');

    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.querySelector('.chat-scroll')).toBeTruthy();
  });

  it('keeps the reading position when an older page is prepended', () => {
    const current = {
      key: 'current', provisional: false,
      item: {
        id: 'current', sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'current message' }],
      },
    };
    const older = {
      key: 'older', provisional: false,
      item: {
        id: 'older', sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'older message' }],
      },
    };
    const first = controller({
      items: [current], hasMore: true, loadOlder: vi.fn(() => new Promise<void>(() => {})),
    });
    const { container, rerender } = render(<AgentConversationView conversation={first} />);
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 600, configurable: true });
    const anchor = screen.getByText('current message').closest('.chat-entry-row') as HTMLElement;
    let anchorTop = 100;
    anchor.getBoundingClientRect = () => ({
      top: anchorTop, bottom: anchorTop + 30, left: 0, right: 100,
      width: 100, height: 30, x: 0, y: anchorTop, toJSON: () => ({}),
    });
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(first.loadOlder).toHaveBeenCalledOnce();

    anchorTop = 350;
    Object.defineProperty(scroll, 'scrollHeight', { value: 850, configurable: true });
    rerender(<AgentConversationView conversation={{
      ...first, items: [older, current], hasMore: false,
    }} />);

    expect(scroll.scrollTop).toBe(250);
  });

  it('drops an older-page scroll anchor when the conversation is replaced', () => {
    const item = (key: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: key }],
      },
    });
    const first = controller({
      items: [item('shared')], hasMore: true, loadOlder: vi.fn(() => new Promise<void>(() => {})),
    });
    const { container, rerender } = render(<AgentConversationView conversation={first} />);
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;
    Object.defineProperty(scroll, 'scrollHeight', { value: 600, configurable: true });
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(first.loadOlder).toHaveBeenCalledOnce();

    Object.defineProperty(scroll, 'scrollHeight', { value: 800, configurable: true });
    rerender(<AgentConversationView conversation={controller({ items: [item('other')] })} />);
    expect(scroll.scrollTop).toBe(0);

    Object.defineProperty(scroll, 'scrollHeight', { value: 1_000, configurable: true });
    rerender(<AgentConversationView conversation={controller({
      items: [item('newer'), item('shared')],
    })} />);
    expect(scroll.scrollTop).toBe(0);
  });

  it('keeps generic live updates from taking a reader viewport until explicitly requested', () => {
    const item = (key: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: key }],
      },
    });
    const first = controller({ items: [item('current')] });
    const { container, rerender } = render(<AgentConversationView conversation={first} />);
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 1_000, configurable: true });
    scroll.scrollTop = 700;
    fireEvent.scroll(scroll);
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    expect(container.querySelector('.new-output')).toBeNull();

    Object.defineProperty(scroll, 'scrollHeight', { value: 1_200, configurable: true });
    rerender(<AgentConversationView conversation={{ ...first, items: [item('current'), item('live')] }} />);
    expect(scroll.scrollTop).toBe(680);
    expect(container.querySelector('.new-output')).toBeTruthy();

    rerender(<AgentConversationView followLatestRequest={1}
      conversation={{ ...first, items: [item('current'), item('live')] }} />);
    expect(scroll.scrollTop).toBe(1_200);
  });

  it('opens a completed generic turn at its final assistant text and positions it only once', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(
      this: HTMLElement,
    ) {
      if (this.classList.contains('chat-scroll')) {
        return { top: 100, bottom: 400, height: 300 } as DOMRect;
      }
      if (this.classList.contains('chat-entry-row')) {
        const tops: Record<string, number> = {
          user: 160, intermediate: 220, tool: 260, final: 300, later: 360,
        };
        const top = tops[this.dataset.completedEntryKey ?? ''] ?? 160;
        return { top, bottom: top + 60, height: 60 } as DOMRect;
      }
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    const item = (key: string, role: 'user' | 'assistant', text: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role, content: [{ type: 'text' as const, text }],
      },
    });
    const user = item('user', 'user', '最后一个问题');
    const intermediate = item('intermediate', 'assistant', '中间回复');
    const tool = {
      key: 'tool', provisional: false,
      item: {
        id: 'tool', sessionId: 'session-1', status: 'complete' as const,
        kind: 'tool_call' as const, callId: 'call-1', name: 'read',
        input: { path: 'README.md' },
      },
    };
    const final = item('final', 'assistant', '最终回复开头');
    const later = item('later', 'assistant', '迟到内容');
    const consumed = vi.fn();
    const first = controller({
      items: [user, intermediate, tool, final],
      loadLatest: vi.fn(async () => {}),
    });
    const { container, rerender } = render(<AgentConversationView conversation={first}
      completedEntryRequest={3} onCompletedEntryConsumed={consumed} />);

    await waitFor(() => expect(consumed).toHaveBeenCalledWith(3));
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;
    expect(scroll.scrollTop).toBe(188);
    rerender(<AgentConversationView conversation={{
      ...first, items: [user, intermediate, tool, final, later],
    }}
      completedEntryRequest={3} onCompletedEntryConsumed={consumed} />);
    expect(scroll.scrollTop).toBe(188);
    expect(consumed).toHaveBeenCalledOnce();
  });

  it('falls back when a completed entry has no authoritative latest reader', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const final = {
      key: 'final', provisional: false,
      item: {
        id: 'final', sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'must not be treated as refreshed' }],
      },
    };
    const consumed = vi.fn();
    const { container } = render(<AgentConversationView conversation={controller({ items: [final] })}
      completedEntryRequest={8} onCompletedEntryConsumed={consumed} />);

    await waitFor(() => expect(consumed).toHaveBeenCalledWith(8));
    expect((container.querySelector('.chat-scroll') as HTMLDivElement).scrollTop).toBe(1000);
  });

  it('waits for an existing latest read before positioning a completed entry', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(
      this: HTMLElement,
    ) {
      if (this.classList.contains('chat-scroll')) {
        return { top: 100, bottom: 400, height: 300 } as DOMRect;
      }
      if (this.classList.contains('chat-entry-row')) {
        const top = this.dataset.completedEntryKey === 'final' ? 300 : 160;
        return { top, bottom: top + 60, height: 60 } as DOMRect;
      }
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    const existingRead = deferred();
    const forcedRead = deferred();
    const loadLatest = vi.fn((options?: { force?: boolean }) => (
      options?.force
        ? existingRead.promise.then(() => forcedRead.promise)
        : existingRead.promise
    ));
    const existingLatest = loadLatest();
    const item = (key: string, role: 'user' | 'assistant') => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role, content: [{ type: 'text' as const, text: key }],
      },
    });
    const oldUser = item('old-user', 'user');
    const oldAnswer = item('old-answer', 'assistant');
    const user = item('user', 'user');
    const final = item('final', 'assistant');
    const consumed = vi.fn();
    const initial = controller({ items: [oldUser, oldAnswer, user], loadLatest });
    const { container, rerender } = render(<AgentConversationView conversation={initial}
      completedEntryRequest={4} onCompletedEntryConsumed={consumed} />);
    expect(loadLatest).toHaveBeenCalledWith({ force: true });
    expect(loadLatest).toHaveBeenCalledTimes(2);
    expect(consumed).not.toHaveBeenCalled();

    await act(async () => {
      existingRead.resolve();
      await existingLatest;
    });
    expect(consumed).not.toHaveBeenCalled();

    rerender(<AgentConversationView completedEntryRequest={4} onCompletedEntryConsumed={consumed}
      conversation={{ ...initial, items: [oldUser, oldAnswer, user, final] }} />);
    await act(async () => { forcedRead.resolve(); await forcedRead.promise; });

    expect((container.querySelector('.chat-scroll') as HTMLDivElement).scrollTop).toBe(188);
    expect(consumed).toHaveBeenCalledWith(4);
    expect(loadLatest).toHaveBeenCalledTimes(2);
  });

  it('does not let an older completed request settle over a newer request', async () => {
    const firstRead = deferred();
    const secondRead = deferred();
    const loadLatest = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);
    const final = {
      key: 'final', provisional: false,
      item: {
        id: 'final', sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'final answer' }],
      },
    };
    const consumed = vi.fn();
    const conversation = controller({ items: [final], loadLatest });
    const { rerender } = render(<AgentConversationView conversation={conversation}
      completedEntryRequest={6} onCompletedEntryConsumed={consumed} />);
    rerender(<AgentConversationView conversation={conversation}
      completedEntryRequest={7} onCompletedEntryConsumed={consumed} />);

    await act(async () => { secondRead.resolve(); await secondRead.promise; });
    expect(consumed).toHaveBeenCalledOnce();
    expect(consumed).toHaveBeenCalledWith(7);

    await act(async () => { firstRead.resolve(); await firstRead.promise; });
    expect(consumed).toHaveBeenCalledOnce();
  });

  it('never anchors against a bounded older window before latest is restored', async () => {
    const latest = deferred();
    const loadLatest = vi.fn(() => latest.promise);
    const item = (key: string, role: 'user' | 'assistant') => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role, content: [{ type: 'text' as const, text: key }],
      },
    });
    const consumed = vi.fn();
    const olderWindow = controller({
      items: [item('old-user', 'user'), item('old-answer', 'assistant')],
      atLatest: false,
      loadLatest,
    });
    const { rerender } = render(<AgentConversationView conversation={olderWindow}
      completedEntryRequest={5} onCompletedEntryConsumed={consumed} />);
    expect(consumed).not.toHaveBeenCalled();

    rerender(<AgentConversationView completedEntryRequest={5} onCompletedEntryConsumed={consumed}
      conversation={{
        ...olderWindow,
        atLatest: true,
        items: [item('current-user', 'user'), item('current-final', 'assistant')],
      }} />);
    await act(async () => { latest.resolve(); await latest.promise; });

    expect(consumed).toHaveBeenCalledWith(5);
    expect(loadLatest).toHaveBeenCalledOnce();
  });

  it('resumes generic live following after a touch gesture reaches the true bottom', () => {
    const item = (key: string) => ({
      key, provisional: false,
      item: {
        id: key, sessionId: 'session-1', status: 'complete' as const,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: key }],
      },
    });
    const first = controller({ items: [item('current')] });
    const { container, rerender } = render(<AgentConversationView conversation={first} />);
    const scroll = container.querySelector('.chat-scroll') as HTMLDivElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 1_200, configurable: true });
    scroll.scrollTop = 900;
    fireEvent.scroll(scroll);
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    expect(container.querySelector('.new-output')).toBeTruthy();

    fireEvent.pointerDown(scroll, { pointerType: 'touch', clientY: 200 });
    fireEvent.pointerMove(scroll, { pointerType: 'touch', clientY: 150 });
    scroll.scrollTop = 900;
    fireEvent.scroll(scroll);
    fireEvent.pointerUp(scroll, { pointerType: 'touch' });
    expect(container.querySelector('.new-output')).toBeNull();

    Object.defineProperty(scroll, 'scrollHeight', { value: 1_300, configurable: true });
    rerender(<AgentConversationView conversation={{
      ...first, items: [item('current'), item('live')],
    }} />);
    expect(scroll.scrollTop).toBe(1_300);
  });

  it('keeps return-to-latest available when the bounded history window no longer owns the tail', () => {
    const loadLatest = vi.fn(async () => {});
    const conversation = controller({ atLatest: false, loadLatest });
    render(<AgentConversationView conversation={conversation} />);

    const button = screen.getByRole('button', { name: '回到最新' });
    expect(button.textContent).toBe('↓ 回到最新');
    fireEvent.click(button);
    expect(loadLatest).toHaveBeenCalledOnce();
  });

  it('submits a normal prompt to the public queue while busy and exposes working interrupt', async () => {
    const conversation = controller();
    const onSendStart = vi.fn();
    const { container } = render(
      <AgentConversationComposer agentId="pi" sessionId="session-1" busy={true}
        conversation={conversation} onSendStart={onSendStart} />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'keep going' } });
    fireEvent.click(container.querySelector('button.cc-send:not(.cc-stop)')!);
    await waitFor(() => expect(conversation.send).toHaveBeenCalledWith('keep going', { queueHint: true }));
    expect(onSendStart).toHaveBeenCalledOnce();
    expect((input as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(container.querySelector('button.cc-stop')!);
    const dialog = screen.getByRole('alertdialog', { name: '停止当前任务？' });
    expect(dialog).toBeTruthy();
    expect(conversation.interrupt).not.toHaveBeenCalled();
    fireEvent.click(dialog.querySelector('button.danger')!);
    await waitFor(() => expect(conversation.interrupt).toHaveBeenCalledOnce());
  });

  it('keeps loading and reconnecting drafts editable while disabling unavailable send', () => {
    const loading = controller({
      status: 'loading', canonicalReady: false, descriptor: null,
    });
    const view = render(<AgentConversationComposer agentId="pi" sessionId="loading-draft"
      busy={false} conversation={loading} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    const send = view.container.querySelector('button.cc-send') as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('keep this draft');
    expect(send.disabled).toBe(true);

    view.rerender(<AgentConversationComposer agentId="pi" sessionId="loading-draft"
      busy={false} conversation={controller()} />);
    expect(input.value).toBe('keep this draft');
    expect(send.disabled).toBe(false);

    view.rerender(<AgentConversationComposer agentId="pi" sessionId="loading-draft"
      busy={false} conversation={controller({ status: 'reconnecting' })} />);
    expect(input.value).toBe('keep this draft');
    expect(send.disabled).toBe(true);
    expect(view.container.querySelector('.agent-conversation-composer-status')).toBeNull();
    expect(view.container.textContent).not.toContain('正在重新连接实时对话');
  });

  it('keeps unavailable send controls visible and consistently disabled', () => {
    const conversation = controller({ descriptor: {
      session: { agentId: 'pi', sessionId: 'read-only-session' },
      viewId: 'read-only-view', historyVersion: 'read-only-history',
      capabilities: { history: true, live: 'poll', branching: true },
    } });
    const { container } = render(<AgentConversationComposer agentId="pi"
      sessionId="read-only-session" busy={false} conversation={conversation}
      shortcuts={{
        command: [],
        chat: [
          { type: 'text', text: 'send now', enter: true },
          { type: 'text', text: 'draft only', enter: false },
        ],
      }} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'keep this available' } });
    const send = container.querySelector('button.cc-send') as HTMLButtonElement;
    const quickSend = screen.getByRole('button', { name: 'send now' }) as HTMLButtonElement;
    const fillDraft = screen.getByRole('button', { name: 'draft only' }) as HTMLButtonElement;

    expect(send).toBeTruthy();
    expect(send.disabled).toBe(true);
    expect(quickSend.disabled).toBe(true);
    expect(fillDraft.disabled).toBe(false);
    fireEvent.click(quickSend);
    expect(conversation.send).not.toHaveBeenCalled();
    expect(input.value).toBe('keep this available');
    fireEvent.click(fillDraft);
    expect(input.value).toBe('draft only');
    expect(conversation.send).not.toHaveBeenCalled();
  });

  it('keeps v4 Pi send available while showing the reload notice', () => {
    const conversation = controller({ descriptor: {
      session: { agentId: 'pi', sessionId: 'stale-v4-session' },
      run: {
        agentId: 'pi', paneId: '%1', runId: 'run-v4', sessionId: 'stale-v4-session',
      },
      viewId: 'stale-v4-view', historyVersion: 'stale-v4-history',
      capabilities: {
        history: true, live: 'delta', sendable: true, steer: true,
        send: ['prompt'], interrupt: true, branching: true,
      },
      implementation: { version: 4, reloadRequired: true },
    } });
    const { container } = render(<>
      <AgentConversationView conversation={conversation} />
      <AgentConversationComposer agentId="pi" sessionId="stale-v4-session"
        busy={false} conversation={conversation} />
    </>);
    expect(screen.getByText(/请切换到终端运行 \/reload/)).toBeTruthy();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'send before reload' } });
    expect((container.querySelector('button.cc-send') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'ok' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never converts a normal busy send into Adapter steer', async () => {
    const conversation = controller({ descriptor: {
      session: { agentId: 'future-agent', sessionId: 'session-steer' },
      run: { agentId: 'future-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-steer' },
      viewId: 'view-steer', historyVersion: 'history-steer',
      capabilities: { history: true, live: 'poll', send: ['prompt', 'steer'] },
    } });
    const { container } = render(<AgentConversationComposer agentId="future-agent"
      sessionId="session-steer" busy conversation={conversation} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'redirect' } });
    fireEvent.click(container.querySelector('button.cc-send:not(.cc-stop)')!);
    await waitFor(() => expect(conversation.send).toHaveBeenCalledWith('redirect', { queueHint: true }));
  });

  it('uses desktop Enter to send, Shift+Enter for a newline, and Escape only to blur', async () => {
    const conversation = controller();
    render(<AgentConversationComposer agentId="pi" sessionId="session-keys" busy={false}
      desktop conversation={conversation} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'keep this draft' } });

    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(conversation.send).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('keep this draft');
    expect(conversation.interrupt).not.toHaveBeenCalled();

    input.focus();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(conversation.send).toHaveBeenCalledWith(
      'keep this draft', { queueHint: false },
    ));
  });

  it.each([
    ['Goal / Plan', 'header'],
    ['Queue edit / delete', 'queue'],
    ['Context / Permission', 'action'],
    ['Model', 'session'],
  ] as const)('ignores %s portal pointer events instead of focusing the composer', (label, slot) => {
    const control = <PortaledComposerControl label={label} />;
    const content = slot === 'header' ? { headerContent: control }
      : slot === 'queue' ? { queueContent: control }
        : slot === 'session' ? { sessionControl: control } : { actionContent: control };
    const { container } = render(<>
      <button type="button" data-testid="focus-owner">outside focus owner</button>
      <AgentConversationComposer agentId="pi" sessionId={`portal-${label}`} busy={false}
        conversation={controller()} {...content} />
    </>);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const inputFocus = vi.spyOn(input, 'focus');
    const focusOwner = screen.getByTestId('focus-owner');
    focusOwner.focus();
    fireEvent.click(screen.getByRole('button', { name: `打开${label}` }));
    const backdrop = document.querySelector(`[data-portaled-composer-control="${label}"]`)!;

    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(pointerDown, { clientX: 20, clientY: 20 });
    fireEvent(backdrop, pointerDown);
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.click(backdrop);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(inputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusOwner);
    expect(container.querySelector(`[data-portaled-composer-control="${label}"]`)).toBeNull();
    expect(document.querySelector(`[data-portaled-composer-control="${label}"]`)).toBeNull();
  });

  it('ignores the real Context backdrop when it closes inside the composer card', () => {
    const controls = composerControls({
      snapshot: { context: { activity: 'idle', usedTokens: 20, totalTokens: 100 } },
    });
    const { container } = render(<>
      <button type="button" data-testid="focus-owner">outside focus owner</button>
      <AgentConversationComposer agentId="pi" sessionId="real-context" busy={false}
        conversation={controller()} actionContent={
          <AgentConversationContextControl controller={controls} sessionId="real-context" />
        } />
    </>);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const inputFocus = vi.spyOn(input, 'focus');
    const focusOwner = screen.getByTestId('focus-owner');
    focusOwner.focus();
    fireEvent.click(screen.getByRole('button', { name: '会话状态，上下文占用 20%' }));
    const backdrop = container.querySelector('.cc-context-backdrop')!;
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(pointerDown, { clientX: 20, clientY: 20 });
    fireEvent(backdrop, pointerDown);
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.click(backdrop);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(inputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusOwner);
    expect(screen.queryByRole('dialog', { name: '会话状态' })).toBeNull();
  });

  it('preserves an already-focused composer through the real Context close without refocusing it', () => {
    const controls = composerControls({
      snapshot: { context: { activity: 'idle', usedTokens: 20, totalTokens: 100 } },
    });
    const { container } = render(<AgentConversationComposer agentId="pi"
      sessionId="focused-context" busy={false} conversation={controller()} actionContent={
        <AgentConversationContextControl controller={controls} sessionId="focused-context" />
      } />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.focus();
    const inputFocus = vi.spyOn(input, 'focus');

    const trigger = screen.getByRole('button', { name: '会话状态，上下文占用 20%' });
    fireEvent.pointerDown(trigger, { clientX: 20, clientY: 20 });
    fireEvent.click(trigger);
    const backdrop = container.querySelector('.cc-context-backdrop')!;
    fireEvent.pointerDown(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20 });
    fireEvent.click(backdrop);

    expect(inputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('dialog', { name: '会话状态' })).toBeNull();
  });

  it('ignores the real Permission overlay through its asynchronous close', async () => {
    let resolvePermission!: () => void;
    const permissionResult = new Promise<void>((resolve) => { resolvePermission = resolve; });
    const controls = composerControls({
      snapshot: {
        permission: { mode: 'default', options: ['default', 'auto-review'] },
        permissionCanUpdate: true,
      },
      setPermission: vi.fn(async () => {
        await permissionResult;
        return {
          mode: 'auto-review' as const,
          options: ['default' as const, 'auto-review' as const],
        };
      }),
    });
    render(<>
      <button type="button" data-testid="focus-owner">outside focus owner</button>
      <AgentConversationComposer agentId="pi" sessionId="real-permission" busy={false}
        conversation={controller()} actionContent={
          <AgentConversationPermissionControl controller={controls} />
        } />
    </>);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const inputFocus = vi.spyOn(input, 'focus');
    const focusOwner = screen.getByTestId('focus-owner');
    focusOwner.focus();
    fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
    const option = screen.getByRole('radio', { name: /自动审批/ });
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(pointerDown, { clientX: 20, clientY: 20 });
    fireEvent(option, pointerDown);
    fireEvent.pointerUp(option, { clientX: 20, clientY: 20 });
    fireEvent.click(option);
    await act(async () => { resolvePermission(); await permissionResult; });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '权限模式' })).toBeNull());

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(inputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusOwner);
  });

  it('does not focus after the real Model overlay closes from a control effect', async () => {
    const ready = composerModelControl();
    const unavailable = composerModelControl({ status: 'unavailable', modelControl: null });
    const view = render(<>
      <button type="button" data-testid="focus-owner">outside focus owner</button>
      <AgentConversationComposer agentId="pi" sessionId="real-model" busy={false}
        conversation={controller()} sessionControl={
          <AgentModelControl control={ready} busy={false} />
        } />
    </>);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const inputFocus = vi.spyOn(input, 'focus');
    const focusOwner = screen.getByTestId('focus-owner');
    focusOwner.focus();
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByRole('dialog', { name: '模型设置' })
      .hasAttribute('data-conversation-overlay')).toBe(true);

    view.rerender(<>
      <button type="button" data-testid="focus-owner">outside focus owner</button>
      <AgentConversationComposer agentId="pi" sessionId="real-model" busy={false}
        conversation={controller()} sessionControl={
          <AgentModelControl control={unavailable} busy={false} />
        } />
    </>);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型设置' })).toBeNull());
    expect(inputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusOwner);
  });

  it('focuses on a real card blank tap while controls preserve the existing textarea focus', () => {
    const { container } = render(<AgentConversationComposer agentId="pi" sessionId="card-focus"
      busy={false} conversation={controller()} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const blank = container.querySelector('.cc-actions-left')!;
    fireEvent.pointerDown(blank, { clientX: 50, clientY: 100 });
    fireEvent.pointerUp(blank, { clientX: 50, clientY: 100 });
    expect(document.activeElement).toBe(input);

    const attach = container.querySelector('.cc-attach')!;
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(attach, pointerDown);
    fireEvent.pointerUp(attach, { clientX: 20, clientY: 100 });
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('does not take focus after an immediate quick send completes', async () => {
    const pending = deferred();
    const conversation = controller({ send: vi.fn(() => pending.promise) });
    render(<>
      <button type="button">outside owner</button>
      <AgentConversationComposer agentId="pi" sessionId="quick-focus-owner"
        busy={false} conversation={conversation} />
    </>);
    const outside = screen.getByRole('button', { name: 'outside owner' });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const focus = vi.spyOn(input, 'focus');
    outside.focus();

    fireEvent.click(screen.getByRole('button', { name: 'ok' }));
    await waitFor(() => expect(conversation.send).toHaveBeenCalledWith('ok', { queueHint: false }));
    await act(async () => { pending.resolve(); await pending.promise; });

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it('preserves the existing focus owner when the send button completes', async () => {
    const outsideSend = deferred();
    const outsideConversation = controller({ send: vi.fn(() => outsideSend.promise) });
    const first = render(<>
      <button type="button">outside owner</button>
      <AgentConversationComposer agentId="pi" sessionId="button-focus-owner"
        busy={false} conversation={outsideConversation} />
    </>);
    const outside = screen.getByRole('button', { name: 'outside owner' });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const focus = vi.spyOn(input, 'focus');
    fireEvent.change(input, { target: { value: 'send without focus' } });
    outside.focus();
    fireEvent.click(first.container.querySelector('button.cc-send')!);
    await waitFor(() => expect(outsideConversation.send).toHaveBeenCalledOnce());
    await act(async () => { outsideSend.resolve(); await outsideSend.promise; });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    first.unmount();

    const focusedSend = deferred();
    const focusedConversation = controller({ send: vi.fn(() => focusedSend.promise) });
    const second = render(<AgentConversationComposer agentId="pi" sessionId="focused-owner"
      busy={false} conversation={focusedConversation} />);
    const focusedInput = screen.getByRole('textbox') as HTMLTextAreaElement;
    focusedInput.focus();
    const focusedInputFocus = vi.spyOn(focusedInput, 'focus');
    fireEvent.change(focusedInput, { target: { value: 'keep current focus' } });
    fireEvent.click(second.container.querySelector('button.cc-send')!);
    await waitFor(() => expect(focusedConversation.send).toHaveBeenCalledOnce());
    await act(async () => { focusedSend.resolve(); await focusedSend.promise; });
    expect(focusedInputFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focusedInput);
  });

  it('keeps the composer editable during a connection failure without offering a doomed send', () => {
    const conversation = controller({
      status: 'error', error: 'temporary disconnect', descriptor: null,
    });
    const { container } = render(
      <AgentConversationComposer agentId="pi" sessionId="session-1" busy={false}
        conversation={conversation} />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'retry now' } });
    const send = container.querySelector('button.cc-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(conversation.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.value).toBe('retry now');
  });

  it('shows localized send copy instead of a stable receipt reason', async () => {
    const conversation = controller({
      send: vi.fn(async () => {
        throw new ConversationSendError('provider_rejected', false, 'sendFailed');
      }),
    });
    const { container } = render(
      <AgentConversationComposer agentId="pi" sessionId="stable-reason" busy={false}
        conversation={conversation} />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'restore me' } });
    fireEvent.click(container.querySelector('button.cc-send')!);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('消息没有发送成功');
    expect(document.body.textContent).not.toContain('provider_rejected');
    expect(input.value).toBe('restore me');
  });

  it('freezes every draft mutation entry while a send is pending and restores on definitive failure', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, nextReject) => { reject = nextReject; });
    const conversation = controller({ send: vi.fn(() => pending) });
    const { container } = render(
      <AgentConversationComposer agentId="pi" sessionId="send-lock" busy={false}
        conversation={conversation} />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'do not lose this' } });
    fireEvent.click(container.querySelector('button.cc-send')!);
    await waitFor(() => expect(conversation.send).toHaveBeenCalledOnce());

    const quick = screen.getByRole('button', { name: 'ok' }) as HTMLButtonElement;
    expect(quick.disabled).toBe(true);
    fireEvent.click(quick);
    fireEvent.change(input, { target: { value: 'programmatic overwrite' } });
    act(() => upload.onPaths(['/work/late-file.ts']));
    expect(input.value).toBe('');

    await act(async () => { reject(new Error('definitive failure')); await pending.catch(() => {}); });
    await waitFor(() => expect(input.value).toBe('do not lose this\n/work/late-file.ts'));
    expect(screen.getByRole('alert').textContent).not.toContain('programmatic overwrite');
  });

  it('keeps an async upload result as the next draft after a successful send', async () => {
    const pending = deferred();
    const conversation = controller({ send: vi.fn(() => pending.promise) });
    const { container } = render(
      <AgentConversationComposer agentId="pi" sessionId="send-upload" busy={false}
        conversation={conversation} />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'sent message' } });
    fireEvent.click(container.querySelector('button.cc-send')!);
    await waitFor(() => expect(conversation.send).toHaveBeenCalledOnce());
    act(() => upload.onPaths(['/work/late-file.ts']));
    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(() => expect(input.value).toBe('/work/late-file.ts'));
  });

  it('blocks button, desktop Enter, and immediate quick sends while voice is recording or finalizing', () => {
    const conversation = controller();
    const props = {
      agentId: 'pi', sessionId: 'voice-send-lock', busy: false, desktop: true,
      micAvailable: true, conversation,
    };
    const view = render(<AgentConversationComposer {...props} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'original body' } });
    const mic = screen.getByRole('button', { name: '语音输入' });
    fireEvent.pointerDown(mic, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(mic, { clientX: 10, clientY: 10 });

    voice.state = 'recording';
    view.rerender(<AgentConversationComposer {...props} />);
    expect((view.container.querySelector('button.cc-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'ok' }));
    expect(conversation.send).not.toHaveBeenCalled();

    voice.state = 'finalizing';
    view.rerender(<AgentConversationComposer {...props} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'ok' }));
    expect(conversation.send).not.toHaveBeenCalled();
    act(() => voice.onText(' spoken'));
    expect(input.value).toBe('original body spoken');
  });

  it('restores a definitively failed send after the composer unmounts', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, nextReject) => { reject = nextReject; });
    const conversation = controller({ send: vi.fn(() => pending) });
    const first = render(
      <AgentConversationComposer agentId="pi" sessionId="unmounted-send-failure" busy={false}
        conversation={conversation} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'recover after unmount' } });
    fireEvent.click(first.container.querySelector('button.cc-send')!);
    await waitFor(() => expect(conversation.send).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => { reject(new Error('definitive failure')); await pending.catch(() => {}); });

    render(<AgentConversationComposer agentId="pi" sessionId="unmounted-send-failure" busy={false}
      conversation={controller()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('recover after unmount');
  });

  it('keeps mobile Enter as a newline gesture and only sends on desktop', async () => {
    const mobileConversation = controller();
    const { rerender } = render(
      <AgentConversationComposer agentId="pi" sessionId="session-1" busy={false}
        conversation={mobileConversation} />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'two lines' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect(mobileConversation.send).not.toHaveBeenCalled();

    const desktopConversation = controller();
    rerender(<AgentConversationComposer agentId="pi" sessionId="session-1" busy={false} desktop={true}
      conversation={desktopConversation} />);
    fireEvent.change(input, { target: { value: 'send now' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    await waitFor(() => expect(desktopConversation.send).toHaveBeenCalledWith(
      'send now', { queueHint: false },
    ));
  });

  it('restores an unsent draft after a transient run gap without sharing it across Agent sessions', async () => {
    const conversation = controller();
    const first = render(
      <AgentConversationComposer agentId="pi" sessionId="draft-session" busy={false}
        conversation={conversation} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this draft' } });
    first.unmount();

    const restored = render(
      <AgentConversationComposer agentId="pi" sessionId="draft-session" busy={false}
        conversation={conversation} />,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep this draft');

    restored.rerender(
      <AgentConversationComposer agentId="other-agent" sessionId="draft-session" busy={false}
        conversation={conversation} />,
    );
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
  });

  it('does not let a completed send from the previous keyed session clear the new draft', async () => {
    const pending = deferred();
    const first = controller({ send: vi.fn(() => pending.promise) });
    const second = controller();
    const { container, rerender } = render(
      <AgentConversationComposer key="pi:async-session-1" agentId="pi" sessionId="async-session-1"
        busy={false} conversation={first} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first message' } });
    fireEvent.click(container.querySelector('button.cc-send')!);
    await waitFor(() => expect(first.send).toHaveBeenCalledOnce());

    rerender(
      <AgentConversationComposer key="pi:async-session-2" agentId="pi" sessionId="async-session-2"
        busy={false} conversation={second} />,
    );
    const nextInput = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(nextInput, { target: { value: 'keep second draft' } });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(nextInput.value).toBe('keep second draft');
    expect(second.send).not.toHaveBeenCalled();
  });
});
