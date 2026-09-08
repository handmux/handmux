import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAgentConversation, readAgentConversationPage, sendAgentConversationMessage,
  streamAgentConversation, queryAgentConversationSubmission } from '../agentConversationApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import type { ConversationItem } from '../agentConversationTypes.js';
import { useAgentConversation } from './useAgentConversation.js';

vi.mock('../agentConversationApi.js', () => ({
  discoverAgentConversation: vi.fn(), readAgentConversationPage: vi.fn(),
  sendAgentConversationMessage: vi.fn(), streamAgentConversation: vi.fn(),
  queryAgentConversationSubmission: vi.fn(), interruptAgentConversation: vi.fn(),
}));
const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
const identity = { agentId: run.agentId, paneId: run.paneId, sessionId: run.sessionId };
const user = (id: string, text = 'repeat'): ConversationItem => ({
  id, sessionId: run.sessionId, status: 'complete', kind: 'message', role: 'user',
  content: [{ type: 'text', text }],
});
let history: ConversationItem[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  history = [];
  vi.mocked(discoverAgentConversation).mockImplementation(async (current) => ({
    session: { agentId: current.agentId, sessionId: current.sessionId! }, run: current,
    viewId: 'view-1', historyVersion: 'history-1',
    capabilities: { history: true, live: 'delta', send: ['prompt'] },
  }));
  vi.mocked(readAgentConversationPage).mockImplementation(async () => ({ status: 'ok', page: {
    sessionId: run.sessionId, viewId: 'view-1', historyVersion: 'history-1',
    items: history, hasMore: false,
  } }));
  vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
    await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
    if (options?.signal?.aborted) return;
    await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
  });
  vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'accepted' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
