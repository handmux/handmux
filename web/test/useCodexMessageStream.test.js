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

  it('lets only a newer durable rollout message cover the same temporary text', () => {
    const live = { completed: false, streaming: true, text: '完成', afterK: 4 };
    expect(durableCoversLiveMessage([
      { k: 3, role: 'assistant', type: 'text', text: '完成' },
    ], live)).toBe(false);
    expect(durableCoversLiveMessage([
      { k: 5, role: 'assistant', type: 'text', text: '完成' },
    ], live)).toBe(true);
    expect(durableCoversLiveMessage([
      { k: 3, turnId: 'turn-1', role: 'assistant', type: 'text', text: '完成' },
    ], { ...live, turnId: 'turn-1', afterK: 9 })).toBe(true);
    expect(durableCoversLiveMessage([
      { k: 10, turnId: 'turn-old', role: 'assistant', type: 'text', text: '完成' },
    ], { ...live, turnId: 'turn-new', afterK: 4 })).toBe(false);
  });

  it('discards finalized temporary replies before projecting a newer live reply', () => {
    let messages = [];
    for (let index = 1; index <= 4; index += 1) {
      messages = applyCodexStreamEvent(messages, {
        type: 'completed', turnId: 'turn-old', itemId: `agent-old-${index}`, text: `历史回复 ${index}`,
      });
    }
    messages = applyCodexStreamEvent(messages, {
      type: 'started', turnId: 'turn-new', itemId: 'agent-current', text: '',
    });
    messages = applyCodexStreamEvent(messages, {
      type: 'delta', turnId: 'turn-new', itemId: 'agent-current', delta: '当前更新',
    });

    expect(messages).toEqual([expect.objectContaining({
      itemId: 'agent-current', text: '当前更新', streaming: true,
    })]);
  });

  it('drops finalized temporary replies when a stream reconnects', () => {
    const messages = [
      { itemId: 'old', text: '旧回复', completed: true },
      { itemId: 'current', text: '当前回复', completed: false },
    ];
    expect(applyCodexStreamEvent(messages, { type: 'ready' })).toEqual([
      expect.objectContaining({ itemId: 'current' }),
    ]);
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

    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '回答',
    }));
    rerender({ durableMessages: [
      { k: 4, role: 'user', type: 'text', text: '继续' },
      { k: 5, role: 'assistant', type: 'text', text: '回答' },
    ] });
    // ChatView hides this exact durable duplicate, but the hook must retain the accumulator so the next
    // delta continues from "回答" instead of reappearing as a broken "继续" fragment.
    expect(result.current).toEqual([expect.objectContaining({ text: '回答', streaming: true })]);

    act(() => emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '继续',
    }));
    expect(result.current).toEqual([expect.objectContaining({ text: '回答继续', streaming: true })]);
    act(() => emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '回答完成',
    }));
    expect(result.current).toEqual([expect.objectContaining({ text: '回答完成', completed: true, afterK: 4 })]);
    expect(onSettled).toHaveBeenCalledOnce();

    rerender({ durableMessages: [
      { k: 4, role: 'user', type: 'text', text: '继续' },
      { k: 5, role: 'assistant', type: 'text', text: '回答完成' },
    ] });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('reconnects a stream frozen by an app switch when the window regains focus', async () => {
    const signals = [];
    vi.spyOn(api, 'streamCodexMessages').mockImplementation((_pane, { signal }) => {
      signals.push(signal);
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    renderHook(() => useCodexMessageStream({
      pane: '%1', threadId: 'thread-1', enabled: true, durableMessages: [],
    }));
    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(api.streamCodexMessages).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});
