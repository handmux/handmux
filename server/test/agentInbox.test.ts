import { describe, expect, it, vi } from 'vitest';
import { InboxContractError, InboxService } from '../src/agent-runtime/inbox.js';
import { MemoryInboxStateStore } from '../src/agent-runtime/inboxStore.js';
import type { InboxStateStore, PersistedInboxState } from '../src/agent-runtime/inboxStore.js';
import type { InboxOperation, InboxOrderedProjector } from '../src/agent-runtime/inboxTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';

interface InboxHarness {
  runtime: AgentRunRuntime;
  lease: AgentRunLease;
  service: InboxService;
  projector: InboxOrderedProjector;
  setNow(value: number): void;
}

async function harness(options: {
  store?: InboxStateStore;
  runtime?: AgentRunRuntime;
  now?: number;
  epoch?: string;
} = {}): Promise<InboxHarness> {
  let currentNow = options.now ?? 10_000;
  const runtime = options.runtime ?? new AgentRunRuntime({ newRunId: () => 'run-1' });
  const current = runtime.currentForPane('%1');
  const lease = current ?? await runtime.controller('pi', async () => true).attach({
    paneId: '%1',
    attachmentId: 'pi-attachment',
    sessionId: 'pi-session',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
  });
  let notification = 0;
  const service = new InboxService({
    runs: runtime,
    adapterIds: ['pi', 'claude'],
    ...(options.store ? { store: options.store } : {}),
    now: () => currentNow,
    newServiceEpoch: () => options.epoch ?? 'epoch-1',
    newNotificationId: () => `notification-${++notification}`,
  });
  return {
    runtime,
    lease,
    service,
    projector: service.projectorFor('pi'),
    setNow: (value) => { currentNow = value; },
  };
}

const source = (cursor: string, sourceId = 'pi.extension') => ({ sourceId, cursor });

