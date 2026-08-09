import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import { projectCodexStreamEvent } from '../../server/src/codexStreamProtocol.js';
import {
  applyCodexStreamEvent, durableCoversLiveMessage, useCodexMessageStream,
} from '../src/hooks/useCodexMessageStream.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function projected(event, sequence = 1) {
  return projectCodexStreamEvent({ threadId: 'thread-1', ...event }, sequence);
}

describe('Codex message stream projection', () => {
  it('accumulates deltas into one stable temporary assistant message', () => {
    let messages = [];
    messages = applyCodexStreamEvent(messages, projected({
      type: 'started', turnId: 'turn-1', itemId: 'agent-1', text: '',
    }), 7);
    messages = applyCodexStreamEvent(messages, projected({
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '你',
    }), 8);
    messages = applyCodexStreamEvent(messages, projected({
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '好',
    }), 9);
    expect(messages).toEqual([expect.objectContaining({
      id: 'codex:turn-1:agent-1', text: '你好', streaming: true, afterK: 7,
    })]);

    messages = applyCodexStreamEvent(messages, projected({
      type: 'completed', turnId: 'turn-1', itemId: 'agent-1', text: '你好！',
    }));
    expect(messages[0]).toMatchObject({ text: '你好！', completed: true, streaming: false });
  });

  it('covers a live message only by its canonical server identity', () => {
    const live = {
      id: 'codex:turn-1:agent-1', streamKey: 'turn-1:agent-1', turnId: 'turn-1', itemId: 'agent-1',
      role: 'assistant', type: 'text', live: true, completed: false, streaming: true, text: '流式片段', afterK: 99,
    };
    expect(durableCoversLiveMessage([
      { id: 'codex:turn-1:agent-other', k: 3, role: 'assistant', type: 'text', text: '流式片段' },
    ], live)).toBe(false);
    expect(durableCoversLiveMessage([
      { id: 'codex:turn-1:agent-1', k: 3, role: 'assistant', type: 'text', text: '最终回答' },
    ], live)).toBe(true);
    expect(durableCoversLiveMessage([
      { k: 100, role: 'assistant', type: 'text', text: '流式片段' },
    ], live)).toBe(false);
  });

  it('discards finalized temporary replies before projecting a newer live reply', () => {
    let messages = [];
    for (let index = 1; index <= 4; index += 1) {
      messages = applyCodexStreamEvent(messages, projected({
        type: 'completed', turnId: 'turn-old', itemId: `agent-old-${index}`, text: `历史回复 ${index}`,
      }));
    }
    messages = applyCodexStreamEvent(messages, projected({
      type: 'started', turnId: 'turn-new', itemId: 'agent-current', text: '',
    }));
    messages = applyCodexStreamEvent(messages, projected({
      type: 'delta', turnId: 'turn-new', itemId: 'agent-current', delta: '当前更新',
    }));

    expect(messages).toEqual([expect.objectContaining({
      itemId: 'agent-current', text: '当前更新', streaming: true,
    })]);
  });

  it('drops finalized temporary replies when a stream reconnects', () => {
    const messages = [
      { itemId: 'old', text: '旧回复', completed: true },
      { itemId: 'current', text: '当前回复', completed: false },
      { type: 'goal', goal: { status: 'complete' }, turnId: null, completed: true },
    ];
    expect(applyCodexStreamEvent(messages, { type: 'ready' })).toEqual([
      expect.objectContaining({ itemId: 'current' }),
    ]);
  });

  it('keeps native Goal lifecycle cards until the durable rollout covers them', () => {
    const goal = {
      objective: 'Finish the release', status: 'complete', createdAt: 10,
      updatedAt: 20, tokensUsed: 500, timeUsedSeconds: 12,
    };
    const messages = applyCodexStreamEvent([], projected({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-goal', event: 'complete', goal,
    }), 4);
    expect(messages).toEqual([expect.objectContaining({
      type: 'goal', event: 'complete', goal, completed: true, afterK: 4,
    })]);
    expect(applyCodexStreamEvent(messages, { type: 'ready' })).toEqual(messages);
    expect(applyCodexStreamEvent(messages, projected({
      type: 'started', turnId: 'turn-next', itemId: 'agent-next', text: '',
    }))).toEqual([
      expect.objectContaining({ type: 'goal', event: 'complete' }),
      expect.objectContaining({ type: 'text', turnId: 'turn-next' }),
    ]);
    expect(durableCoversLiveMessage([
      { id: 'codex-goal:10:complete', k: 5, type: 'goal', event: 'complete', goal },
    ], messages[0])).toBe(true);
    expect(durableCoversLiveMessage([
      { id: 'codex-goal:9:complete', k: 3, type: 'goal', event: 'complete', goal: { ...goal, createdAt: 9 } },
    ], messages[0])).toBe(false);
    expect(applyCodexStreamEvent([], projected({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'complete', goal,
    }), 4)).toEqual([]);
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

    act(() => emit(projected({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '回答',
    }, 1)));
    rerender({ durableMessages: [
      { k: 4, role: 'user', type: 'text', text: '继续' },
      { id: 'codex:turn-1:agent-1', k: 5, role: 'assistant', type: 'text', text: '回答' },
    ] });
    // ChatView hides this exact durable duplicate, but the hook must retain the accumulator so the next
    // delta continues from "回答" instead of reappearing as a broken "继续" fragment.
    expect(result.current).toEqual([expect.objectContaining({ text: '回答', streaming: true })]);

    act(() => emit(projected({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '继续',
    }, 2)));
    expect(result.current).toEqual([expect.objectContaining({ text: '回答继续', streaming: true })]);
    act(() => emit(projected({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '回答完成',
    }, 3)));
    expect(result.current).toEqual([expect.objectContaining({ text: '回答完成', completed: true, afterK: 4 })]);
    expect(onSettled).toHaveBeenCalledOnce();

    rerender({ durableMessages: [
      { k: 4, role: 'user', type: 'text', text: '继续' },
      { id: 'codex:turn-1:agent-1', k: 5, role: 'assistant', type: 'text', text: '回答完成' },
    ] });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('reconnects a stream frozen by an app switch when the window regains focus', async () => {
    const signals = [];
    const subscriptions = [];
    vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, options) => {
      const { signal } = options;
      signals.push(signal);
      subscriptions.push(options);
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    renderHook(() => useCodexMessageStream({
      pane: '%1', threadId: 'thread-1', enabled: true, durableMessages: [],
    }));
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledTimes(1));
    act(() => subscriptions[0].onEvent(projected({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '继续',
    }, 7)));

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(subscriptions[1].after).toBe(7);
  });

  it('refreshes durable history and resets its cursor when the server journal has restarted', async () => {
    let emit;
    vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    const onSettled = vi.fn();
    const { result } = renderHook(() => useCodexMessageStream({
      pane: '%1', threadId: 'thread-1', enabled: true, durableMessages: [], onSettled,
    }));
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledOnce());
    act(() => emit(projected({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-old', itemId: 'agent-old', text: '旧回复',
    }, 9)));
    expect(result.current).toHaveLength(1);

    act(() => emit({ type: 'cursorReset', threadId: 'thread-1', cursor: 0 }));
    expect(result.current).toEqual([]);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});
