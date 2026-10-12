import { describe, expect, it, vi } from 'vitest';
import { createCodexNativeInboxSource } from '../src/agents/nativeInboxSources.js';
import type { LivePane } from '../src/agent-runtime/adapter.js';

const pane: LivePane = {
  paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
  currentCommand: 'codex', tty: '/dev/ttys001',
};

describe('native Inbox provider sources', () => {
  it('projects Codex App Server state and reports per-pane reconnect degradation', async () => {
    const inboxStates = vi.fn(async () => ({
      '%1': {
        kind: 'permission' as const, msg: 'Approve?', ts: 200,
        threadId: 'thread-1', correlationId: 'command-1', unavailable: true,
      },
    }));
    const source = createCodexNativeInboxSource({ inboxStates });
    const snapshot = await source.read([pane]);
    expect(inboxStates).toHaveBeenCalledWith([expect.objectContaining({
      id: '%1', session: 'main', window: '@1', windowName: 'agent',
    })]);
    expect(snapshot).toMatchObject({
      availability: 'degraded', message: 'Codex App Server is reconnecting',
      rows: [{
        paneId: '%1', sessionId: 'thread-1', state: 'waiting', message: 'Approve?',
        correlationId: 'command-1',
      }],
    });
    expect(snapshot.rows[0]?.eventId).toMatch(/^codex:/);
  });

  it('retains the last trustworthy Codex row while App Server reconnects', async () => {
    const inboxStates = vi.fn()
      .mockResolvedValueOnce({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200,
          threadId: 'thread-1', correlationId: 'command-1',
        },
      })
      .mockResolvedValueOnce({
        '%1': {
          kind: null, msg: '', ts: 0, threadId: null, unavailable: true,
        },
      })
      .mockResolvedValueOnce({
        '%1': { kind: null, msg: '', ts: 300, threadId: 'thread-1' },
      });
    const source = createCodexNativeInboxSource({ inboxStates });

    const ready = await source.read([pane]);
    const reconnecting = await source.read([pane]);
    const recovered = await source.read([pane]);

    expect(ready.rows).toEqual([expect.objectContaining({
      paneId: '%1', sessionId: 'thread-1', state: 'waiting', message: 'Approve?',
    })]);
    expect(reconnecting).toMatchObject({
      availability: 'degraded', message: 'Codex App Server is reconnecting',
      rows: [expect.objectContaining({
        paneId: '%1', sessionId: 'thread-1', state: 'waiting', message: 'Approve?',
      })],
    });
    expect(recovered).toMatchObject({ availability: 'ready', rows: [{
      paneId: '%1', sessionId: 'thread-1', state: null,
    }] });
  });

  it('bounds provider messages before one pane can invalidate the full Inbox baseline', async () => {
    const inboxStates = vi.fn(async () => ({
      '%1': {
        kind: 'done' as const, msg: 'x'.repeat(5_000), ts: 200,
        threadId: 'thread-1',
      },
    }));
    const source = createCodexNativeInboxSource({ inboxStates });

    const snapshot = await source.read([pane]);

    expect(snapshot.rows).toEqual([expect.objectContaining({
      paneId: '%1', state: 'done', message: 'x'.repeat(4_096),
    })]);
  });

  it('changes the event identity when correlation changes the projected operation', async () => {
    const inboxStates = vi.fn()
      .mockResolvedValueOnce({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200,
          threadId: 'thread-1', correlationId: 'turn-1',
        },
      })
      .mockResolvedValueOnce({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200,
          threadId: 'thread-1', correlationId: 'item-1',
        },
      });
    const source = createCodexNativeInboxSource({ inboxStates });

    const first = await source.read([pane]);
    const second = await source.read([pane]);

    expect(second.rows[0]?.correlationId).toBe('item-1');
    expect(second.rows[0]?.cursor).not.toBe(first.rows[0]?.cursor);
    expect(second.rows[0]?.eventId).not.toBe(first.rows[0]?.eventId);
  });

  it('preserves existing event identities when an operation has no correlation id', async () => {
    const source = createCodexNativeInboxSource({
      inboxStates: vi.fn(async () => ({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200, threadId: 'thread-1',
        },
      })),
    });

    const snapshot = await source.read([pane]);

    expect(snapshot.rows[0]?.eventId)
      .toBe('codex:17ca88b103ac637f21afa902a86bf3919c11df3e6947e9f408916d1aab567947');
  });

  it('excludes an invalid correlation id from both the operation and its event identity', async () => {
    const inboxStates = vi.fn()
      .mockResolvedValueOnce({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200,
          threadId: 'thread-1', correlationId: 'x'.repeat(257),
        },
      })
      .mockResolvedValueOnce({
        '%1': {
          kind: 'permission' as const, msg: 'Approve?', ts: 200, threadId: 'thread-1',
        },
      });
    const source = createCodexNativeInboxSource({ inboxStates });

    const invalidCorrelation = await source.read([pane]);
    const noCorrelation = await source.read([pane]);

    expect(invalidCorrelation.rows[0]).not.toHaveProperty('correlationId');
    expect(invalidCorrelation.rows[0]?.cursor).toBe(noCorrelation.rows[0]?.cursor);
    expect(invalidCorrelation.rows[0]?.eventId).toBe(noCorrelation.rows[0]?.eventId);
  });
});
