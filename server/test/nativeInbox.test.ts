import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxService } from '../src/agent-runtime/inbox.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { LivePane } from '../src/agent-runtime/adapter.js';
import type { AgentRuntimeCapabilityContext } from '../src/agent-runtime/runtime.js';
import { NativeInboxCoordinator } from '../src/agents/nativeInbox.js';
import type { NativeInboxSnapshot, NativeInboxSource } from '../src/agents/nativeInbox.js';
import { createCodexNativeInboxSource } from '../src/agents/nativeInboxSources.js';

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

async function setup(
  initial: NativeInboxSnapshot,
  options: { agentId?: string; sourceId?: string; source?: NativeInboxSource } = {},
) {
  const panes = [pane('%1', 101), pane('%2', 202)];
  let snapshot = initial;
  const agentId = options.agentId ?? 'claude';
  const sourceId = options.sourceId ?? 'claude.hooks';
  let runId = 0;
  let now = 1_000;
  const runs = new AgentRunRuntime({ newRunId: () => `run-${++runId}` });
  const inbox = new InboxService({
    runs, adapterIds: [agentId], now: () => now,
    newServiceEpoch: () => 'epoch', newNotificationId: () => `notification-${now}`,
  });
  const runControl = runs.controller(agentId, async () => true);
  const context = {
    runs,
    runControl,
    panes: { list: async () => panes, subscribe: () => () => {} },
    process: { inspectForeground: async () => null },
    currentRunForPane: (paneId: string) => runs.currentForPane(paneId),
    inbox: inbox.projectorFor(agentId),
    health: { report: vi.fn() },
    signal: new AbortController().signal,
  } as unknown as AgentRuntimeCapabilityContext;
  const coordinator = new NativeInboxCoordinator({
    agentId, sourceId, context,
    source: options.source ?? { read: async () => structuredClone(snapshot) }, pollMs: 10_000,
  });
  coordinators.push(coordinator);
  await Promise.all(panes.map((value) => runControl.attach({
    paneId: value.paneId,
    attachmentId: `runtime:${value.paneId}`,
    process: {
      pid: value.paneId === '%1' ? 101 : 202,
      startedAt: 500,
      ...(value.tty === undefined ? {} : { tty: value.tty }),
    },
  })));
  return {
    runs, inbox, coordinator, health: context.health,
    setSnapshot(value: NativeInboxSnapshot) { snapshot = value; },
    setNow(value: number) { now = value; },
  };
}