describe('InboxOrderedProjector live operations', () => {
  it('emits ordered user notifications only after first persistent acceptance', async () => {
    const h = await harness();
    const events: unknown[] = [];
    h.service.subscribeNotifications(async () => { throw new Error('delivery unavailable'); });
    h.service.subscribeNotifications(async (event) => { events.push(event); });
    const run = h.projector.forRun(h.lease);
    const waiting: InboxOperation = {
      kind: 'set', state: 'waiting', source: source('1'),
      eventId: 'permission-1', message: 'Approve?',
    };
    await run.submit(waiting);
    await run.submit(waiting);
    await run.submit({
      kind: 'set', state: 'done', source: source('2'),
      eventId: 'done-1', message: 'Finished',
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual([
      expect.objectContaining({
        run: h.lease.ref, state: 'waiting', eventId: 'permission-1', acceptedAt: 10_000,
      }),
      expect.objectContaining({
        run: h.lease.ref, state: 'done', eventId: 'done-1', acceptedAt: 10_000,
        terminalNotificationId: 'notification-1',
      }),
    ]);
  });

  it('assigns the final run-scoped sequence and authoritative server time', async () => {
    const h = await harness();
    const result = await h.projector.forRun(h.lease).submit({
      kind: 'set',
      state: 'waiting',
      source: source('source-1'),
      eventId: 'permission-1',
      message: 'Approve?',
      sourceOccurredAt: 99_999_999,
    });
    expect(result).toEqual({
      accepted: true,
      serviceEpoch: 'epoch-1',
      revision: 1,
      inboxSequence: 1,
      acceptedAt: 10_000,
      receivedAt: 10_000,
    });
    expect(h.service.read().records).toEqual([expect.objectContaining({
      state: 'waiting',
      eventId: 'permission-1',
      inboxSequence: 1,
      acceptedAt: 10_000,
      receivedAt: 10_000,
      sourceOccurredAt: 99_999_999,
    })]);
  });

  it('applies set as a patch and clear as an ordered operation', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    await run.submit({
      kind: 'set', state: 'working', source: source('1'),
      message: 'Building', reason: 'initial', correlationId: 'turn-1',
    });
    const patched = await run.submit({
      kind: 'set', state: 'working', source: source('2'), reason: null,
    });
    expect(patched.inboxSequence).toBe(2);
    expect(h.service.read().records[0]).toMatchObject({
      state: 'working', message: 'Building', correlationId: 'turn-1', inboxSequence: 2,
    });
    expect(h.service.read().records[0]).not.toHaveProperty('reason');

    const cleared = await run.submit({ kind: 'clear', source: source('3') });
    expect(cleared.inboxSequence).toBe(3);
    expect(h.service.read().records).toEqual([]);
    await run.submit({ kind: 'set', state: 'working', source: source('4'), message: 'New work' });
    const lateClear = await run.submit({ kind: 'clear', source: source('3') });
    expect(lateClear).toMatchObject({
      accepted: true, reason: 'duplicate_source', inboxSequence: 3,
    });
    expect(h.service.read().records[0]).toMatchObject({ state: 'working', message: 'New work' });
  });

  it('arbitrates multiple provider sources into one Core sequence domain', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    const first = run.submit({ kind: 'set', state: 'working', source: source('hook-1', 'pi.hooks') });
    const second = run.submit({
      kind: 'set', state: 'waiting', source: source('extension-1'),
      eventId: 'question-1', message: 'Choose',
    });
    expect((await first).inboxSequence).toBe(1);
    expect((await second).inboxSequence).toBe(2);
    expect(h.service.read().records[0]).toMatchObject({ state: 'waiting', inboxSequence: 2 });
  });

  it('deduplicates source cursor and event id without changing state or revision', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    const operation: InboxOperation = {
      kind: 'set', state: 'done', source: source('cursor-1'),
      eventId: 'turn-done-1', message: 'Finished',
    };
    const first = await run.submit(operation);
    h.setNow(11_000);
    const sourceRetry = await run.submit(operation);
    expect(sourceRetry).toEqual({
      accepted: true,
      reason: 'duplicate_source',
      serviceEpoch: 'epoch-1',
      revision: 1,
      inboxSequence: first.inboxSequence,
      acceptedAt: first.acceptedAt,
      receivedAt: 11_000,
    });
    const eventRetry = await run.submit({ ...operation, source: source('cursor-2', 'pi.transcript') });
    expect(eventRetry).toMatchObject({
      accepted: true, reason: 'duplicate_event', revision: 1,
      inboxSequence: first.inboxSequence, acceptedAt: first.acceptedAt,
    });
    expect(h.service.read().terminalNotifications).toHaveLength(1);
  });

  it('rejects a cursor or event id reused for different semantics', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    await run.submit({
      kind: 'set', state: 'done', source: source('1'), eventId: 'same-event', message: 'Done',
    });
    expect(await run.submit({
      kind: 'set', state: 'error', source: source('1'), eventId: 'different-event', message: 'Failed',
    })).toMatchObject({ accepted: false, reason: 'invalid_operation', revision: 1 });
    expect(await run.submit({
      kind: 'set', state: 'error', source: source('2'), eventId: 'same-event', message: 'Failed',
    })).toMatchObject({ accepted: false, reason: 'invalid_operation', revision: 1 });
  });

  it('accepts missing event ids without inventing unread time or terminal notifications', async () => {
    const h = await harness();
    const result = await h.projector.forRun(h.lease).submit({
      kind: 'set', state: 'error', source: source('error-without-id'), message: 'Unknown failure',
    });
    expect(result).toMatchObject({ accepted: true, inboxSequence: 1 });
    expect(result).not.toHaveProperty('acceptedAt');
    expect(h.service.read().records[0]).not.toHaveProperty('acceptedAt');
    expect(h.service.read().terminalNotifications).toEqual([]);
  });

  it('rejects foreign sources and stale leases', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    expect(await run.submit({
      kind: 'set', state: 'working', source: source('1', 'claude.hooks'),
    })).toMatchObject({ accepted: false, reason: 'invalid_operation' });
    await h.runtime.revokePane('%1', 'process_exit');
    expect(await run.submit({
      kind: 'set', state: 'working', source: source('2'),
    })).toMatchObject({ accepted: false, reason: 'stale_lease' });
  });
});

