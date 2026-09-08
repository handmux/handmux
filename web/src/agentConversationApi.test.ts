import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverAgentConversation,
  downloadAgentConversationResource,
  interruptAgentConversation,
  readAgentConversationPage,
  sendAgentConversationMessage,
  streamAgentConversation,
} from './agentConversationApi.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Agent Conversation app facade client', () => {
  it('accepts only stable public send and interrupt reasons', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200, ok: true, json: async () => ({ status: 'rejected', reason: 'provider_rejected' }),
      })
      .mockResolvedValueOnce({
        status: 200, ok: true, json: async () => ({
          status: 'rejected', reason: '/Users/private/provider.sock RPC failed',
        }),
      });
    vi.stubGlobal('fetch', fetch);
    const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };

    await expect(sendAgentConversationMessage(run, {
      clientRequestId: 'request-1', text: 'hello', delivery: 'prompt',
    })).resolves.toEqual({ status: 'rejected', reason: 'provider_rejected' });
    await expect(interruptAgentConversation(run)).rejects.toThrow('invalid receipt');
  });

  it('preserves Connector reload metadata from discovery for the shared conversation UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true,
      json: async () => ({
        descriptor: {
          session: { agentId: 'pi', sessionId: 'session-1' },
          run: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
          viewId: 'view-1', historyVersion: 'history-1',
          capabilities: { history: true, live: 'delta', branching: true },
          implementation: { version: 1, reloadRequired: true },
        },
      }),
    })));

    await expect(discoverAgentConversation({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    })).resolves.toMatchObject({
      implementation: { version: 1, reloadRequired: true },
    });
  });

  it('accepts the Core sendable/steer capability and stable submission receipt', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200, ok: true, json: async () => ({ descriptor: {
          session: { agentId: 'future', sessionId: 'session-1' },
          viewId: 'view-1', historyVersion: 'history-1',
          capabilities: { history: true, live: 'poll', sendable: true, steer: true },
        } }),
      })
      .mockResolvedValueOnce({
        status: 200, ok: true, json: async () => ({
          status: 'queued', submission: {
            id: 'submission-1', text: 'later', state: 'queued', revision: 1,
            baseline: { viewId: 'view-1', historyVersion: 'history-1' },
            autoDispatchBlockedReason: 'provider_rejected',
            createdAt: 1, updatedAt: 1,
          },
        }),
      });
    vi.stubGlobal('fetch', fetch);
    const run = { agentId: 'future', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
    await expect(discoverAgentConversation(run)).resolves.toMatchObject({
      capabilities: { sendable: true, steer: true },
    });
    await expect(sendAgentConversationMessage(run, {
      clientRequestId: 'submission-1', text: 'later', delivery: 'prompt',
    })).resolves.toMatchObject({
      status: 'queued', submission: {
        id: 'submission-1', state: 'queued', revision: 1,
        baseline: { viewId: 'view-1', historyVersion: 'history-1' },
        autoDispatchBlockedReason: 'provider_rejected',
      },
    });
  });

  it.each(['accepted', 'observed'])('rejects terminal %s content in a send receipt', async (state) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, json: async () => ({
        status: 'accepted', submission: {
          id: 'terminal-1', text: 'must not cross the wire', state, revision: 1,
          dispatchOrigin: 'direct', createdAt: 1, updatedAt: 1,
        },
      }),
    })));
    await expect(sendAgentConversationMessage({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    }, {
      clientRequestId: 'terminal-1', text: 'must not cross the wire', delivery: 'prompt',
    })).rejects.toThrow('invalid receipt');
  });

  it('keeps bearer auth and applies ready before ordered live events', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'agent-stream-token' });
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({
        type: 'ready', checkpoint: {
          viewId: 'view-1', historyVersion: 'history-1', streamSequence: 4,
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'event', event: {
          type: 'item.opened', sequence: 5, provisionalId: 'answer-1',
          draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'event', event: {
          type: 'item.delta', sequence: 6, provisionalId: 'answer-1',
          delta: { op: 'text.append', target: 'message.content', text: 'hello' },
        },
      })}\n\n`,
    ].map((value) => encoder.encode(value));
    const reader = {
      read: vi.fn(async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true })),
      releaseLock: vi.fn(),
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      status: 200, ok: true, body: { getReader: () => reader },
    }));
    vi.stubGlobal('fetch', fetch);
    const order: string[] = [];

    await streamAgentConversation(
      { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
      {
        expectedViewId: 'view-1',
        onReady: async (checkpoint) => { order.push(`ready:${checkpoint.streamSequence}`); },
        onEvent: async (event) => { order.push(`${event.type}:${event.sequence}`); },
      },
    );

    expect(order).toEqual(['ready:4', 'item.opened:5', 'item.delta:6']);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/agents/conversation/live?'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer agent-stream-token' }),
      }));
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'https://handmux.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1', expectedViewId: 'view-1',
    });
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('abandons a live response that never produces its ready checkpoint', async () => {
    vi.useFakeTimers();
    const reader = {
      read: vi.fn(() => new Promise<never>(() => {})),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, body: { getReader: () => reader },
    })));

    const pending = streamAgentConversation(
      { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
      { readyTimeoutMs: 100, silenceTimeoutMs: 1_000 },
    );
    const rejection = expect(pending).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('abandons a ready stream after the Server keepalive goes silent', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const ready = encoder.encode(`data: ${JSON.stringify({
      type: 'ready', checkpoint: {
        viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0,
      },
    })}\n\n`);
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: ready })
        .mockImplementation(() => new Promise<never>(() => {})),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, body: { getReader: () => reader },
    })));
    const onReady = vi.fn();

    const pending = streamAgentConversation(
      { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
      { readyTimeoutMs: 1_000, silenceTimeoutMs: 100, onReady },
    );
    const rejection = expect(pending).rejects.toThrow('went silent');
    await vi.advanceTimersByTimeAsync(0);
    expect(onReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(reader.cancel).toHaveBeenCalledOnce();
  });

  it('rejects a malformed durable item instead of partially projecting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true,
      json: async () => ({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          hasMore: false,
          items: [{
            id: 'item-1', sessionId: 'wrong-session', status: 'complete',
            kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'unsafe' }],
          }],
        },
      }),
    })));

    await expect(readAgentConversationPage({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    }, { limit: 50 }))
      .rejects.toThrow('invalid item');

    expect(fetch).toHaveBeenCalledWith('/api/agents/conversation/page', expect.objectContaining({
      body: JSON.stringify({
        run: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
        request: { limit: 50 },
      }),
    }));
  });

  it('accepts a retained compaction summary beyond the short-label limit', async () => {
    const summary = '摘要'.repeat(2_500);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true,
      json: async () => ({
        status: 'ok',
        page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          hasMore: false,
          items: [{
            id: 'compact-1', sessionId: 'session-1', status: 'complete',
            kind: 'compaction', summary,
          }],
        },
      }),
    })));

    await expect(readAgentConversationPage({
      agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    }, { limit: 50 })).resolves.toMatchObject({
      status: 'ok', page: { items: [{ kind: 'compaction', summary }] },
    });
  });

  it('downloads an opaque resource with bearer auth without exposing a source path', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'agent-resource-token' });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:agent-resource');
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      status: 200, ok: true,
      blob: async () => new Blob(['result'], { type: 'text/plain' }),
    }));
    vi.stubGlobal('fetch', fetch);

    await downloadAgentConversationResource('pi', 'session-1', {
      resourceId: 'opaque-resource-id-0001', name: 'result.txt', mediaType: 'text/plain',
    });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/agents/conversation/resource?'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer agent-resource-token' }),
      }));
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'https://handmux.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: 'pi', sessionId: 'session-1', resourceId: 'opaque-resource-id-0001',
    });
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('sanitizes provider display names before using them as browser download filenames', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'agent-resource-token' });
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = () => 'blob:agent-resource';
      static revokeObjectURL = () => {};
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true,
      blob: async () => new Blob(['result'], { type: 'text/plain' }),
    })));

    await downloadAgentConversationResource('pi', 'session-1', {
      resourceId: 'opaque-resource-id-0001', name: '../result\n.txt', mediaType: 'text/plain',
    });
    expect(downloaded).toBe('.._result_.txt');
  });
});
