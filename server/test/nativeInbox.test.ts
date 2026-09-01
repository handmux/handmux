import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxService } from '../src/agent-runtime/inbox.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { LivePane } from '../src/agent-runtime/adapter.js';
import type { AgentRuntimeCapabilityContext } from '../src/agent-runtime/runtime.js';
import { NativeInboxCoordinator } from '../src/agents/nativeInbox.js';
import type { NativeInboxSnapshot } from '../src/agents/nativeInbox.js';

const coordinators: NativeInboxCoordinator[] = [];
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((value) => value.close()));
});

function pane(paneId: string, pid: number): LivePane {
  return {
    paneId, sessionName: 'main', windowId: `@${pid}`, windowName: 'agent',
    currentCommand: 'claude', tty: `/dev/ttys${pid}`,
  };
}

function setup(initial: NativeInboxSnapshot) {
  const panes = [pane('%1', 101), pane('%2', 202)];
  let snapshot = initial;
  let missingProcessPane: string | null = null;
  let runId = 0;
  let now = 1_000;
  const runs = new AgentRunRuntime({ newRunId: () => `run-${++runId}` });
  const inbox = new InboxService({
    runs, adapterIds: ['claude'], now: () => now,
    newServiceEpoch: () => 'epoch', newNotificationId: () => `notification-${now}`,
  });
  const context = {
    runs,
    runControl: runs.controller('claude', async () => true),
    panes: { list: async () => panes, subscribe: () => () => {} },
    process: { inspectForeground: async (value: LivePane) => (
      value.paneId === missingProcessPane ? null : {
        pid: value.paneId === '%1' ? 101 : 202, startedAt: 500,
        tty: value.tty,
      }
    ) },
    inbox: inbox.projectorFor('claude'),
    health: { report: vi.fn() },
    signal: new AbortController().signal,
  } as unknown as AgentRuntimeCapabilityContext;
  const coordinator = new NativeInboxCoordinator({
    agentId: 'claude', sourceId: 'claude.hooks', context,
    source: { read: async () => structuredClone(snapshot) }, pollMs: 10_000,
  });
  coordinators.push(coordinator);
  return {
    runs, inbox, coordinator,
    setSnapshot(value: NativeInboxSnapshot) { snapshot = value; },
    setNow(value: number) { now = value; },
    setMissingProcessPane(value: string | null) { missingProcessPane = value; },
  };
}

