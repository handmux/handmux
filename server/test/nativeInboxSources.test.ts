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
});
