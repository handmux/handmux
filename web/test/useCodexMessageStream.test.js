import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import {
  applyCodexStreamEvent, durableCoversLiveMessage, useCodexMessageStream,
} from '../src/hooks/useCodexMessageStream.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Codex message stream projection', () => {
  it('accumulates deltas into one stable temporary assistant message', () => {
    let messages = [];
    messages = applyCodexStreamEvent(messages, {
      type: 'started', turnId: 'turn-1', itemId: 'agent-1', text: '',
    }, 7);
    messages = applyCodexStreamEvent(messages, {
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '你',
    }, 8);
    messages = applyCodexStreamEvent(messages, {
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '好',
    }, 9);
    expect(messages).toEqual([expect.objectContaining({
      id: 'codex-stream:turn-1:agent-1', text: '你好', streaming: true, afterK: 7,
    })]);

    messages = applyCodexStreamEvent(messages, {
      type: 'completed', turnId: 'turn-1', itemId: 'agent-1', text: '你好！',
    });
    expect(messages[0]).toMatchObject({ text: '你好！', completed: true, streaming: false });
  });

  it('lets only a newer durable rollout message replace a completed temporary bubble', () => {
    const live = { completed: true, text: '完成', afterK: 4 };
    expect(durableCoversLiveMessage([
      { k: 3, role: 'assistant', type: 'text', text: '完成' },
    ], live)).toBe(false);
    expect(durableCoversLiveMessage([
      { k: 5, role: 'assistant', type: 'text', text: '完成' },
    ], live)).toBe(true);
  });

  it('renders incoming deltas, requests a durable refresh on completion, and reconciles the final message', async () => {
    let emit;
    vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    const onSettled = vi.fn();
    const { result, rerender } = renderHook(
      ({ durableMessages }) => useCodexMessageStream({
        pane: '%1', threadId: 'thread-1', enabled: true, durableMessages, onSettled,
      }),
      { initialProps: { durableMessages: [{ k: 4, role: 'user', type: 'text', text: '继续' }] } },
    );
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalled());

    act(() => {
      emit({ type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '回答' });
      emit({ type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '回答完成' });
    });
    expect(result.current).toEqual([expect.objectContaining({ text: '回答完成', completed: true, afterK: 4 })]);
    expect(onSettled).toHaveBeenCalledOnce();

    rerender({ durableMessages: [
      { k: 4, role: 'user', type: 'text', text: '继续' },
      { k: 5, role: 'assistant', type: 'text', text: '回答完成' },
    ] });
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
