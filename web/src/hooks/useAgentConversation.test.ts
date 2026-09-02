import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverAgentConversation,
  interruptAgentConversation,
  queryAgentConversationSubmission,
  readAgentConversationPage,
  sendAgentConversationMessage,
  streamAgentConversation,
} from '../agentConversationApi.js';
import type { AgentConversationStreamOptions } from '../agentConversationApi.js';
import { ApiError } from '../apiErrors.js';
import {
  projectConversationSubmissions,
  queueSubmissionId,
} from '../conversationSubmissionProjection.js';
import { useAgentConversation } from './useAgentConversation.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

vi.mock('../agentConversationApi.js', () => ({
  discoverAgentConversation: vi.fn(),
  readAgentConversationPage: vi.fn(),
  streamAgentConversation: vi.fn(),
  sendAgentConversationMessage: vi.fn(),
  interruptAgentConversation: vi.fn(),
  queryAgentConversationSubmission: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('useAgentConversation', () => {
  it.each([
    ['timeout', new Error('first page timeout')],
    ['session unavailable', new ApiError(
      'conversation session unavailable', 503,
      'conversation session unavailable', 'conversation_session_unavailable',
    )],
  ])('keeps the unified loading state while a first-page %s retries', async (_label, failure) => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll' },
    });
    vi.mocked(readAgentConversationPage)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], hasMore: false,
        },
      });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(readAgentConversationPage).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('loading');
    expect(result.current.canonicalReady).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe('ready'), { timeout: 2_500 });
    expect(readAgentConversationPage).toHaveBeenCalledTimes(2);
    unmount();
  });

  it.each([400, 404])('stops retrying a non-retryable HTTP %s response', async (status) => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockRejectedValue(new ApiError(
      `request rejected with ${status}`, status, `request rejected with ${status}`,
    ));

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeNull();
    expect(discoverAgentConversation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each([
    ['a missing conversation', null],
    ['an invalid descriptor', new Error('Agent Conversation discovery returned an invalid descriptor')],
  ])('stops retrying %s without exposing provider details', async (_label, failure) => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    if (failure) vi.mocked(discoverAgentConversation).mockRejectedValue(failure);
    else vi.mocked(discoverAgentConversation).mockResolvedValue(null);

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeNull();
    expect(discoverAgentConversation).toHaveBeenCalledTimes(1);
    expect(readAgentConversationPage).not.toHaveBeenCalled();
    unmount();
  });

  it('does not turn an unsupported 5xx response into an infinite retry', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockRejectedValue(new ApiError(
      'conversation unsupported', 503, 'conversation unsupported', 'unsupported',
    ));

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(discoverAgentConversation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('retries the Server live-hub unavailable 409 response', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const held = deferred<void>();
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    vi.mocked(streamAgentConversation)
      .mockRejectedValueOnce(new ApiError(
        'conversation live stream unavailable', 409, 'conversation live stream unavailable',
      ))
      .mockImplementationOnce(async (_run, options) => {
        await options?.onReady?.({
          viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
        });
        await held.promise;
      });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(streamAgentConversation).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ready'), { timeout: 2_500 });
    expect(streamAgentConversation).toHaveBeenCalledTimes(2);
    held.resolve();
    unmount();
  });

  it('keeps existing canonical history with a compact reconnect state after a stream timeout', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const disconnect = deferred<void>();
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'durable-1', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'keep history visible' }],
        }],
        hasMore: false,
      },
    });
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await disconnect.promise;
      throw new Error('stream timeout');
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });

    await act(async () => { disconnect.resolve(); });
    await waitFor(() => expect(result.current.status).toBe('reconnecting'));
    expect(result.current.canonicalReady).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });
    unmount();
  });

  it('uses durable polling without opening SSE when an adapter declares live: poll', async () => {
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'other-agent', sessionId: 'session-1' },
      run: { agentId: 'other-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll' },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'item-1', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'poll result' }],
        }],
        hasMore: false,
      },
    });

    const { result, unmount } = renderHook(() => useAgentConversation({
      agentId: 'other-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items[0]?.item).toMatchObject({ id: 'item-1' });
    expect(streamAgentConversation).not.toHaveBeenCalled();
    unmount();
  });

  it('synchronously hides the previous conversation on an identity switch', async () => {
    const first = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const second = { agentId: 'pi', paneId: '%2', runId: 'run-2', sessionId: 'session-2' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: run.agentId, sessionId: run.sessionId! }, run,
      viewId: `view-${run.sessionId}`, historyVersion: `history-${run.sessionId}`,
      capabilities: { history: true, live: 'poll', send: ['prompt'] },
    }));
    vi.mocked(readAgentConversationPage).mockImplementation(async (run) => ({
      status: 'ok',
      page: {
        sessionId: run.sessionId!, viewId: `view-${run.sessionId}`,
        historyVersion: `history-${run.sessionId}`,
        items: [{
          id: `item-${run.sessionId}`, sessionId: run.sessionId!, status: 'complete',
          kind: 'message', role: 'assistant', content: [{ type: 'text', text: run.sessionId! }],
        }],
        hasMore: false,
      },
    }));
    const renderSnapshots: Array<{ ids: Array<string | null>; descriptorSession: string | null }> = [];
    const { result, rerender, unmount } = renderHook(
      ({ run }) => {
        const conversation = useAgentConversation(run);
        renderSnapshots.push({
          ids: conversation.items.map(({ item }) => 'id' in item ? item.id : null),
          descriptorSession: conversation.descriptor?.session.sessionId ?? null,
        });
        return conversation;
      },
      { initialProps: { run: first } },
    );
    await waitFor(() => expect(result.current.items[0]?.item)
      .toMatchObject({ id: 'item-session-1' }));

    renderSnapshots.length = 0;
    rerender({ run: second });

    // The first render belongs to the new pane but runs before passive effects. It must already be scoped.
    expect(renderSnapshots[0]).toEqual({ ids: [], descriptorSession: null });
    expect(result.current.status).toBe('loading');
    expect(result.current.canonicalReady).toBe(false);
    await waitFor(() => expect(result.current.items[0]?.item)
      .toMatchObject({ id: 'item-session-2' }));
    unmount();
  });

  it('refreshes a restarted Server run and retries a send once with the same idempotency key', async () => {
    const stale = { agentId: 'codex', paneId: '%1', runId: 'run-old', sessionId: 'session-1' };
    const fresh = { ...stale, runId: 'run-new' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run: stale,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt'], interrupt: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: { sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false },
    });
    const send = vi.mocked(sendAgentConversationMessage);
    send
      .mockRejectedValueOnce(new ApiError('stale agent run', 409, 'stale agent run'))
      .mockResolvedValueOnce({ status: 'accepted' });
    const refreshRun = vi.fn(async () => fresh);
    const { result, unmount } = renderHook(() => useAgentConversation(stale, undefined, refreshRun));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.send('继续'); });

    expect(refreshRun).toHaveBeenCalledWith(stale);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(stale);
    expect(send.mock.calls[1]?.[0]).toEqual(fresh);
    expect(send.mock.calls[1]?.[1].clientRequestId)
      .toBe(send.mock.calls[0]?.[1].clientRequestId);
    unmount();
  });

  it('reuses an unknown transport attempt for unchanged text and creates a new id after editing', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: { sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false },
    });
    const timeout = new Error('transport timeout');
    const send = vi.mocked(sendAgentConversationMessage).mockRejectedValue(timeout);
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const attempt = async (text: string): Promise<unknown> => {
      let failure: unknown;
      await act(async () => {
        try { await result.current.send(text); } catch (cause) { failure = cause; }
      });
      return failure;
    };

    expect(await attempt('unchanged')).toMatchObject({ message: 'transport timeout', deliveryUnknown: true });
    expect(await attempt('unchanged')).toMatchObject({ message: 'transport timeout', deliveryUnknown: true });
    expect(await attempt('edited')).toMatchObject({ message: 'transport timeout', deliveryUnknown: true });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]?.[1].clientRequestId)
      .toBe(send.mock.calls[0]?.[1].clientRequestId);
    expect(send.mock.calls[2]?.[1].clientRequestId)
      .not.toBe(send.mock.calls[1]?.[1].clientRequestId);
    unmount();
  });

  it('hands an optimistic user row to the correlated live canonical row exactly once', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'old-same', sessionId: 'session-1', status: 'complete', kind: 'message', role: 'user',
          content: [{ type: 'text', text: 'same text' }],
        }], hasMore: false,
      },
    });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.send('same text'); });
    const clientRequestId = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!clientRequestId) throw new Error('expected send request id');
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'pi-user-live',
        draft: {
          kind: 'message', role: 'user', correlationId: clientRequestId,
          content: [{ type: 'text', text: 'same text' }],
        },
      });
    });
    await waitFor(() => expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(0));
    expect(result.current.items.filter(({ item }) => item.kind === 'message'
      && item.role === 'user')).toHaveLength(2);
    held.resolve();
    unmount();
  });

  it('does not let prepended older same-text history consume an unknown outgoing row', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt'] },
    });
    vi.mocked(readAgentConversationPage).mockImplementation(async (_run, request) => ({
      status: 'ok', page: request.before ? {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'older-same', sessionId: 'session-1', status: 'complete', sourceCreatedAt: 1,
          kind: 'message', role: 'user', content: [{ type: 'text', text: 'same text' }],
        }], hasMore: false,
      } : {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'tail', sessionId: 'session-1', status: 'complete', kind: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'tail' }],
        }], previousCursor: 'older', hasMore: true,
      },
    }));
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({
      status: 'unknown', reason: 'delivery_unconfirmed',
    });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.send('same text').catch(() => {});
    });
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    unmount();
  });

  it('allows one canonical row to claim only one of two identical optimistic rows', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false,
      },
    });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.send('repeat'); });
    await act(async () => { await result.current.send('repeat'); });
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(2);
    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'one-user-row',
        draft: { kind: 'message', role: 'user', content: [{ type: 'text', text: 'repeat' }] },
      });
    });
    await waitFor(() => expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1));
    held.resolve();
    unmount();
  });

  it('clears a send attempt after accepted, queued, or rejected but retains an unknown receipt', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: { sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false },
    });
    const send = vi.mocked(sendAgentConversationMessage);
    send
      .mockResolvedValueOnce({ status: 'accepted' })
      .mockResolvedValueOnce({ status: 'accepted' })
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({
        status: 'rejected', reason: 'provider_rejected', nativeMutation: false,
      })
      .mockResolvedValueOnce({
        status: 'rejected', reason: 'provider_rejected', nativeMutation: false,
      })
      .mockResolvedValueOnce({ status: 'unknown', reason: 'delivery_unconfirmed' })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const attempt = async (text: string): Promise<unknown> => {
      let failure: unknown;
      await act(async () => {
        try { await result.current.send(text); } catch (cause) { failure = cause; }
      });
      return failure;
    };

    await act(async () => { await result.current.send('accepted'); });
    await act(async () => { await result.current.send('accepted'); });
    await act(async () => { await result.current.send('queued'); });
    expect(result.current.items.filter((item) => item.outgoing?.text === 'queued')).toHaveLength(0);
    await act(async () => { await result.current.send('queued'); });
    expect(await attempt('rejected')).toEqual(expect.objectContaining({
      message: 'Agent rejected the message', deliveryUnknown: false,
    }));
    expect(result.current.items.filter((item) => item.outgoing?.text === 'rejected')).toHaveLength(0);
    expect(await attempt('rejected')).toEqual(expect.objectContaining({
      message: 'Agent rejected the message', deliveryUnknown: false,
    }));
    expect(await attempt('unknown')).toEqual(expect.objectContaining({
      message: 'Message delivery is unknown', deliveryUnknown: true,
    }));
    await act(async () => { await result.current.send('unknown'); });

    const ids = send.mock.calls.map((call) => call[1].clientRequestId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[2]);
    expect(ids[5]).not.toBe(ids[4]);
    expect(ids[7]).toBe(ids[6]);
    unmount();
  });

  it('puts a known-busy prompt in Queue ownership before the send request settles', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt', 'steer', 'follow_up'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    const pending = deferred<{ status: 'queued' }>();
    vi.mocked(sendAgentConversationMessage).mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let operation!: Promise<void>;
    act(() => { operation = result.current.send('queue without flashing', { queueHint: true }); });
    expect(sendAgentConversationMessage).toHaveBeenCalledWith(run, expect.objectContaining({
      text: 'queue without flashing', delivery: 'prompt',
    }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ text: 'queue without flashing', owner: 'queue', status: 'sending' }),
    ]);

    await act(async () => { pending.resolve({ status: 'queued' }); await operation; });
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ owner: 'queue', status: 'accepted' }),
    ]);
    const submissionId = result.current.localSubmissions?.[0]?.clientRequestId;
    if (!submissionId) throw new Error('expected queued submission id');
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: submissionId, owner: 'queue', status: 'accepted' }),
    ]);
    const durableQueue = [{
      id: 'durable-queue-row', requestId: submissionId,
      text: 'queue without flashing', createdAt: 1,
    }];
    act(() => result.current.observeQueueSnapshot?.(durableQueue));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, queue: durableQueue,
    }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: submissionId, owner: 'queue', status: 'accepted' }),
    ]);

    act(() => result.current.observeQueueSnapshot?.([]));
    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, queue: [], settled: [],
    }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.localSubmissions).toEqual([]);
    unmount();
  });

  it('keeps exactly one owner through local, durable Queue, dispatch, settled, and canonical handoff', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'queued' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.send('handoff once', { queueHint: true }); });
    const id = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!id) throw new Error('expected send request id');
    const durableQueue = [{
      id: 'durable-row', requestId: id, text: 'handoff once', createdAt: 1,
      state: 'queued' as const, revision: 1,
    }];
    const ownerCount = (queue: typeof durableQueue | []): number => {
      const canonical = result.current.canonicalItems ?? [];
      const projected = projectConversationSubmissions(
        canonical, result.current.localSubmissions ?? [], queue,
      );
      const canonicalOwners = canonical.filter(({ item }) => item.kind === 'message'
        && item.role === 'user' && item.correlationId === id).length;
      return canonicalOwners
        + projected.timeline.filter((entry) => entry.clientRequestId === id).length
        + projected.queue.filter((entry) => queueSubmissionId(entry) === id).length;
    };

    expect(ownerCount([])).toBe(1);
    act(() => result.current.observeQueueSnapshot?.(durableQueue));
    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, queue: durableQueue, settled: [],
    }));
    expect(ownerCount(durableQueue)).toBe(1);
    expect(result.current.localSubmissions).toHaveLength(1);

    act(() => result.current.observeQueueSnapshot?.([]));
    act(() => result.current.observeSubmissionSnapshot?.([{
      id, text: 'handoff once', state: 'dispatching', revision: 2,
      dispatchOrigin: 'queue', createdAt: 1, updatedAt: 2,
    }], { authoritative: true, queue: [], settled: [] }));
    expect(ownerCount([])).toBe(1);

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, queue: [], settled: [{ id, nativeId: 'native-turn-1' }],
    }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, owner: 'timeline', status: 'accepted' }),
    ]);
    expect(ownerCount([])).toBe(1);

    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'canonical-user',
        draft: {
          kind: 'message', role: 'user', correlationId: id,
          content: [{ type: 'text', text: 'handoff once' }],
        },
      });
    });
    await waitFor(() => expect(result.current.localSubmissions).toEqual([]));
    expect(ownerCount([])).toBe(1);
    held.resolve();
    unmount();
  });

  it('does not let a stale empty snapshot retire locally accepted Queue owners', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    const pending = deferred<{ status: 'queued' }>();
    vi.mocked(sendAgentConversationMessage)
      .mockResolvedValueOnce({ status: 'queued' })
      .mockResolvedValueOnce({ status: 'unknown', reason: 'delivery_unconfirmed' })
      .mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.send('accepted queue', { queueHint: true }); });
    await act(async () => {
      await result.current.send('unknown queue', { queueHint: true }).catch(() => {});
    });
    let sending!: Promise<void>;
    act(() => { sending = result.current.send('sending queue', { queueHint: true }); });
    expect(result.current.localSubmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'accepted queue', owner: 'queue', status: 'accepted' }),
      expect.objectContaining({ text: 'unknown queue', owner: 'queue', status: 'unknown' }),
      expect.objectContaining({ text: 'sending queue', owner: 'queue', status: 'sending' }),
    ]));

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, settled: [],
    }));
    expect(result.current.localSubmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'accepted queue', owner: 'queue', status: 'accepted' }),
      expect.objectContaining({ text: 'unknown queue', owner: 'queue', status: 'unknown' }),
      expect.objectContaining({ text: 'sending queue', owner: 'queue', status: 'sending' }),
    ]));

    await act(async () => { pending.resolve({ status: 'queued' }); await sending; });
    unmount();
  });

  it('moves Queue steer to Timeline immediately and rolls a definitive failure back', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt', 'steer'] },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const queued = { id: 'queue-row', requestId: 'submission-1', text: 'guide now', createdAt: 1 };

    let pending!: { submissionId: string; actionId: string; baseRevision: number };
    act(() => { pending = result.current.beginQueueSteer!(queued); });
    expect(pending).toMatchObject({
      submissionId: 'submission-1', baseRevision: 0, anchor: { viewId: 'view-1' },
    });
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({
        outgoing: expect.objectContaining({ clientRequestId: 'submission-1', status: 'sending' }),
      }),
    ]);
    act(() => result.current.settleQueueSteer?.('submission-1', {
      status: 'rejected', nativeMutation: false, actionId: pending.actionId, revision: 2,
      submission: {
        id: 'submission-1', text: 'guide now', state: 'queued', revision: 2,
        dispatchOrigin: 'queue', createdAt: 1, updatedAt: 2,
      },
    }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);

    act(() => result.current.beginQueueSteer?.(queued));
    act(() => result.current.settleQueueSteer?.('submission-1', {
      status: 'unknown', nativeMutation: 'unknown',
    }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({ outgoing: expect.objectContaining({ status: 'unknown' }) }),
    ]);
    unmount();
  });

  it('restores only active Core submissions after a Web reconnect', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true, steer: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const snapshot = (state: 'queued' | 'steering' | 'unknown', revision: number) => ({
      id: 'submission-restored', text: 'restore me', state, revision,
      dispatchOrigin: 'steer' as const, createdAt: 1, updatedAt: revision,
    });

    act(() => result.current.observeSubmissionSnapshot?.([snapshot('steering', 3)]));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({ outgoing: expect.objectContaining({ status: 'sending' }) }),
    ]);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({ outgoing: expect.objectContaining({ status: 'sending' }) }),
    ]);
    act(() => result.current.observeSubmissionSnapshot?.([snapshot('queued', 2)]));
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([snapshot('queued', 4)]));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    act(() => result.current.observeSubmissionSnapshot?.([snapshot('unknown', 5)]));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({ outgoing: expect.objectContaining({ status: 'unknown' }) }),
    ]);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([
      expect.objectContaining({ outgoing: expect.objectContaining({ status: 'unknown' }) }),
    ]);
    unmount();
  });

  it('does not recreate outgoing when a settled receipt arrives after canonical history', async () => {
    const run = { agentId: 'claude', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'claude', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [{
        id: 'baseline-tail', sessionId: 'session-1', status: 'complete',
        kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'ready' }],
      }, {
        id: 'canonical-user', sessionId: 'session-1', status: 'complete',
        kind: 'message', role: 'user', content: [{ type: 'text', text: 'restore me' }],
      }], hasMore: false,
    } });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, settled: [{ id: 'submission-restored' }],
    }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.items.filter(({ item }) => item.kind === 'message'
      && item.role === 'user')).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.items.filter(({ item }) => item.kind === 'message'
      && item.role === 'user')).toHaveLength(1);
    unmount();
  });

  it('keeps a settled local row across controls-first ordering until canonical claims it', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'queued' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.send('background work', { queueHint: true }); });
    const id = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!id) throw new Error('expected send request id');
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, owner: 'queue' }),
    ]);
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true,
      settled: [{ id, nativeId: 'native-turn-1' }],
    }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, owner: 'timeline', status: 'accepted' }),
    ]);
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, settled: [{ id, nativeId: 'native-turn-1' }],
    }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, owner: 'timeline', status: 'accepted' }),
    ]);
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([{
      id, text: 'background work', state: 'unknown', revision: 3,
      dispatchOrigin: 'queue', queueOrderKey: '0001', createdAt: 1, updatedAt: 2,
    }]));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, owner: 'timeline', status: 'accepted' }),
    ]);

    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'canonical-user',
        draft: {
          kind: 'message', role: 'user', correlationId: id,
          content: [{ type: 'text', text: 'background work' }],
        },
      });
    });
    await waitFor(() => expect(result.current.items.filter((item) => item.outgoing)).toEqual([]));
    expect(result.current.items.filter(({ item }) => item.kind === 'message'
      && item.role === 'user')).toHaveLength(1);
    held.resolve();
    unmount();
  });

  it('uses durable Queue text after an edit when the row settles into Timeline', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'queued' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.send('old text', { queueHint: true }); });
    const id = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!id) throw new Error('expected send request id');
    act(() => result.current.observeQueueSnapshot?.([{
      id: 'queue-row', requestId: id, text: 'edited text', createdAt: 1, revision: 2,
    }]));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: id, text: 'edited text', revision: 2 }),
    ]);

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true, settled: [{ id }],
    }));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({
        clientRequestId: id, text: 'edited text', owner: 'timeline', status: 'accepted',
      }),
    ]);
    expect(result.current.items.find((item) => item.outgoing)?.item).toMatchObject({
      kind: 'message', role: 'user', content: [{ type: 'text', text: 'edited text' }],
    });
    unmount();
  });

  it('does not recreate historical outgoing text from a settled receipt on a fresh page', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.observeSubmissionSnapshot?.([], {
      authoritative: true,
      settled: [{ id: 'historical-submission', nativeId: 'native-turn-old' }],
    }));
    expect(result.current.localSubmissions).toEqual([]);
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    unmount();
  });

  it('settles consecutive identical local rows by stable id without consuming its sibling', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'queued' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.send('repeat', { queueHint: true }); });
    await act(async () => { await result.current.send('repeat', { queueHint: true }); });
    const firstId = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    const secondId = vi.mocked(sendAgentConversationMessage).mock.calls[1]?.[1].clientRequestId;
    if (!firstId || !secondId || firstId === secondId) throw new Error('expected two stable request ids');

    act(() => result.current.observeSubmissionSnapshot?.([{
      id: secondId, text: 'repeat', state: 'queued', revision: 1,
      queueOrderKey: '0001', createdAt: 1, updatedAt: 1,
    }], {
      authoritative: true,
      settled: [{ id: firstId }],
    }));
    expect(result.current.localSubmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientRequestId: firstId, owner: 'timeline', status: 'accepted' }),
      expect.objectContaining({ clientRequestId: secondId, owner: 'queue' }),
    ]));
    expect(result.current.items.filter((item) => item.outgoing)
      .map((item) => item.outgoing?.clientRequestId)).toEqual([firstId]);

    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'canonical-first',
        draft: {
          kind: 'message', role: 'user', correlationId: firstId,
          content: [{ type: 'text', text: 'repeat' }],
        },
      });
    });
    await waitFor(() => expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: secondId, owner: 'queue' }),
    ]));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    held.resolve();
    unmount();
  });

  it('keeps canonical single-owner when it arrives after an accepted send receipt', async () => {
    const run = { agentId: 'claude', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'claude', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false,
    } });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    vi.mocked(sendAgentConversationMessage).mockResolvedValue({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.send('restore me'); });
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.items.filter((item) => item.outgoing)).toHaveLength(1);

    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'canonical-user',
        draft: {
          kind: 'message', role: 'user', content: [{ type: 'text', text: 'restore me' }],
        },
      });
    });
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    expect(result.current.items.filter(({ item }) => item.kind === 'message'
      && item.role === 'user')).toHaveLength(1);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.items.filter((item) => item.outgoing)).toEqual([]);
    held.resolve();
    unmount();
  });

  it('restores an unknown Queue dispatch to Timeline ownership after Core claimed it', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.observeSubmissionSnapshot?.([{
      id: 'submission-queued-unknown', text: 'keep me queued', state: 'unknown', revision: 4,
      dispatchOrigin: 'queue', queueOrderKey: '0001', createdAt: 1, updatedAt: 2,
    }]));

    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({
        clientRequestId: 'submission-queued-unknown', owner: 'timeline', status: 'unknown',
      }),
    ]);
    unmount();
  });

  it('keeps a pending steer on Timeline across same-revision Queue snapshots', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true, steer: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => { result.current.beginQueueSteer?.({
      id: 'queue-row', requestId: 'submission-1', text: 'guide', createdAt: 1, revision: 7,
    }); });
    act(() => result.current.observeSubmissionSnapshot?.([{
      id: 'submission-1', text: 'guide', state: 'queued', revision: 7,
      dispatchOrigin: 'queue', createdAt: 1, updatedAt: 2,
    }]));
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ owner: 'timeline', baseRevision: 7, revision: 7 }),
    ]);
    unmount();
  });

  it('queries a recovered unknown submission without invoking send again', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(queryAgentConversationSubmission).mockResolvedValue({ status: 'unknown', submission: {
      id: 'submission-unknown', text: 'do this once', state: 'unknown', revision: 4,
      dispatchOrigin: 'direct', createdAt: 1, updatedAt: 2,
    } });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.observeSubmissionSnapshot?.([{
      id: 'submission-unknown', text: 'do this once', state: 'unknown', revision: 3,
      dispatchOrigin: 'direct', createdAt: 1, updatedAt: 1,
    }]));

    let remainsUnknown: boolean | void = false;
    await act(async () => {
      remainsUnknown = await result.current.retryOutgoing?.('submission-unknown');
    });
    expect(queryAgentConversationSubmission).toHaveBeenCalledWith(run, {
      submissionId: 'submission-unknown',
    });
    expect(sendAgentConversationMessage).not.toHaveBeenCalled();
    expect(remainsUnknown).toBe(true);
    unmount();
  });

  it('resends a confirmed unknown delivery as a new request while retaining the original', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(sendAgentConversationMessage)
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.send('run it again').catch(() => {});
    });
    const otherUnknownId = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    act(() => result.current.observeSubmissionSnapshot?.([{
      id: 'submission-unknown', text: 'run it again', state: 'unknown', revision: 3,
      dispatchOrigin: 'queue', createdAt: 1, updatedAt: 2,
    }]));

    await act(async () => { await result.current.resendOutgoing?.('submission-unknown'); });

    expect(sendAgentConversationMessage).toHaveBeenCalledWith(run, expect.objectContaining({
      text: 'run it again', delivery: 'prompt',
    }));
    const replacementId = vi.mocked(sendAgentConversationMessage).mock.calls[1]?.[1].clientRequestId;
    expect(replacementId).not.toBe('submission-unknown');
    expect(replacementId).not.toBe(otherUnknownId);
    expect(result.current.localSubmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientRequestId: 'submission-unknown', status: 'unknown' }),
      expect.objectContaining({ clientRequestId: replacementId, status: 'accepted' }),
    ]));
    unmount();
  });

  it('retries an unknown Queue submission with the same id and text', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(sendAgentConversationMessage)
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockImplementationOnce(async (_run, request) => ({ status: 'queued', submission: {
        id: request.clientRequestId, text: request.text, state: 'queued', revision: 5,
        createdAt: 1, updatedAt: 3,
      } }));
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.send('retry queue', { queueHint: true }).catch(() => {});
    });
    const clientRequestId = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!clientRequestId) throw new Error('expected Queue request id');
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId, owner: 'queue', status: 'unknown' }),
    ]);

    await act(async () => { await result.current.retryOutgoing?.(clientRequestId); });

    expect(sendAgentConversationMessage).toHaveBeenNthCalledWith(2, run, {
      clientRequestId, text: 'retry queue', delivery: 'prompt',
    });
    expect(queryAgentConversationSubmission).not.toHaveBeenCalled();
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({
        clientRequestId, owner: 'queue', status: 'accepted',
      }),
    ]);
    unmount();
  });

  it('falls back to a submission-only query when a recovered steer action conflicts', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true, steer: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(queryAgentConversationSubmission)
      .mockResolvedValueOnce({ status: 'rejected', reason: 'conflict', nativeMutation: false })
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.observeSubmissionSnapshot?.([{
      id: 'submission-steer', text: 'guide', state: 'unknown', revision: 8,
      dispatchOrigin: 'steer', steerActionId: 'stale-action', createdAt: 1, updatedAt: 2,
    }]));

    await act(async () => { await result.current.retryOutgoing?.('submission-steer'); });
    expect(queryAgentConversationSubmission).toHaveBeenNthCalledWith(1, run, {
      submissionId: 'submission-steer', actionId: 'stale-action',
    });
    expect(queryAgentConversationSubmission).toHaveBeenNthCalledWith(2, run, {
      submissionId: 'submission-steer',
    });
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ clientRequestId: 'submission-steer', status: 'accepted' }),
    ]);
    act(() => result.current.observeSubmissionSnapshot?.([], { authoritative: true }));
    expect(result.current.localSubmissions).toEqual([]);
    unmount();
  });

  it('treats an HTTP 500 send as unknown and keeps the original stable id', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
      items: [], hasMore: false,
    } });
    vi.mocked(sendAgentConversationMessage)
      .mockRejectedValue(new ApiError('server failed', 500, 'server failed'));
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let first: unknown;
    let second: unknown;
    await act(async () => { try { await result.current.send('once'); } catch (cause) { first = cause; } });
    await act(async () => { try { await result.current.send('once'); } catch (cause) { second = cause; } });
    expect(first).toMatchObject({ deliveryUnknown: true });
    expect(second).toMatchObject({ deliveryUnknown: true });
    expect(sendAgentConversationMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendAgentConversationMessage).mock.calls[1]?.[1].clientRequestId)
      .toBe(vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId);
    expect(result.current.localSubmissions).toEqual([
      expect.objectContaining({ status: 'unknown' }),
    ]);
    unmount();
  });

  it('forgets an unknown after canonical correlation so the same text starts with a new id', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', sendable: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({ status: 'ok', page: {
      sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false,
    } });
    vi.mocked(sendAgentConversationMessage)
      .mockResolvedValueOnce({ status: 'unknown', reason: 'delivery_unconfirmed' })
      .mockResolvedValueOnce({ status: 'accepted' });
    let stream: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      stream = options;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await held.promise;
    });
    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.send('same').catch(() => {}); });
    const firstId = vi.mocked(sendAgentConversationMessage).mock.calls[0]?.[1].clientRequestId;
    if (!firstId) throw new Error('expected stable request id');
    await act(async () => {
      await stream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'canonical-user',
        draft: {
          kind: 'message', role: 'user', correlationId: firstId,
          content: [{ type: 'text', text: 'same' }],
        },
      });
    });
    await waitFor(() => expect(result.current.localSubmissions).toEqual([]));
    await act(async () => { await result.current.send('same'); });
    expect(vi.mocked(sendAgentConversationMessage).mock.calls[1]?.[1].clientRequestId)
      .not.toBe(firstId);
    held.resolve();
    unmount();
  });

  it('scopes concurrent sends to their Agent session when the visible conversation changes', async () => {
    const first = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const second = { agentId: 'pi', paneId: '%2', runId: 'run-2', sessionId: 'session-2' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: run.agentId, sessionId: run.sessionId! }, run,
      viewId: `view-${run.sessionId}`, historyVersion: `history-${run.sessionId}`,
      capabilities: { history: true, live: 'poll', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockImplementation(async (run) => ({
      status: 'ok',
      page: {
        sessionId: run.sessionId!, viewId: `view-${run.sessionId}`,
        historyVersion: `history-${run.sessionId}`, items: [], hasMore: false,
      },
    }));
    const firstSend = deferred<{ status: 'accepted' }>();
    const secondSend = deferred<{ status: 'accepted' }>();
    const send = vi.mocked(sendAgentConversationMessage).mockImplementation(async (run) => (
      run.sessionId === first.sessionId ? firstSend.promise : secondSend.promise
    ));
    const { result, rerender, unmount } = renderHook(
      ({ run }) => useAgentConversation(run),
      { initialProps: { run: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let firstPromise!: Promise<void>;
    act(() => { firstPromise = result.current.send('from first'); });
    await waitFor(() => expect(result.current.sending).toBe(true));

    rerender({ run: second });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.sending).toBe(false);
    let secondPromise!: Promise<void>;
    act(() => { secondPromise = result.current.send('from second'); });
    await waitFor(() => expect(result.current.sending).toBe(true));

    await act(async () => {
      firstSend.resolve({ status: 'accepted' });
      await firstPromise;
    });
    expect(result.current.sending).toBe(true);
    await expect(result.current.send('duplicate second')).rejects.toThrow('already being sent');
    expect(send).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondSend.resolve({ status: 'accepted' });
      await secondPromise;
    });
    expect(result.current.sending).toBe(false);
    unmount();
  });

  it('does not let an old interrupt completion clear the current session interrupt state', async () => {
    const first = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const second = { agentId: 'pi', paneId: '%2', runId: 'run-2', sessionId: 'session-2' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: run.agentId, sessionId: run.sessionId! }, run,
      viewId: `view-${run.sessionId}`, historyVersion: `history-${run.sessionId}`,
      capabilities: { history: true, live: 'poll', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockImplementation(async (run) => ({
      status: 'ok',
      page: {
        sessionId: run.sessionId!, viewId: `view-${run.sessionId}`,
        historyVersion: `history-${run.sessionId}`, items: [], hasMore: false,
      },
    }));
    const firstInterrupt = deferred<{ status: 'accepted' }>();
    const secondInterrupt = deferred<{ status: 'accepted' }>();
    vi.mocked(interruptAgentConversation).mockImplementation(async (run) => (
      run.sessionId === first.sessionId ? firstInterrupt.promise : secondInterrupt.promise
    ));
    const { result, rerender, unmount } = renderHook(
      ({ run }) => useAgentConversation(run),
      { initialProps: { run: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let firstPromise!: Promise<void>;
    act(() => { firstPromise = result.current.interrupt(); });
    await waitFor(() => expect(result.current.interrupting).toBe(true));
    rerender({ run: second });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.interrupting).toBe(false);
    let secondPromise!: Promise<void>;
    act(() => { secondPromise = result.current.interrupt(); });
    await waitFor(() => expect(result.current.interrupting).toBe(true));

    await act(async () => {
      firstInterrupt.resolve({ status: 'accepted' });
      await firstPromise;
    });
    expect(result.current.interrupting).toBe(true);

    await act(async () => {
      secondInterrupt.resolve({ status: 'accepted' });
      await secondPromise;
    });
    expect(result.current.interrupting).toBe(false);
    unmount();
  });

  it('never retries a stale action into a different session', async () => {
    const stale = { agentId: 'codex', paneId: '%1', runId: 'run-old', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run: stale,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll', send: ['prompt'], interrupt: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: { sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false },
    });
    const failure = new ApiError('stale agent run', 409, 'stale agent run');
    vi.mocked(interruptAgentConversation).mockRejectedValueOnce(failure);
    const refreshRun = vi.fn(async () => ({ ...stale, runId: 'run-new', sessionId: 'session-2' }));
    const { result, unmount } = renderHook(() => useAgentConversation(stale, undefined, refreshRun));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await expect(act(async () => result.current.interrupt())).rejects.toBe(failure);

    expect(refreshRun).toHaveBeenCalledWith(stale);
    expect(interruptAgentConversation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('refreshes discovery immediately when a restarted Server rejects the old live run', async () => {
    const stale = { agentId: 'codex', paneId: '%1', runId: 'run-old', sessionId: 'session-1' };
    const fresh = { ...stale, runId: 'run-new' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: { sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1', items: [], hasMore: false },
    });
    vi.mocked(streamAgentConversation).mockImplementation(async (run, options) => {
      if (run.runId === stale.runId) {
        throw new ApiError('stale agent run', 409, 'stale agent run');
      }
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
    const refreshRun = vi.fn(async () => fresh);
    const { result, rerender, unmount } = renderHook(
      ({ run }) => useAgentConversation(run, undefined, refreshRun),
      { initialProps: { run: stale } },
    );

    await waitFor(() => expect(refreshRun).toHaveBeenCalledWith(stale));
    expect(result.current.error).toBeNull();
    rerender({ run: fresh });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(streamAgentConversation).toHaveBeenCalledWith(stale, expect.any(Object));
    expect(streamAgentConversation).toHaveBeenCalledWith(fresh, expect.any(Object));
    unmount();
  });

  it('accepts sequence one after reconnecting a fresh live observation', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [], hasMore: false,
      },
    });
    let observations = 0;
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      observations++;
      await options?.onReady?.({ viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 });
      await options?.onEvent?.({
        type: 'item.opened', sequence: 1,
        provisionalId: observations === 1 ? 'old-live' : 'new-live',
        draft: {
          kind: 'message', role: 'assistant',
          content: [{ type: 'text', text: observations === 1 ? 'old' : 'new' }],
        },
      });
      if (observations === 1) return;
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(observations).toBe(2), { timeout: 2_500 });
    await waitFor(() => expect(result.current.items.map(({ item }) => (
      item.kind === 'message' ? item.content[0] : null
    ))).toEqual([{ type: 'text', text: 'new' }]));
    expect(result.current.items).toEqual([
      expect.objectContaining({ key: 'live:new-live', provisional: true, live: true }),
    ]);
    unmount();
  });

  it('silently rebuilds one live epoch after a quick mobile foreground wake', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'durable-1', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'keep this visible' }],
        }],
        hasMore: false,
      },
    });
    let observations = 0;
    let releaseSecondReady!: () => void;
    const secondReady = new Promise<void>((resolve) => { releaseSecondReady = resolve; });
    const signals: AbortSignal[] = [];
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      observations++;
      if (options?.signal) signals.push(options.signal);
      if (observations === 2) await secondReady;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(observations).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.status).toBe('ready');
    expect(result.current.canonicalReady).toBe(true);
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(true);
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });

    await act(async () => { releaseSecondReady(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observations).toBe(2);
    unmount();
  });

  it('keeps durable history visible across a run gap and same-session lease replacement', async () => {
    const first = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const replacement = { ...first, runId: 'run-2' };
    const identity = { agentId: 'pi', paneId: '%1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: run.agentId, sessionId: run.sessionId! }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'durable-1', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'keep this visible' }],
        }],
        hasMore: false,
      },
    });
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { result, rerender, unmount } = renderHook(
      ({ run }) => useAgentConversation(run, undefined, undefined, identity),
      { initialProps: { run: first as typeof first | null } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });

    rerender({ run: null });
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });
    await expect(result.current.send('do not lose this')).rejects.toThrow('reconnecting');

    rerender({ run: replacement });
    expect(result.current.items[0]?.item).toMatchObject({ id: 'durable-1' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(streamAgentConversation).toHaveBeenCalledWith(replacement, expect.any(Object));
    unmount();
  });

  it('keeps a settled Goal slot when durable history hands it a different native id', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    let historyVersion = 'history-1';
    const durableGoal = {
      id: 'goal-context-1', sessionId: 'session-1', status: 'complete' as const,
      kind: 'notice' as const, level: 'info' as const, code: 'goal_updated',
      message: 'Ship safely · active',
      extensions: {
        'conversation.goal': { objective: 'Ship safely', status: 'active' },
        'conversation.goalEvent': 'set',
      },
    };
    vi.mocked(discoverAgentConversation).mockImplementation(async () => ({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion,
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockImplementation(async (_run, request) => ({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1',
        historyVersion: request.expectedHistoryVersion ?? historyVersion,
        items: (request.expectedHistoryVersion ?? historyVersion) === 'history-2'
          ? [durableGoal] : [],
        hasMore: false,
      },
    }));
    let observations = 0;
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      observations++;
      await options?.onReady?.({ viewId: 'view-1', historyVersion, streamSequence: 0 });
      if (observations === 1) {
        const draft = {
          kind: 'notice' as const, level: 'info' as const, code: 'goal_updated',
          message: 'Ship safely · active',
          extensions: {
            'conversation.goal': { objective: 'Ship safely', status: 'active', createdAt: 10 },
            'conversation.goalEvent': 'restarted',
          },
        };
        await options?.onEvent?.({
          type: 'item.opened', sequence: 1, provisionalId: 'goal-live-1', draft,
        });
        await options?.onEvent?.({
          type: 'item.settled', sequence: 2, provisionalId: 'goal-live-1',
          durableItemId: 'goal-live-1',
          item: {
            id: 'goal-live-1', sessionId: 'session-1', status: 'complete', ...draft,
          },
        });
        historyVersion = 'history-2';
        await options?.onEvent?.({
          type: 'history.changed', sequence: 3,
          viewId: 'view-1', historyVersion,
        });
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(observations).toBe(1));
    await waitFor(() => expect(result.current.items).toEqual([
      expect.objectContaining({
        key: 'live:goal-live-1', provisional: false, live: false,
        item: expect.objectContaining({ id: 'goal-context-1' }),
      }),
    ]));
    unmount();
  });

  it('keeps one live observation across durable history barriers', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    let historyVersion = 'history-1';
    vi.mocked(discoverAgentConversation).mockImplementation(async () => ({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion,
      capabilities: { history: true, live: 'delta', send: ['prompt'], interrupt: true },
    }));
    vi.mocked(readAgentConversationPage).mockImplementation(async (_run, request) => ({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1',
        historyVersion: request.expectedHistoryVersion ?? historyVersion,
        items: [], hasMore: false,
      },
    }));
    let observations = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      observations++;
      await options?.onReady?.({ viewId: 'view-1', historyVersion, streamSequence: 0 });
      historyVersion = 'history-2';
      await options?.onEvent?.({
        type: 'history.changed', sequence: 1,
        viewId: 'view-1', historyVersion,
      });
      await held;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observations).toBe(1);
    release();
    unmount();
  });

  it('keeps a Pi live turn visible through a lagging history refresh and replaces it once durably', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: {
        history: true, live: 'delta', send: ['prompt', 'steer', 'follow_up'], interrupt: true,
      },
    });
    const durableItems = [
      {
        id: 'pi:entry001', sessionId: 'session-1', status: 'complete' as const,
        sourceCreatedAt: 100,
        kind: 'message' as const, role: 'user' as const,
        content: [{ type: 'text' as const, text: 'inspect this' }],
      },
      {
        id: 'pi:entry002', sessionId: 'session-1', status: 'complete' as const,
        sourceCreatedAt: 200,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'first answer' }],
      },
      {
        id: 'pi:entry002:tool-0', sessionId: 'session-1', status: 'complete' as const,
        kind: 'tool_call' as const, callId: 'pi:call-1', name: 'read',
        input: { path: 'README.md' },
      },
      {
        id: 'pi:entry003', sessionId: 'session-1', status: 'complete' as const,
        kind: 'tool_result' as const, callId: 'pi:call-1',
        content: [{ type: 'text' as const, text: 'contents' }],
      },
      {
        id: 'pi:entry004', sessionId: 'session-1', status: 'complete' as const,
        sourceCreatedAt: 400,
        kind: 'message' as const, role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'final answer' }],
      },
    ];
    vi.mocked(readAgentConversationPage).mockImplementation(async (_run, request) => ({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1',
        historyVersion: request.expectedHistoryVersion ?? 'history-1',
        items: request.expectedHistoryVersion === 'history-3' ? durableItems : [],
        hasMore: false,
      },
    }));
    let streamOptions: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      streamOptions = options;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held.promise;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const emit = async (event: Parameters<NonNullable<AgentConversationStreamOptions['onEvent']>>[0]) => {
      await act(async () => { await streamOptions?.onEvent?.(event); });
    };
    const visible = () => result.current.items.map(({ item }) => ({
      kind: item.kind,
      text: item.kind === 'message'
        ? item.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
        : undefined,
    }));

    await emit({
      type: 'item.opened', sequence: 1, provisionalId: 'pi-user-live',
      draft: {
        kind: 'message', role: 'user', correlationId: 'request-live',
        content: [{ type: 'text', text: 'inspect this' }],
      },
    });
    expect(visible()).toEqual([{ kind: 'message', text: 'inspect this' }]);

    // Pi may announce a same-view history change before that user entry is readable from JSONL.
    // The optimistic user row must survive that bounded handoff window.
    await emit({
      type: 'history.changed', sequence: 2,
      viewId: 'view-1', historyVersion: 'history-2',
    });
    expect(visible()).toEqual([{ kind: 'message', text: 'inspect this' }]);

    await emit({
      type: 'item.settled', sequence: 3, provisionalId: 'pi-user-live',
      item: {
        id: 'pi-user-live', sessionId: 'session-1', status: 'complete',
        sourceCreatedAt: 100,
        kind: 'message', role: 'user', correlationId: 'request-live',
        content: [{ type: 'text', text: 'inspect this' }],
      },
    });
    await emit({
      type: 'item.opened', sequence: 4, provisionalId: 'assistant-live-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    await emit({
      type: 'item.delta', sequence: 5, provisionalId: 'assistant-live-1',
      delta: { op: 'text.append', target: 'message.content', text: 'first answer' },
    });
    await emit({
      type: 'item.settled', sequence: 6, provisionalId: 'assistant-live-1',
      item: {
        id: 'assistant-live-1', sessionId: 'session-1', status: 'complete',
        sourceCreatedAt: 200,
        kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'first answer' }],
      },
    });
    expect(visible().map((item) => item.text)).toEqual(['inspect this', 'first answer']);

    await emit({
      type: 'item.opened', sequence: 7, provisionalId: 'tool-live-1',
      draft: {
        kind: 'tool_call', callId: 'pi:call-1', name: 'read', input: { path: 'README.md' },
      },
    });
    await emit({
      type: 'item.settled', sequence: 8, provisionalId: 'tool-live-1',
      item: {
        id: 'tool-live-1', sessionId: 'session-1', status: 'complete',
        kind: 'tool_call', callId: 'pi:call-1', name: 'read', input: { path: 'README.md' },
      },
    });
    expect(visible().map((item) => item.kind)).toEqual(['message', 'message', 'tool_call']);

    await emit({
      type: 'item.opened', sequence: 9, provisionalId: 'assistant-live-2',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    await emit({
      type: 'item.delta', sequence: 10, provisionalId: 'assistant-live-2',
      delta: { op: 'text.append', target: 'message.content', text: 'final answer' },
    });
    await emit({
      type: 'item.settled', sequence: 11, provisionalId: 'assistant-live-2',
      item: {
        id: 'assistant-live-2', sessionId: 'session-1', status: 'complete',
        sourceCreatedAt: 400,
        kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'final answer' }],
      },
    });
    expect(visible().map((item) => item.text).filter(Boolean))
      .toEqual(['inspect this', 'first answer', 'final answer']);

    await emit({
      type: 'history.changed', sequence: 12,
      viewId: 'view-1', historyVersion: 'history-3',
    });
    expect(result.current.items).toHaveLength(5);
    expect(result.current.items.map(({ item }) => 'id' in item ? item.id : null))
      .toEqual(durableItems.map((item) => item.id));
    expect(visible().map((item) => item.text).filter(Boolean))
      .toEqual(['inspect this', 'first answer', 'final answer']);

    held.resolve();
    unmount();
  });

  it('drops an unmatched live settlement after exactly one lagging history barrier', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage).mockImplementation(async (_run, request) => ({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-1',
        historyVersion: request.expectedHistoryVersion ?? 'history-1',
        items: [], hasMore: false,
      },
    }));
    let streamOptions: AgentConversationStreamOptions | undefined;
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      streamOptions = options;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held.promise;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const emit = async (event: Parameters<NonNullable<AgentConversationStreamOptions['onEvent']>>[0]) => {
      await act(async () => { await streamOptions?.onEvent?.(event); });
    };
    await emit({
      type: 'item.opened', sequence: 1, provisionalId: 'unmatched-live',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'temporary' }] },
    });
    await emit({
      type: 'item.settled', sequence: 2, provisionalId: 'unmatched-live',
      item: {
        id: 'unmatched-live', sessionId: 'session-1', status: 'complete',
        kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'temporary' }],
      },
    });
    await emit({
      type: 'history.changed', sequence: 3,
      viewId: 'view-1', historyVersion: 'history-2',
    });
    expect(result.current.items).toHaveLength(1);

    await emit({
      type: 'history.changed', sequence: 4,
      viewId: 'view-1', historyVersion: 'history-3',
    });
    expect(result.current.items).toEqual([]);

    held.resolve();
    unmount();
  });

  it('does not duplicate a pending snapshot when its earlier opened event replays afterward', async () => {
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const pending = {
      id: 'pending-user', sessionId: 'session-1', status: 'complete' as const,
      kind: 'message' as const, role: 'user' as const,
      content: [{ type: 'text' as const, text: 'send me' }],
    };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'pi', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage).mockResolvedValue({
      status: 'ok', page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [pending], hasMore: false,
      },
    });
    const held = deferred<void>();
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 1,
      });
      await options?.onEvent?.({
        type: 'item.opened', sequence: 2, provisionalId: 'pending-user',
        draft: {
          kind: 'message', role: 'user', content: [{ type: 'text', text: 'send me' }],
        },
      });
      await options?.onEvent?.({
        type: 'item.settled', sequence: 3, provisionalId: 'pending-user', item: pending,
      });
      await held.promise;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]?.item).toMatchObject({
      id: 'pending-user', kind: 'message', role: 'user',
    });

    held.resolve();
    unmount();
  });

  it('keeps the current reading window when an older-page cursor belongs to a replaced view', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'poll' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [{
            id: 'recent-1', sessionId: 'session-1', status: 'complete', kind: 'message',
            role: 'assistant', content: [{ type: 'text', text: 'before rebase' }],
          }],
          previousCursor: 'cursor-1', hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        status: 'stale', currentViewId: 'view-2', currentHistoryVersion: 'history-2',
      });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => { await result.current.loadOlder(); });

    expect(result.current.items[0]?.item).toMatchObject({ id: 'recent-1' });
    expect(readAgentConversationPage).toHaveBeenNthCalledWith(2, run, expect.objectContaining({
      before: 'cursor-1', expectedViewId: 'view-1', expectedHistoryVersion: 'history-1',
    }));
    expect(readAgentConversationPage).toHaveBeenCalledTimes(2);
    expect(result.current.atLatest).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('preserves loaded history and its oldest cursor when durable tail output changes', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const item = (id: string) => ({
      id, sessionId: 'session-1', status: 'complete' as const, kind: 'message' as const,
      role: 'assistant' as const, content: [{ type: 'text' as const, text: id }],
    });
    let activeStream: AgentConversationStreamOptions | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [item('recent-1'), item('recent-2')],
          previousCursor: 'cursor-recent', hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [item('older-1')], previousCursor: 'cursor-oldest', hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-2',
          items: [item('recent-1'), item('recent-2'), item('new-output')],
          previousCursor: 'cursor-new-latest', hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-2',
          items: [item('oldest-1')], hasMore: false,
        },
      });
    vi.mocked(streamAgentConversation).mockImplementation(async (_run, options) => {
      activeStream = options;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.items.map(({ item: value }) => 'id' in value ? value.id : null))
      .toEqual(['older-1', 'recent-1', 'recent-2']);

    await act(async () => {
      await activeStream?.onEvent?.({
        type: 'history.changed', sequence: 1,
        viewId: 'view-1', historyVersion: 'history-2',
      });
    });
    expect(result.current.items.map(({ item: value }) => 'id' in value ? value.id : null))
      .toEqual(['older-1', 'recent-1', 'recent-2', 'new-output']);

    await act(async () => { await result.current.loadOlder(); });
    expect(readAgentConversationPage).toHaveBeenNthCalledWith(4, run, expect.objectContaining({
      before: 'cursor-oldest', expectedViewId: 'view-1', expectedHistoryVersion: 'history-2',
    }));
    expect(result.current.items.map(({ item: value }) => 'id' in value ? value.id : null))
      .toEqual(['oldest-1', 'older-1', 'recent-1', 'recent-2', 'new-output']);
    release();
    unmount();
  });

  it('slides a 1000-item Agent window backward and reloads the authoritative latest page', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const item = (id: string) => ({
      id, sessionId: 'session-1', status: 'complete' as const, kind: 'message' as const,
      role: 'assistant' as const, content: [{ type: 'text' as const, text: id }],
    });
    const recent = Array.from({ length: 990 }, (_, index) => item(`recent-${index}`));
    const older = Array.from({ length: 20 }, (_, index) => item(`older-${index}`));
    const ordinaryLatestPage = {
      status: 'ok' as const,
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [item('ordinary-latest')], previousCursor: 'ordinary-cursor', hasMore: true,
      },
    };
    const ordinaryLatestRead = deferred<typeof ordinaryLatestPage>();
    const forcedLatestPage = {
      status: 'ok' as const,
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [item('latest')], previousCursor: 'latest-cursor', hasMore: true,
      },
    };
    const forcedLatestRead = deferred<typeof forcedLatestPage>();
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: recent, previousCursor: 'cursor-1', hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: older, hasMore: false,
        },
      })
      .mockReturnValueOnce(ordinaryLatestRead.promise)
      .mockReturnValueOnce(forcedLatestRead.promise);
    let activeStream: AgentConversationStreamOptions | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      activeStream = options;
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.items).toHaveLength(990));
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.items).toHaveLength(1_000);
    expect(result.current.items[0]?.item).toMatchObject({ id: 'older-0' });
    expect(result.current.items.at(-1)?.item).toMatchObject({ id: 'recent-979' });
    expect(result.current.atLatest).toBe(false);
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await activeStream?.onEvent?.({
        type: 'item.opened', sequence: 1, provisionalId: 'live-1',
        draft: {
          kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'live ' }],
        },
      });
      await activeStream?.onEvent?.({
        type: 'item.delta', sequence: 2, provisionalId: 'live-1',
        delta: { op: 'text.append', target: 'message.content', blockIndex: 0, text: 'answer' },
      });
    });
    expect(result.current.items.some(({ provisional }) => provisional)).toBe(false);

    let ordinary!: Promise<void>;
    let forced!: Promise<void>;
    act(() => {
      ordinary = result.current.loadLatest!();
      forced = result.current.loadLatest!({ force: true });
    });
    expect(forced).not.toBe(ordinary);
    expect(readAgentConversationPage).toHaveBeenCalledTimes(3);

    await act(async () => {
      ordinaryLatestRead.resolve(ordinaryLatestPage);
      await ordinary;
    });
    expect(readAgentConversationPage).toHaveBeenCalledTimes(4);
    expect(result.current.items[0]?.item).toMatchObject({ id: 'ordinary-latest' });

    await act(async () => {
      forcedLatestRead.resolve(forcedLatestPage);
      await forced;
    });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]?.item).toMatchObject({ id: 'latest' });
    expect(result.current.items[1]).toMatchObject({
      provisional: true,
      item: { kind: 'message', content: [{ type: 'text', text: 'live answer' }] },
    });
    expect(result.current.atLatest).toBe(true);
    expect(result.current.hasMore).toBe(true);
    release();
    unmount();
  });

  it('forces an authoritative latest read while the current window already owns the tail', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const held = deferred<void>();
    const latestPage = {
      status: 'ok' as const,
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'final', sessionId: 'session-1', status: 'complete' as const,
          kind: 'message' as const, role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'final answer' }],
        }],
        hasMore: false,
      },
    };
    const latestRead = deferred<typeof latestPage>();
    const nextLatestPage = {
      status: 'ok' as const,
      page: {
        sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
        items: [{
          id: 'next-final', sessionId: 'session-1', status: 'complete' as const,
          kind: 'message' as const, role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'next final answer' }],
        }],
        hasMore: false,
      },
    };
    const nextLatestRead = deferred<typeof nextLatestPage>();
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], hasMore: false,
        },
      })
      .mockReturnValueOnce(latestRead.promise)
      .mockReturnValueOnce(nextLatestRead.promise);
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held.promise;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.atLatest).toBe(true);
    expect(readAgentConversationPage).toHaveBeenCalledOnce();

    await act(async () => { await result.current.loadLatest?.(); });
    expect(readAgentConversationPage).toHaveBeenCalledOnce();
    let first!: Promise<void>;
    let queued!: Promise<void>;
    act(() => {
      first = result.current.loadLatest!({ force: true });
      queued = result.current.loadLatest!({ force: true });
    });
    expect(queued).not.toBe(first);
    expect(readAgentConversationPage).toHaveBeenCalledTimes(2);
    expect(result.current.items).toEqual([]);

    await act(async () => {
      latestRead.resolve(latestPage);
      await first;
    });
    expect(result.current.items[0]?.item).toMatchObject({ id: 'final' });
    expect(readAgentConversationPage).toHaveBeenCalledTimes(3);

    await act(async () => {
      nextLatestRead.resolve(nextLatestPage);
      await queued;
    });
    expect(result.current.items[0]?.item).toMatchObject({ id: 'next-final' });

    held.resolve();
    unmount();
  });

  it('rejects a forced latest barrier when the rebased read is still stale', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const held = deferred<void>();
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        status: 'stale', currentViewId: 'view-2', currentHistoryVersion: 'history-2',
      })
      .mockResolvedValueOnce({
        status: 'stale', currentViewId: 'view-3', currentHistoryVersion: 'history-3',
      });
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held.promise;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await expect(result.current.loadLatest?.({ force: true }))
        .rejects.toThrow('Authoritative latest read was not applied');
    });
    expect(readAgentConversationPage).toHaveBeenCalledTimes(3);

    held.resolve();
    unmount();
  });

  it('surfaces a temporarily unavailable older page once without starting a cursor rebase loop', async () => {
    const run = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const failure = new ApiError(
      'conversation session unavailable',
      503,
      'conversation session unavailable',
      'conversation_session_unavailable',
    );
    vi.mocked(discoverAgentConversation).mockResolvedValue({
      session: { agentId: 'codex', sessionId: 'session-1' }, run,
      viewId: 'view-1', historyVersion: 'history-1',
      capabilities: { history: true, live: 'delta' },
    });
    vi.mocked(readAgentConversationPage)
      .mockResolvedValueOnce({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], previousCursor: 'cursor-1', hasMore: true,
        },
      })
      .mockRejectedValueOnce(failure);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(streamAgentConversation).mockImplementation(async (_activeRun, options) => {
      await options?.onReady?.({
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      });
      await held;
    });

    const { result, unmount } = renderHook(() => useAgentConversation(run));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    let caught: unknown;
    await act(async () => {
      try { await result.current.loadOlder(); } catch (cause) { caught = cause; }
    });

    expect(caught).toBe(failure);
    expect(readAgentConversationPage).toHaveBeenCalledTimes(2);
    expect(discoverAgentConversation).toHaveBeenCalledOnce();
    expect(result.current.hasMore).toBe(true);
    release();
    unmount();
  });

  it('ignores an older-page response that arrives after switching runs', async () => {
    const first = { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    const second = { agentId: 'codex', paneId: '%2', runId: 'run-2', sessionId: 'session-2' };
    vi.mocked(discoverAgentConversation).mockImplementation(async (run) => ({
      session: { agentId: 'codex', sessionId: run.sessionId! }, run,
      viewId: `view-${run.runId}`, historyVersion: `history-${run.runId}`,
      capabilities: { history: true, live: 'poll' },
    }));
    let resolveOlder!: (value: Awaited<ReturnType<typeof readAgentConversationPage>>) => void;
    const older = new Promise<Awaited<ReturnType<typeof readAgentConversationPage>>>((resolve) => {
      resolveOlder = resolve;
    });
    vi.mocked(readAgentConversationPage).mockImplementation(async (run, request) => {
      if (request.before) return await older;
      const firstRun = run.runId === 'run-1';
      return {
        status: 'ok',
        page: {
          sessionId: run.sessionId!, viewId: `view-${run.runId}`,
          historyVersion: `history-${run.runId}`,
          items: [{
            id: firstRun ? 'first-recent' : 'second-recent', sessionId: run.sessionId!,
            status: 'complete', kind: 'message', role: 'assistant',
            content: [{ type: 'text', text: firstRun ? 'first' : 'second' }],
          }],
          ...(firstRun ? { previousCursor: 'first-cursor', hasMore: true } : { hasMore: false }),
        },
      };
    });

    const { result, rerender, unmount } = renderHook(
      ({ run }) => useAgentConversation(run),
      { initialProps: { run: first } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    let olderRequest!: Promise<void>;
    act(() => { olderRequest = result.current.loadOlder(); });
    await waitFor(() => expect(readAgentConversationPage).toHaveBeenCalledWith(
      first, expect.objectContaining({ before: 'first-cursor' }),
    ));

    rerender({ run: second });
    await waitFor(() => expect(result.current.items[0]?.item).toMatchObject({ id: 'second-recent' }));
    resolveOlder({
      status: 'ok',
      page: {
        sessionId: 'session-1', viewId: 'view-run-1', historyVersion: 'history-run-1',
        items: [{
          id: 'first-older', sessionId: 'session-1', status: 'complete', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'old response' }],
        }],
        hasMore: false,
      },
    });
    await act(async () => { await olderRequest; });

    expect(result.current.items.map(({ item }) => 'id' in item ? item.id : null))
      .toEqual(['second-recent']);
    unmount();
  });
});
