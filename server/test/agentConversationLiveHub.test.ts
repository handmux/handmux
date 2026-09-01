import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationLiveHub } from '../src/agent-runtime/conversationLiveHub.js';
import type {
  ConversationEvent,
  ConversationEventSink,
  ConversationLiveHandle,
} from '../src/agent-runtime/conversationTypes.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';

function harness() {
  let sink: ConversationEventSink | undefined;
  const close = vi.fn();
  const open = vi.fn(async (
    _run: AgentRunLease,
    _request: unknown,
    next: ConversationEventSink,
  ): Promise<ConversationLiveHandle> => {
    sink = next;
    return {
      checkpoint: { viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 },
      close,
    };
  });
  return {
    conversation: { open },
    open,
    close,
    emit(event: ConversationEvent) {
      if (!sink) throw new Error('not observing');
      return sink(event);
    },
  };
}

function run() {
  const abort = new AbortController();
  const lease: AgentRunLease = {
    ref: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
    signal: abort.signal,
  };
  return { lease, abort };
}

async function next(subscription: AsyncIterable<ConversationEvent>) {
  return subscription[Symbol.asyncIterator]().next();
}

const hubs: ConversationLiveHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

describe('ConversationLiveHub', () => {
  it('shares one Core observation across independent subscribers', async () => {
    const h = harness();
    const { lease } = run();
    const hub = new ConversationLiveHub({ conversation: h.conversation });
    hubs.push(hub);
    const first = await hub.subscribe(lease);
    const second = await hub.subscribe(lease);
    expect(h.open).toHaveBeenCalledOnce();
    expect(first.checkpoint).toEqual({
      viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
    });
    await h.emit({
      type: 'item.opened', sequence: 1, provisionalId: 'item-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    expect(await next(first)).toMatchObject({ value: { sequence: 1 }, done: false });
    expect(await next(second)).toMatchObject({ value: { sequence: 1 }, done: false });
  });

  it('replays events since the shared observation baseline to a late subscriber', async () => {
    const h = harness();
    const { lease } = run();
    const hub = new ConversationLiveHub({ conversation: h.conversation });
    hubs.push(hub);
    const first = await hub.subscribe(lease);
    await h.emit({
      type: 'item.opened', sequence: 1, provisionalId: 'item-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    expect(await next(first)).toMatchObject({ value: { sequence: 1 } });

    const late = await hub.subscribe(lease);
    expect(late.checkpoint.streamSequence).toBe(0);
    expect(await next(late)).toMatchObject({
      value: { type: 'item.opened', sequence: 1, provisionalId: 'item-1' }, done: false,
    });
    expect(h.open).toHaveBeenCalledOnce();
  });

  it('drops only a slow subscriber with a precise gap', async () => {
    const h = harness();
    const { lease } = run();
    const hub = new ConversationLiveHub({ conversation: h.conversation, maxBufferedEvents: 2 });
    hubs.push(hub);
    const fast = await hub.subscribe(lease);
    const slow = await hub.subscribe(lease);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const waiting = next(fast);
      await h.emit({
        type: 'item.opened', sequence, provisionalId: `item-${sequence}`,
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
      });
      expect(await waiting).toMatchObject({ value: { sequence }, done: false });
    }
    expect(await next(slow)).toEqual({
      value: { type: 'stream.gap', sequence: 3, afterSequence: 0 }, done: false,
    });
    expect(await next(slow)).toEqual({ value: undefined, done: true });

    const waiting = next(fast);
    await h.emit({
      type: 'item.cancelled', sequence: 4, provisionalId: 'item-3', reason: 'stream_reset',
    });
    expect(await waiting).toMatchObject({ value: { sequence: 4 }, done: false });
    expect(h.close).not.toHaveBeenCalled();
  });

  it('terminates the shared observation with a gap when replay memory is exhausted', async () => {
    const h = harness();
    const { lease } = run();
    const hub = new ConversationLiveHub({
      conversation: h.conversation, maxBufferedEvents: 4, maxReplayEvents: 2,
    });
    hubs.push(hub);
    const subscription = await hub.subscribe(lease);
    await h.emit({
      type: 'item.opened', sequence: 1, provisionalId: 'item-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    await h.emit({
      type: 'item.delta', sequence: 2, provisionalId: 'item-1',
      delta: { op: 'text.append', target: 'message.content', blockIndex: 0, text: 'a' },
    });
    await h.emit({
      type: 'item.delta', sequence: 3, provisionalId: 'item-1',
      delta: { op: 'text.append', target: 'message.content', blockIndex: 0, text: 'b' },
    });
    expect(await next(subscription)).toMatchObject({ value: { sequence: 1 } });
    expect(await next(subscription)).toMatchObject({ value: { sequence: 2 } });
    expect(await next(subscription)).toEqual({
      value: { type: 'stream.gap', sequence: 3, afterSequence: 2 }, done: false,
    });
    expect(await next(subscription)).toEqual({ value: undefined, done: true });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('keeps the observation during grace and closes it after the last subscriber leaves', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { lease } = run();
    const hub = new ConversationLiveHub({ conversation: h.conversation, idleGraceMs: 50 });
    hubs.push(hub);
    const first = await hub.subscribe(lease);
    first.close();
    await vi.advanceTimersByTimeAsync(25);
    const second = await hub.subscribe(lease);
    expect(h.open).toHaveBeenCalledOnce();
    second.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('keeps subscribers across history barriers and ends them on run revoke', async () => {
    const h = harness();
    const { lease, abort } = run();
    const hub = new ConversationLiveHub({ conversation: h.conversation });
    hubs.push(hub);
    const first = await hub.subscribe(lease);
    const second = await hub.subscribe(lease);
    await h.emit({
      type: 'history.changed', sequence: 1, viewId: 'view-1', historyVersion: 'history-2',
    });
    expect(await next(first)).toMatchObject({
      value: { type: 'history.changed', historyVersion: 'history-2' }, done: false,
    });
    expect(await next(second)).toMatchObject({ value: { type: 'history.changed' }, done: false });
    expect(h.close).not.toHaveBeenCalled();

    const late = await hub.subscribe(lease);
    expect(late.checkpoint).toEqual({
      viewId: 'view-1', historyVersion: 'history-2', streamSequence: 1,
    });
    expect(h.open).toHaveBeenCalledOnce();
    const waiting = next(late);
    abort.abort('runtime_shutdown');
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(h.close).toHaveBeenCalledOnce();
  });
});