describe('Inbox restore and lifecycle', () => {
  it('never emits a user notification while restoring a baseline', async () => {
    const h = await harness();
    const listener = vi.fn();
    h.service.subscribeNotifications(listener);
    await h.projector.restore({
      availability: 'ready',
      snapshot: [{
        run: h.lease.ref, source: source('snapshot'), state: 'done',
        eventId: 'provider-only-done', message: 'Recovered',
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it('restores a provider-only baseline without creating acceptedAt, unread or notification', async () => {
    const h = await harness();
    const receipt = await h.projector.restore({
      availability: 'ready',
      snapshot: [{
        run: h.lease.ref,
        source: source('snapshot-1'),
        state: 'done',
        eventId: 'provider-only-done',
        message: 'Recovered',
        sourceOccurredAt: 1,
      }],
    });
    expect(receipt).toEqual({ availability: 'ready', serviceEpoch: 'epoch-1', revision: 1 });
    const record = h.service.read().records[0];
    expect(record).toMatchObject({ state: 'done', eventId: 'provider-only-done', receivedAt: 10_000 });
    expect(record).not.toHaveProperty('acceptedAt');
    expect(h.service.read().terminalNotifications).toEqual([]);
  });

  it('preserves original acceptedAt when restore sees an already accepted event', async () => {
    const h = await harness();
    await h.projector.forRun(h.lease).submit({
      kind: 'set', state: 'done', source: source('live-1'), eventId: 'done-1', message: 'Done',
    });
    h.setNow(20_000);
    await h.projector.restore({
      availability: 'ready',
      snapshot: [{
        run: h.lease.ref, source: source('snapshot-2'), state: 'done',
        eventId: 'done-1', message: 'Done with details',
      }],
    });
    expect(h.service.read().records[0]).toMatchObject({
      message: 'Done with details', acceptedAt: 10_000, receivedAt: 20_000, inboxSequence: 1,
    });
    expect(h.service.read().terminalNotifications).toHaveLength(1);
  });

  it('preserves accepted and read state when the same session is reattached after Server restart', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 10_000, epoch: 'epoch-a' });
    const operation: InboxOperation = {
      kind: 'set', state: 'done', source: source('done-cursor'),
      eventId: 'stable-done', message: 'Finished', sourceOccurredAt: 9_000,
    };
    await first.projector.forRun(first.lease).submit(operation);
    const notificationId = first.service.read().terminalNotifications[0]!.id;
    first.setNow(12_000);
    await first.service.markTerminalRead([notificationId]);

    const restartedRuntime = new AgentRunRuntime({ newRunId: () => 'run-after-restart' });
    const restarted = await harness({
      store, runtime: restartedRuntime, now: 20_000, epoch: 'epoch-b',
    });
    const listener = vi.fn();
    restarted.service.subscribeNotifications(listener);
    const duplicate = await restarted.projector.forRun(restarted.lease).submit(operation);

    expect(duplicate).toMatchObject({
      accepted: true, reason: 'duplicate_event', acceptedAt: 10_000, receivedAt: 20_000,
    });
    expect(restarted.service.read().records.find((record) => (
      record.run.runId === 'run-after-restart'
    ))).toEqual(expect.objectContaining({
      run: expect.objectContaining({ runId: 'run-after-restart' }),
      eventId: 'stable-done', acceptedAt: 10_000, sourceOccurredAt: 9_000,
    }));
    expect(restarted.service.read().terminalNotifications).toEqual([
      expect.objectContaining({ id: notificationId, runId: 'run-1', readAt: 12_000 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not deduplicate the same event id across different native sessions', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 10_000 });
    const operation: InboxOperation = {
      kind: 'set', state: 'done', source: source('done-cursor'),
      eventId: 'provider-event-1', message: 'Finished',
    };
    await first.projector.forRun(first.lease).submit(operation);

    const nextRuntime = new AgentRunRuntime({ newRunId: () => 'run-other-session' });
    await nextRuntime.controller('pi', async () => true).attach({
      paneId: '%1',
      attachmentId: 'pi-attachment-2',
      sessionId: 'pi-session-2',
      process: { pid: 202, startedAt: 2_000, tty: '/dev/ttys002' },
    });
    const second = await harness({ store, runtime: nextRuntime, now: 20_000 });
    const accepted = await second.projector.forRun(second.lease).submit(operation);

    expect(accepted).toMatchObject({ accepted: true, acceptedAt: 20_000 });
    expect(accepted).not.toHaveProperty('reason');
    expect(second.service.read().terminalNotifications).toHaveLength(2);
  });

  it('links a restarted baseline to an event accepted by the same native session', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 10_000 });
    await first.projector.forRun(first.lease).submit({
      kind: 'set', state: 'done', source: source('live'),
      eventId: 'stable-done', message: 'Finished',
    });

    const restartedRuntime = new AgentRunRuntime({ newRunId: () => 'run-after-restart' });
    const restarted = await harness({ store, runtime: restartedRuntime, now: 20_000 });
    await restarted.projector.restore({
      availability: 'ready',
      snapshot: [{
        run: restarted.lease.ref, source: source('baseline'), state: 'done',
        eventId: 'stable-done', message: 'Finished',
      }],
    });

    expect(restarted.service.read().records).toEqual([expect.objectContaining({
      run: expect.objectContaining({ runId: 'run-after-restart' }),
      eventId: 'stable-done', acceptedAt: 10_000,
    })]);
    expect(restarted.service.read().terminalNotifications).toHaveLength(1);
  });

  it('does not clear state for unavailable restore, while ready empty is authoritative', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    await run.submit({ kind: 'set', state: 'working', source: source('1') });
    await h.projector.restore({ availability: 'unavailable', message: 'Extension offline' });
    expect(h.service.read().records).toHaveLength(1);
    expect(h.service.read().availability.pi).toEqual({
      availability: 'unavailable', message: 'Extension offline',
    });
    await h.projector.restore({ availability: 'ready', snapshot: [] });
    expect(h.service.read().records).toEqual([]);
  });

  it('clears revoked working/waiting but retains terminal latest values', async () => {
    const working = await harness();
    await working.projector.forRun(working.lease).submit({
      kind: 'set', state: 'working', source: source('1'),
    });
    await working.runtime.revokePane('%1', 'process_exit');
    await vi.waitFor(() => expect(working.service.read().records).toEqual([]));

    const terminal = await harness();
    await terminal.projector.forRun(terminal.lease).submit({
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1',
    });
    await terminal.runtime.revokePane('%1', 'process_exit');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(terminal.service.read().records[0]).toMatchObject({ state: 'done' });
  });
});

describe('Inbox terminal replay and persistence', () => {
  it('records a revoked terminal replay without rewriting latest Inbox state', async () => {
    const h = await harness();
    const delivered: unknown[] = [];
    h.service.subscribeNotifications((event) => { delivered.push(event); });
    const oldRef = h.lease.ref;
    await h.runtime.revokePane('%1', 'process_exit');
    const result = await h.projector.submitTerminalReplay({
      run: oldRef,
      source: source('durable-1'),
      state: 'done',
      eventId: 'offline-done-1',
      message: 'Finished while offline',
    });
    expect(result).toMatchObject({ accepted: true, inboxSequence: 1, acceptedAt: 10_000 });
    expect(h.service.read().records).toEqual([]);
    expect(h.service.read().terminalNotifications[0]).toMatchObject({
      agentId: 'pi', runId: 'run-1', paneId: '%1', eventId: 'offline-done-1',
      state: 'done', message: 'Finished while offline', acceptedAt: 10_000,
    });
    expect(h.service.read().terminalNotifications[0]?.expiresAt)
      .toBe(10_000 + 30 * 24 * 60 * 60 * 1000);
    await vi.waitFor(() => expect(delivered).toEqual([
      expect.objectContaining({
        run: oldRef, state: 'done', eventId: 'offline-done-1',
        terminalNotificationId: 'notification-1',
      }),
    ]));
  });

  it('rejects terminal replay for current or unknown runs and deduplicates revoked replay', async () => {
    const h = await harness();
    const replay = {
      run: h.lease.ref,
      source: source('1'),
      state: 'error' as const,
      eventId: 'error-1',
    };
    expect(await h.projector.submitTerminalReplay(replay)).toMatchObject({
      accepted: false, reason: 'invalid_operation',
    });
    await h.runtime.revokePane('%1', 'process_exit');
    const first = await h.projector.submitTerminalReplay(replay);
    const duplicate = await h.projector.submitTerminalReplay(replay);
    expect(duplicate).toMatchObject({
      accepted: true, reason: 'duplicate_source', inboxSequence: first.inboxSequence,
    });
    expect(await h.projector.submitTerminalReplay({
      ...replay,
      run: { agentId: 'pi', paneId: '%9', runId: 'unknown' },
      source: source('unknown'),
      eventId: 'unknown-event',
    })).toMatchObject({ accepted: false, reason: 'invalid_operation' });
  });

  it('persists run sequence, dedupe, acceptedAt and resets only the service epoch revision', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, epoch: 'epoch-a' });
    const operation: InboxOperation = {
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1', message: 'Done',
    };
    const accepted = await first.projector.forRun(first.lease).submit(operation);

    const second = await harness({ store, runtime: first.runtime, now: 20_000, epoch: 'epoch-b' });
    const duplicate = await second.projector.forRun(second.lease).submit(operation);
    expect(duplicate).toMatchObject({
      accepted: true, reason: 'duplicate_source', serviceEpoch: 'epoch-b', revision: 0,
      inboxSequence: accepted.inboxSequence, acceptedAt: 10_000, receivedAt: 20_000,
    });
    expect(await second.projector.forRun(second.lease).submit({
      kind: 'clear', source: source('2'),
    })).toMatchObject({ accepted: true, inboxSequence: 2, revision: 1 });
  });

  it('marks terminal notifications read once with authoritative service time and persists it', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 10_000, epoch: 'epoch-a' });
    await first.projector.forRun(first.lease).submit({
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1', message: 'Done',
    });
    const id = first.service.read().terminalNotifications[0]!.id;
    first.setNow(20_000);
    expect(await first.service.markTerminalRead([id])).toEqual({
      serviceEpoch: 'epoch-a', revision: 2, markedIds: [id], readAt: 20_000,
    });
    first.setNow(30_000);
    expect(await first.service.markTerminalRead([id])).toEqual({
      serviceEpoch: 'epoch-a', revision: 2, markedIds: [],
    });

    const second = await harness({ store, runtime: first.runtime, now: 40_000, epoch: 'epoch-b' });
    expect(second.service.read().terminalNotifications[0]).toMatchObject({ id, readAt: 20_000 });
  });

  it('marks legacy cross-run copies of one session event read together', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 10_000 });
    await first.projector.forRun(first.lease).submit({
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1',
    });
    const persisted = store.load() as PersistedInboxState;
    const original = persisted.terminalNotifications[0]!;
    persisted.terminalNotifications.push({
      ...original, id: 'legacy-restart-copy', runId: 'old-restart-run',
    });
    store.save(persisted);

    const second = await harness({ store, runtime: first.runtime, now: 20_000 });
    expect(await second.service.markTerminalRead([original.id])).toMatchObject({
      markedIds: [original.id, 'legacy-restart-copy'], readAt: 20_000,
    });
    expect(second.service.read().terminalNotifications)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: original.id, readAt: 20_000 }),
        expect.objectContaining({ id: 'legacy-restart-copy', readAt: 20_000 }),
      ]));
  });

  it('marks only requested known notifications and rejects unbounded input', async () => {
    const h = await harness();
    const run = h.projector.forRun(h.lease);
    await run.submit({ kind: 'set', state: 'done', source: source('1'), eventId: 'done-1' });
    await run.submit({ kind: 'set', state: 'error', source: source('2'), eventId: 'error-1' });
    const [first, second] = h.service.read().terminalNotifications;
    expect(await h.service.markTerminalRead([first!.id, 'unknown'])).toMatchObject({
      markedIds: [first!.id], readAt: 10_000,
    });
    expect(h.service.read().terminalNotifications).toEqual([
      expect.objectContaining({ id: first!.id, readAt: 10_000 }),
      expect.not.objectContaining({ id: second!.id, readAt: expect.anything() }),
    ]);
    await expect(h.service.markTerminalRead([])).rejects.toThrow(InboxContractError);
    await expect(h.service.markTerminalRead(['x'.repeat(257)])).rejects.toThrow(InboxContractError);
  });

  it('rolls back sequence and state when persistence fails', async () => {
    class FailingStore implements InboxStateStore {
      state: PersistedInboxState | null = null;
      fail = true;
      load(): unknown { return this.state; }
      save(state: PersistedInboxState): void {
        if (this.fail) throw new Error('disk full');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingStore();
    const h = await harness({ store });
    const run = h.projector.forRun(h.lease);
    const listener = vi.fn();
    h.service.subscribeNotifications(listener);
    const operation: InboxOperation = {
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1',
    };
    expect(await run.submit(operation))
      .toMatchObject({ accepted: false, reason: 'persistence_failed', revision: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
    store.fail = false;
    expect(await run.submit(operation))
      .toMatchObject({ accepted: true, inboxSequence: 1, revision: 1 });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  });

  it('expires canonical terminal notifications after 30 days even if unread', async () => {
    const store = new MemoryInboxStateStore();
    const first = await harness({ store, now: 1_000 });
    await first.projector.forRun(first.lease).submit({
      kind: 'set', state: 'done', source: source('1'), eventId: 'done-1',
    });
    expect(first.service.read().terminalNotifications).toHaveLength(1);
    const afterExpiry = 1_000 + 30 * 24 * 60 * 60 * 1000 + 1;
    first.setNow(afterExpiry);
    expect(first.service.read()).toMatchObject({ revision: 2, terminalNotifications: [] });
    const second = await harness({ store, runtime: first.runtime, now: afterExpiry });
    expect(second.service.read().terminalNotifications).toEqual([]);
  });

  it('fails closed on corrupt persisted state', async () => {
    const runtime = new AgentRunRuntime();
    expect(() => new InboxService({
      runs: runtime,
      adapterIds: ['pi'],
      store: { load: () => ({ version: 1, runs: 'bad' }), save: () => {} },
    })).toThrow(InboxContractError);
  });
});