describe('NativeInboxCoordinator', () => {
  it('accepts replay of a baseline after a live transition and updates subsequent panes', async () => {
    const done = { paneId: '%1', cursor: 'done', state: 'done' as const, message: 'Finished', eventId: 'done' };
    const working = { paneId: '%2', cursor: 'working-2', state: 'working' as const };
    const h = await setup({ availability: 'ready', rows: [done, working] });
    await h.coordinator.reconcile();
    h.setSnapshot({ availability: 'ready', rows: [
      { paneId: '%1', cursor: 'working-1', state: 'working' }, working,
    ] });
    await h.coordinator.reconcile();
    h.setSnapshot({ availability: 'ready', rows: [done,
      { paneId: '%2', cursor: 'waiting-2', state: 'waiting', eventId: 'waiting-2' },
    ] });
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.inbox.read().records).toContainEqual(expect.objectContaining({
      run: expect.objectContaining({ paneId: '%2' }), state: 'waiting',
    }));
    expect(h.inbox.read().terminalNotifications).toEqual([]);
  });

  it('isolates a rejected pane, reports its identity, and retries it without blocking healthy panes', async () => {
    const first = { paneId: '%1', cursor: 'event-1', state: 'waiting' as const, eventId: 'event-1', message: 'First' };
    const second = { paneId: '%2', cursor: 'working-2', state: 'working' as const };
    const h = await setup({ availability: 'ready', rows: [first, second] });
    await h.coordinator.reconcile();
    h.setSnapshot({ availability: 'ready', rows: [
      { paneId: '%1', cursor: 'working-1', state: 'working' }, second,
    ] });
    await h.coordinator.reconcile();
    h.setSnapshot({ availability: 'ready', rows: [{ ...first, message: 'Conflicting' },
      { paneId: '%2', cursor: 'waiting-2', state: 'waiting', eventId: 'waiting-2' },
    ] });
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.inbox.read().records).toContainEqual(expect.objectContaining({
      run: expect.objectContaining({ paneId: '%2' }), state: 'waiting',
    }));
    expect(h.health.report).toHaveBeenLastCalledWith(expect.objectContaining({
      availability: 'degraded', message: expect.stringContaining('%1'),
    }));
    expect(h.inbox.read().availability.claude?.availability).toBe('degraded');
    h.setSnapshot({ availability: 'ready', rows: [
      { ...first, cursor: 'event-3', eventId: 'event-3', message: 'Recovered' },
      { paneId: '%2', cursor: 'waiting-2', state: 'waiting', eventId: 'waiting-2' },
    ] });
    await h.coordinator.reconcile();
    expect(h.inbox.read().records).toContainEqual(expect.objectContaining({
      run: expect.objectContaining({ paneId: '%1' }), state: 'waiting', message: 'Recovered',
    }));
    expect(h.inbox.read().availability.claude?.availability).toBe('ready');
  });

  it('restores a multi-pane baseline without creating unread terminal events', async () => {
    const h = await setup({
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
    const h = await setup({
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
    expect(h.runs.status(secondRun)).toBe('current');
  });

  it('does not reject a Codex event when only its correlation id changes', async () => {
    const states = [
      { '%1': {
        kind: 'permission' as const, msg: 'Approve?', ts: 200,
        threadId: 'thread-1', correlationId: 'turn-1',
      } },
      { '%1': {
        kind: 'working' as const, msg: 'Working', ts: 300, threadId: 'thread-1',
      } },
      { '%1': {
        kind: 'permission' as const, msg: 'Approve?', ts: 200,
        threadId: 'thread-1', correlationId: 'item-1',
      } },
    ];
    const source = createCodexNativeInboxSource({
      inboxStates: vi.fn(async () => states.shift() ?? {}),
    });
    const h = await setup({ availability: 'ready', rows: [] }, {
      agentId: 'codex', sourceId: 'codex.app-server', source,
    });

    await h.coordinator.reconcile();
    h.setNow(2_000);
    await h.coordinator.reconcile();
    h.setNow(3_000);
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();

    expect(h.inbox.read().availability.codex).toEqual({ availability: 'ready' });
    expect(h.inbox.read().records).toEqual([expect.objectContaining({
      state: 'waiting', correlationId: 'item-1', message: 'Approve?',
    })]);
  });

  it('replaces the lease when the same pane changes session', async () => {
    const h = await setup({
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
    const h = await setup({
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
    const h = await setup({
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
    const h = await setup({
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

  it('ignores a source row without Runtime process ownership and keeps healthy rows', async () => {
    const h = await setup({
      availability: 'ready',
      rows: [
        { paneId: '%1', sessionId: 'session-1', cursor: 'one', state: 'working' },
        { paneId: '%2', sessionId: 'session-2', cursor: 'two', state: 'working' },
      ],
    });
    await h.runs.revokePane('%2', 'process_exit');
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.inbox.read().records).toEqual([
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%1' }), state: 'working' }),
    ]);
    expect(h.inbox.read().availability.claude).toEqual({ availability: 'ready' });
  });

  it('does not let a provider row recreate a Runtime-revoked process run', async () => {
    const h = await setup({
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
    await h.runs.revokePane('%1', 'process_exit');

    h.setNow(3_000);
    await expect(h.coordinator.reconcile()).resolves.toBeUndefined();
    expect(h.runs.currentForPane('%1')).toBeNull();
    expect(h.inbox.read().records).toEqual([]);
    expect(h.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ id: notification.id, eventId: 'done-1', acceptedAt: 2_000, readAt: 2_500 }),
    ]);
  });
});