async function mount() {
  const hook = renderHook((props: { run: AgentRunRef | null; identity: typeof identity | null }) => (
    useAgentConversation(props.run, undefined, undefined, props.identity)
  ), { initialProps: { run: run as AgentRunRef | null, identity: identity as typeof identity | null } });
  await act(async () => {});
  expect(hook.result.current.status).toBe('ready');
  return hook;
}
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('page-local outgoing lifetime', () => {
  it('expires accepted at first acceptance +120s without retransmission or deleting canonical history', async () => {
    const { result } = await mount();
    await act(async () => { await result.current.send('repeat'); });
    const id = result.current.localSubmissions![0]!.clientRequestId;
    await tick(119_000);
    act(() => result.current.observeSubmissionSnapshot?.([], { settled: [{ id }] }));
    await tick(999);
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    await tick(1);
    expect(result.current.localSubmissions).toEqual([]);
    history = [user('formal')];
    await act(async () => { await result.current.loadLatest?.({ force: true }); });
    expect(result.current.items).toEqual([expect.objectContaining({ item: history[0] })]);
    expect(sendAgentConversationMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['formal at 30s', 'no formal before 120s'] as const)(
    'keeps accepted Queue steer past 10s and hands off without retransmission: %s', async (scenario) => {
      const { result } = await mount();
      let pending!: ReturnType<NonNullable<typeof result.current.beginQueueSteer>>;
      act(() => { pending = result.current.beginQueueSteer!({
        id: 'queue-1', requestId: 'steer-1', text: 'guide now', createdAt: 1,
      }); });
      // Dispatch time is not acceptance time: the full lifetime starts with this reply.
      await tick(5_000);
      const accepted = { status: 'accepted' as const, actionId: pending.actionId, nativeMutation: true as const };
      act(() => result.current.settleQueueSteer!(pending.submissionId, accepted));
      await tick(10_000);
      expect(result.current.items.filter((item) => item.outgoing)).toEqual([
        expect.objectContaining({ outgoing: expect.objectContaining({ status: 'accepted', clientRequestId: pending.submissionId }) }),
      ]);
      await tick(20_000);
      if (scenario === 'formal at 30s') {
        history = [{ ...user('formal-steer', 'guide now'), correlationId: pending.submissionId }];
        await act(async () => { await result.current.loadLatest?.({ force: true }); });
        expect(result.current.items).toEqual([expect.objectContaining({ item: history[0] })]);
      }
      // Repeated receipt must not restart the first acceptance deadline.
      act(() => result.current.settleQueueSteer!(pending.submissionId, accepted));
      await tick(89_999);
      expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(scenario === 'formal at 30s' ? 0 : 1);
      await tick(1);
      expect(result.current.localSubmissions).toEqual([]);
      expect(result.current.items).toEqual(scenario === 'formal at 30s'
        ? [expect.objectContaining({ item: history[0] })] : []);
      expect(sendAgentConversationMessage).not.toHaveBeenCalled();
      expect(queryAgentConversationSubmission).not.toHaveBeenCalled();
    },
  );

  it('starts the 120s only when a queued local message is confirmed dispatched', async () => {
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'queued' });
    const { result } = await mount();
    await act(async () => { await result.current.send('queued', { queueHint: true }); });
    const id = result.current.localSubmissions![0]!.clientRequestId;
    await tick(150_000);
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ owner: 'queue' })]);
    act(() => result.current.observeSubmissionSnapshot?.([], { settled: [{ id }] }));
    await tick(119_999);
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ owner: 'timeline' })]);
    await tick(1);
    expect(result.current.localSubmissions).toEqual([]);
  });

  it('does not expire unknown, and does not extend accepted across a same-session reconnect', async () => {
    vi.mocked(sendAgentConversationMessage).mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result, rerender } = await mount();
    await act(async () => { await result.current.send('unknown').catch(() => {}); });
    await act(async () => { await result.current.send('accepted'); });
    await tick(5_000);
    rerender({ run: null, identity });
    await tick(114_999);
    expect(result.current.localSubmissions).toHaveLength(2);
    await tick(1);
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ status: 'unknown' })]);
    rerender({ run: { ...run, runId: 'run-2' }, identity });
    await act(async () => {});
    await tick(30_000);
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ status: 'unknown' })]);
  });

  it.each(['direct', 'queue'] as const)('keeps first acceptance authoritative over a late %s dispatching snapshot', async (dispatchOrigin) => {
    const { result } = await mount();
    await act(async () => { await result.current.send('repeat'); });
    const id = result.current.localSubmissions![0]!.clientRequestId;
    await tick(119_000);
    act(() => result.current.observeSubmissionSnapshot?.([{ id, text: 'repeat', state: 'dispatching',
      revision: 1, dispatchOrigin, createdAt: 1, updatedAt: 1 }]));
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ status: 'accepted' })]);
    await tick(1_000);
    expect(result.current.localSubmissions).toEqual([]);
  });

  it('does not downgrade an exact settled mapping when the earlier HTTP response arrives late with a turn id', async () => {
    let resolveSend!: (value: Awaited<ReturnType<typeof sendAgentConversationMessage>>) => void;
    vi.mocked(sendAgentConversationMessage).mockResolvedValueOnce({ status: 'unknown' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    const { result } = await mount();
    await act(async () => { await result.current.send('repeat').catch(() => {}); });
    const unknownId = result.current.localSubmissions![0]!.clientRequestId;
    let sent!: Promise<void>;
    act(() => { sent = result.current.send('repeat', { forceNewRequest: true }); });
    const acceptedId = vi.mocked(sendAgentConversationMessage).mock.calls[1]![1].clientRequestId;
    act(() => result.current.observeSubmissionSnapshot?.([], { settled: [{ id: acceptedId, nativeId: 'formal' }] }));
    await tick(3_000);
    await act(async () => { resolveSend({ status: 'accepted', nativeId: 'turn-1' }); await sent; });
    await tick(117_000);
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ clientRequestId: unknownId })]);
    history = [user('formal')];
    await act(async () => { await result.current.loadLatest?.({ force: true }); });
    expect(result.current.items.filter((item) => item.outgoing).map((item) => item.outgoing?.clientRequestId))
      .toEqual([unknownId]);
  });

  it('ignores a send response after leave/return and does not block or overwrite the new page send', async () => {
    let resolveSend!: (value: Awaited<ReturnType<typeof sendAgentConversationMessage>>) => void;
    vi.mocked(sendAgentConversationMessage).mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }))
      .mockResolvedValue({ status: 'accepted' });
    const { result, rerender } = await mount();
    let oldSend!: Promise<void>;
    act(() => { oldSend = result.current.send('old'); });
    rerender({ run: null, identity: null });
    rerender({ run, identity });
    await act(async () => {});
    await act(async () => { await result.current.send('new'); });
    await act(async () => { resolveSend({ status: 'unknown' }); await oldSend; });
    expect(result.current.localSubmissions).toEqual([expect.objectContaining({ text: 'new', status: 'accepted' })]);
  });

  it.each(['pane', 'session', 'leave'] as const)('discards temporary rows on %s switch and return', async (change) => {
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'unknown' });
    const { result, rerender } = await mount();
    await act(async () => { await result.current.send('unknown').catch(() => {}); });
    const oldObserver = result.current.observeSubmissionSnapshot;
    const id = result.current.localSubmissions![0]!.clientRequestId;
    const nextRun = change === 'pane' ? { ...run, paneId: '%2' } : { ...run, sessionId: 'session-2' };
    rerender(change === 'leave' ? { run: null, identity: null }
      : { run: nextRun, identity: { ...nextRun, sessionId: nextRun.sessionId } });
    await act(async () => {});
    rerender({ run, identity });
    await act(async () => {});
    act(() => {
      const snapshot = [{ id, text: 'unknown', state: 'unknown' as const, revision: 1,
        dispatchOrigin: 'direct' as const, createdAt: 1, updatedAt: 1 }];
      oldObserver?.(snapshot);
      result.current.observeSubmissionSnapshot?.(snapshot);
    });
    expect(result.current.localSubmissions).toEqual([]);
  });

  it('does not restore direct/steer transient rows on mount, but still restores real queued rows', async () => {
    const { result } = await mount();
    act(() => result.current.observeSubmissionSnapshot?.([
      { id: 'old', text: 'unknown', state: 'unknown', revision: 1, dispatchOrigin: 'direct', createdAt: 1, updatedAt: 1 },
      { id: 'old-steer', text: 'steering', state: 'steering', revision: 1, dispatchOrigin: 'steer', createdAt: 1, updatedAt: 1 },
      { id: 'queued', text: 'queued', state: 'queued', revision: 1, dispatchOrigin: 'queue', createdAt: 1, updatedAt: 1 },
      { id: 'unknown-queue', text: 'uncertain queue dispatch', state: 'unknown', revision: 1,
        dispatchOrigin: 'queue', createdAt: 1, updatedAt: 1 },
    ]));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: 'queued', owner: 'queue' }),
      expect.objectContaining({ clientRequestId: 'unknown-queue', owner: 'timeline', status: 'unknown' }),
    ]);
  });

  it('clears only temporary state when the app leaves the conversation surface without unmounting history', async () => {
    history = [user('formal', 'formal history')];
    const { result, rerender } = renderHook(({ pageActive }) => (
      useAgentConversation(run, undefined, undefined, identity, pageActive)
    ), { initialProps: { pageActive: true } });
    await act(async () => {});
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'unknown' });
    await act(async () => { await result.current.send('unknown').catch(() => {}); });
    rerender({ pageActive: false });
    expect(result.current.localSubmissions).toEqual([]);
    expect(result.current.canonicalItems).toEqual([expect.objectContaining({ item: history[0] })]);
    rerender({ pageActive: true });
    expect(result.current.localSubmissions).toEqual([]);
    expect(result.current.canonicalItems).toEqual([expect.objectContaining({ item: history[0] })]);
  });

  it('ignores a query response arriving after leaving and reopening the same page', async () => {
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'unknown' });
    let resolveQuery!: (value: Awaited<ReturnType<typeof queryAgentConversationSubmission>>) => void;
    vi.mocked(queryAgentConversationSubmission).mockImplementation(() => new Promise((resolve) => { resolveQuery = resolve; }));
    const { result, rerender } = await mount();
    await act(async () => { await result.current.send('unknown').catch(() => {}); });
    const id = result.current.localSubmissions![0]!.clientRequestId;
    let query!: Promise<boolean>;
    act(() => { query = result.current.retryOutgoing!(id); });
    rerender({ run: null, identity: null });
    rerender({ run, identity });
    await act(async () => {});
    await act(async () => {
      resolveQuery({ status: 'unknown', submission: { id, text: 'unknown', state: 'unknown', revision: 1,
        dispatchOrigin: 'direct', createdAt: 1, updatedAt: 1 } });
      await query;
    });
    expect(result.current.localSubmissions).toEqual([]);
  });

  it.each(['canonical first', 'settled first'] as const)('corrects same-text unknown claim with exact settled mapping: %s', async (order) => {
    vi.mocked(sendAgentConversationMessage).mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'accepted', nativeId: 'turn-1' });
    const { result } = await mount();
    await act(async () => { await result.current.send('repeat').catch(() => {}); });
    const unknownId = result.current.localSubmissions![0]!.clientRequestId;
    await act(async () => { await result.current.send('repeat', { forceNewRequest: true }); });
    const acceptedId = result.current.localSubmissions!.find((item) => item.status === 'accepted')!.clientRequestId;
    const settle = () => act(() => result.current.observeSubmissionSnapshot?.([], {
      settled: [{ id: acceptedId, nativeId: 'formal' }],
    }));
    if (order === 'settled first') settle();
    history = [user('formal')];
    await act(async () => { await result.current.loadLatest?.({ force: true }); });
    if (order === 'canonical first') settle();
    expect(result.current.items.filter((item) => item.outgoing).map((item) => item.outgoing?.clientRequestId))
      .toEqual([unknownId]);
    expect(result.current.items.filter((item) => !item.outgoing)).toHaveLength(1);
    await tick(10_000);
    await act(async () => { await result.current.loadLatest?.({ force: true }); });
    expect(result.current.items.filter((item) => item.outgoing).map((item) => item.outgoing?.clientRequestId))
      .toEqual([unknownId]);
    expect(result.current.items.filter((item) => !item.outgoing)).toHaveLength(1);
  });
});
