import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import { projectCodexStreamEvent } from '../../server/src/codexStreamProtocol.js';
import { applyCodexConversationEvent } from '../src/codexConversationState.js';
import { useCodexMessageStream } from '../src/hooks/useCodexMessageStream.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function projected(event, sequence = 1) {
  return projectCodexStreamEvent({ threadId: 'thread-1', ...event }, sequence);
}

describe('Codex message stream projection', () => {
  it('accumulates deltas into one stable temporary assistant message', () => {
    let messages = [];
    messages = applyCodexConversationEvent(messages, projected({
      type: 'started', turnId: 'turn-1', itemId: 'agent-1', text: '',
    }));
    messages = applyCodexConversationEvent(messages, projected({
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '你',
    }));
    messages = applyCodexConversationEvent(messages, projected({
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '好',
    }));
    expect(messages).toEqual([expect.objectContaining({
      id: 'codex:turn-1:agent-1', text: '你好', streaming: true,
    })]);

    messages = applyCodexConversationEvent(messages, projected({
      type: 'completed', turnId: 'turn-1', itemId: 'agent-1', text: '你好！',
    }));
    expect(messages[0]).toMatchObject({ text: '你好！', completed: true, streaming: false });
  });

  it('replaces a live fragment with the rollout mutation from the same ordered stream', () => {
    let messages = applyCodexConversationEvent([], projected({
      type: 'delta', turnId: 'turn-1', itemId: 'agent-1', delta: '流式片段',
    }, 1));
    const mutation = {
      operation: 'upsert', mode: 'replace',
      message: {
        id: 'codex:turn-1:agent-1', role: 'assistant', type: 'text',
        turnId: 'turn-1', itemId: 'agent-1', text: '最终回答', completed: true, streaming: false,
      },
    };
    messages = applyCodexConversationEvent(messages, projected({
      type: 'conversation', turnId: 'turn-1', itemId: 'agent-1', mutation,
    }, 2));
    expect(messages).toEqual([expect.objectContaining({
      id: 'codex:turn-1:agent-1', text: '最终回答', live: false,
      completed: true, streaming: false,
    })]);
  });

  it('discards finalized temporary replies before projecting a newer live reply', () => {
    let messages = [];
    for (let index = 1; index <= 4; index += 1) {
      messages = applyCodexConversationEvent(messages, projected({
        type: 'completed', turnId: 'turn-old', itemId: `agent-old-${index}`, text: `历史回复 ${index}`,
      }));
    }
    messages = applyCodexConversationEvent(messages, projected({
      type: 'started', turnId: 'turn-new', itemId: 'agent-current', text: '',
    }));
    messages = applyCodexConversationEvent(messages, projected({
      type: 'delta', turnId: 'turn-new', itemId: 'agent-current', delta: '当前更新',
    }));

    expect(messages).toEqual([expect.objectContaining({
      itemId: 'agent-current', text: '当前更新', streaming: true,
    })]);
  });

  it('drops finalized temporary replies when a stream reconnects', () => {
    const messages = [
      { itemId: 'old', text: '旧回复', live: true, completed: true },
      { itemId: 'current', text: '当前回复', live: true, completed: false },
      { type: 'goal', goal: { status: 'complete' }, turnId: null, live: true, completed: true },
    ];
    expect(applyCodexConversationEvent(messages, { type: 'ready' })).toEqual([
      expect.objectContaining({ itemId: 'current' }),
    ]);
  });

  it('keeps native Goal lifecycle cards until the durable rollout covers them', () => {
    const goal = {
      objective: 'Finish the release', status: 'complete', createdAt: 10,
      updatedAt: 20, tokensUsed: 500, timeUsedSeconds: 12,
    };
    const messages = applyCodexConversationEvent([{
      id: 'codex:turn-goal:user-1', k: 3, type: 'text', role: 'user', turnId: 'turn-goal', text: '继续',
    }], projected({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-goal', event: 'complete', goal,
    }));
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', turnId: 'turn-goal' }),
      expect.objectContaining({ type: 'goal', event: 'complete', goal, completed: true }),
    ]);
    expect(applyCodexConversationEvent(messages, { type: 'ready' })).toEqual(messages);
    expect(applyCodexConversationEvent(messages, projected({
      type: 'started', turnId: 'turn-next', itemId: 'agent-next', text: '',
    }))).toEqual([
      expect.objectContaining({ role: 'user', turnId: 'turn-goal' }),
      expect.objectContaining({ type: 'goal', event: 'complete' }),
      expect.objectContaining({ type: 'text', turnId: 'turn-next' }),
    ]);
    expect(applyCodexConversationEvent([], projected({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'complete', goal,
    }))).toEqual([]);
  });

  it('forwards ordered mutations and requests a rollout reconciliation on completion', async () => {
    let emit;
    vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, { signal, onEvent }) => {
      emit = onEvent;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    const onSettled = vi.fn();
    const onEvent = vi.fn();
    renderHook(() => useCodexMessageStream({
      pane: '%1', threadId: 'thread-1', enabled: true, onEvent, onSettled,
    }));
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalled());

    act(() => emit(projected({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '回答',
    }, 1)));
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'delta', sequence: 1 }));

    act(() => emit(projected({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '继续',
    }, 2)));
    act(() => emit(projected({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '回答完成',
    }, 3)));
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed', sequence: 3 }));
    expect(onSettled).toHaveBeenCalledOnce();
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
      pane: '%1', threadId: 'thread-1', enabled: true,
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
    const onEvent = vi.fn();
    renderHook(() => useCodexMessageStream({
      pane: '%1', threadId: 'thread-1', enabled: true, onEvent, onSettled,
    }));
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledOnce());
    act(() => emit(projected({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-old', itemId: 'agent-old', text: '旧回复',
    }, 9)));
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed' }));

    act(() => emit({ type: 'cursorReset', threadId: 'thread-1', cursor: 0 }));
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'cursorReset' }));
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});