describe('NativeInboxCoordinator', () => {
  it('restores a multi-pane baseline without creating unread terminal events', async () => {
    const h = setup({
      availability: 'ready',
      rows: [
        { paneId: '%1', sessionId: 'session-1', cursor: 'a', state: 'done', eventId: 'done-1' },
        { paneId: '%2', sessionId: 'session-2', cursor: 'b', state: 'working' },
      ],
    });
    await h.coordinator.reconcile();
    expect(h.inbox.read().records).toHaveLength(2);
    expect(h.inbox.read().terminalNotifications).toEqual([]);
    expect(h.inbox.read().records.find((value) => value.run.paneId === '%1')).not.toHaveProperty('acceptedAt');
  });

  it('submits later transitions with Core time and isolates pane removal', async () => {
    const h = setup({
      availability: 'ready',
      rows: [
        {
          paneId: '%1', sessionId: 'session-1', cursor: 'working-1', state: 'working',
          correlationId: 'turn-1',
        },
        { paneId: '%2', sessionId: 'session-2', cursor: 'working-2', state: 'working' },
      ],
    });
    await h.coordinator.reconcile();
    const secondRun = h.inbox.read().records.find((value) => value.run.paneId === '%2')!.run;
    h.setNow(2_000);
    h.setSnapshot({
      availability: 'ready',
      rows: [
        {
          paneId: '%1', sessionId: 'session-1', cursor: 'done-1', state: 'done',
          correlationId: 'turn-1', eventId: 'done-1',
        },
      ],
    });
    await h.coordinator.reconcile();
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({
        state: 'done', correlationId: 'turn-1', eventId: 'done-1', acceptedAt: 2_000,
      }),
    ]);
    expect(h.inbox.read().terminalNotifications).toHaveLength(1);
    expect(h.runs.status(secondRun)).toBe('revoked');
  });

  it('replaces the lease when the same pane changes session', async () => {
    const h = setup({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'session-1', cursor: 'one', state: null }],
    });
    await h.coordinator.reconcile();
    const first = h.runs.currentForPane('%1')!;
    h.setSnapshot({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'session-2', cursor: 'two', state: null }],
    });
    await h.coordinator.reconcile();
    const second = h.runs.currentForPane('%1')!;
    expect(second.ref.runId).not.toBe(first.ref.runId);
    expect(second.ref.sessionId).toBe('session-2');
    expect(first.signal.reason).toBe('session_replaced');
  });

  it('removes a stale working record when the pane returns to its idle root session', async () => {
    const h = setup({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'ephemeral-helper', cursor: 'working', state: 'working' }],
    });
    await h.coordinator.reconcile();
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({
        state: 'working', run: expect.objectContaining({ sessionId: 'ephemeral-helper' }),
      }),
    ]);

    h.setSnapshot({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'root-thread', cursor: 'idle', state: null }],
    });
    await h.coordinator.reconcile();

    expect(h.inbox.read().records).toEqual([]);
    expect(h.runs.currentForPane('%1')?.ref.sessionId).toBe('root-thread');
  });

  it('preserves a live terminal transition during late session association', async () => {
    const h = setup({
      availability: 'ready',
      rows: [{ paneId: '%1', cursor: 'working', state: 'working' }],
    });
    await h.coordinator.reconcile();
    const first = h.runs.currentForPane('%1')!;
    h.setNow(2_000);
    h.setSnapshot({
      availability: 'ready',
      rows: [{
        paneId: '%1', sessionId: 'session-1', cursor: 'done', state: 'done', eventId: 'done-1',
      }],
    });
    await h.coordinator.reconcile();
    const current = h.runs.currentForPane('%1')!;
    expect(current).toBe(first);
    expect(current.ref.sessionId).toBe('session-1');
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'done', eventId: 'done-1', acceptedAt: 2_000 }),
    ]);
    expect(h.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ runId: current.ref.runId, eventId: 'done-1' }),
    ]);
  });

  it('deduplicates repeated availability baselines and commits recovery once', async () => {
    const h = setup({
      availability: 'degraded', message: 'source reconnecting',
      rows: [{ paneId: '%1', sessionId: 'session-1', cursor: 'working', state: 'working' }],
    });
    await h.coordinator.reconcile();
    const firstRevision = h.inbox.read().revision;
    await h.coordinator.reconcile();
    expect(h.inbox.read().revision).toBe(firstRevision);
    h.setSnapshot({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'session-1', cursor: 'working', state: 'working' }],
    });
    await h.coordinator.reconcile();
    expect(h.inbox.read().revision).toBe(firstRevision + 1);
    expect(h.inbox.read().availability.claude).toEqual({ availability: 'ready' });
  });

  it('isolates an unverified pane and recovers it without blocking healthy rows', async () => {
    const h = setup({
      availability: 'ready',
      rows: [
        { paneId: '%1', sessionId: 'session-1', cursor: 'one', state: 'working' },
        { paneId: '%2', sessionId: 'session-2', cursor: 'two', state: 'working' },
      ],
    });
    h.setMissingProcessPane('%2');
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%1' }), state: 'working' }),
    ]);
    expect(h.inbox.read().availability.claude).toMatchObject({
      availability: 'degraded', message: 'claude foreground process is unavailable',
    });

    h.setMissingProcessPane(null);
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.inbox.read().records.map((record) => record.run.paneId).sort()).toEqual(['%1', '%2']);
    expect(h.inbox.read().availability.claude).toEqual({ availability: 'ready' });
  });

  it('reattaches an externally revoked row without recreating its terminal notification', async () => {
    const h = setup({
      availability: 'ready',
      rows: [{ paneId: '%1', sessionId: 'session-1', cursor: 'one', state: 'working' }],
    });
    await h.coordinator.reconcile();
    h.setNow(2_000);
    h.setSnapshot({
      availability: 'ready',
      rows: [{
        paneId: '%1', sessionId: 'session-1', cursor: 'two', state: 'done', eventId: 'done-1',
      }],
    });
    await h.coordinator.reconcile();
    h.setNow(2_500);
    const notification = h.inbox.read().terminalNotifications[0]!;
    await h.inbox.markTerminalRead([notification.id]);
    const previous = h.runs.currentForPane('%1')!;
    await h.runs.revokePane('%1', 'process_exit');

    h.setNow(3_000);
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    const recovered = h.runs.currentForPane('%1')!;
    expect(recovered.ref.runId).not.toBe(previous.ref.runId);
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ runId: recovered.ref.runId }),
        state: 'done', eventId: 'done-1', acceptedAt: 2_000,
      }),
    ]);
    expect(h.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ id: notification.id, eventId: 'done-1', acceptedAt: 2_000, readAt: 2_500 }),
    ]);
  });
});
