import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeContractError,
  BridgeRequestError,
  LocalAgentBridge,
} from '../src/agent-runtime/bridge.js';
import {
  FileBridgeStateStore,
  MemoryBridgeStateStore,
} from '../src/agent-runtime/bridgeStore.js';
import type { BridgeStateStore, PersistedBridgeState } from '../src/agent-runtime/bridgeStore.js';
import type { BridgeDurableReplay, BridgeHostEvent } from '../src/agent-runtime/bridgeTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';

const bridges: LocalAgentBridge[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function harness(options: {
  store?: BridgeStateStore;
  limits?: ConstructorParameters<typeof LocalAgentBridge>[0]['limits'];
  retryDelayMs?: number;
  runtime?: AgentRunRuntime;
  newRequestId?: () => string;
} = {}): Promise<{
  runtime: AgentRunRuntime;
  lease: AgentRunLease;
  bridge: LocalAgentBridge;
}> {
  const runtime = options.runtime ?? new AgentRunRuntime({ newRunId: () => 'run-1' });
  const controller = runtime.controller('pi', async () => true);
  const current = runtime.currentForPane('%1');
  const lease = current ?? await controller.attach({
    paneId: '%1',
    attachmentId: 'pi-attachment',
    sessionId: 'pi-session',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
  });
  let connection = 0;
  const bridge = new LocalAgentBridge({
    runs: runtime,
    adapterIds: ['pi', 'claude'],
    ...(options.store ? { store: options.store } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
    newConnectionId: () => `connection-${++connection}`,
  });
  bridges.push(bridge);
  return { runtime, lease, bridge };
}

async function waitForEvents(events: BridgeHostEvent[], count: number): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count));
}

describe('LocalAgentBridge sequence and snapshot lane', () => {
  it('shares one persistent sequence across snapshot and ephemeral operations', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('inbox');
    expect(await channel.publish({ payload: { state: 'working' } })).toEqual({
      accepted: true, sequence: 1,
    });
    expect(await channel.setSnapshot({ state: 'working' })).toEqual({ accepted: true, sequence: 2 });
    expect(await channel.publish({ payload: { state: 'done' } })).toEqual({
      accepted: true, sequence: 3,
    });

    const events: BridgeHostEvent[] = [];
    const handle = await bridge.hostFor('pi').openChannel(lease, 'inbox', (event) => {
      events.push(event);
    });
    expect(handle).toMatchObject({
      snapshot: { state: 'working' }, snapshotAvailability: 'ready', streamSequence: 2,
    });
    await waitForEvents(events, 1);
    expect(events).toEqual([{
      type: 'event', event: { sequence: 3, payload: { state: 'done' } },
    }]);
  });

  it('establishes the subscriber atomically and never calls it before open returns', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('conversation');
    await channel.setSnapshot({ view: 'base' });
    let openReturned = false;
    const observations: boolean[] = [];
    const opened = bridge.hostFor('pi').openChannel(lease, 'conversation', () => {
      observations.push(openReturned);
    });
    const publishing = channel.publish({ payload: { delta: 'next' } });
    const handle = await opened;
    openReturned = true;
    expect(handle.streamSequence).toBe(1);
    expect(await publishing).toEqual({ accepted: true, sequence: 2 });
    await vi.waitFor(() => expect(observations).toEqual([true]));
  });

  it('rotates transport connections without changing the run or reusing sequence', async () => {
    const { bridge, lease } = await harness();
    const first = bridge.connect(lease);
    const oldChannel = first.channel('inbox');
    expect(await oldChannel.setSnapshot({ state: 'idle' })).toMatchObject({ sequence: 1 });

    const second = bridge.connect(lease);
    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe('transport_replaced');
    expect(lease.signal.aborted).toBe(false);
    expect(await oldChannel.publish({ payload: 'stale' })).toEqual({
      accepted: false, reason: 'stale_lease',
    });
    expect(await second.channel('inbox').publish({ payload: 'current' })).toEqual({
      accepted: true, sequence: 2,
    });
  });

  it('returns unavailable separately from a ready null snapshot', async () => {
    const { bridge, lease } = await harness();
    const host = bridge.hostFor('pi');
    expect(await host.openChannel(lease, 'inbox', () => {})).toMatchObject({
      snapshotAvailability: 'unavailable', streamSequence: 0,
    });
    await bridge.connect(lease).channel('inbox').setSnapshot(null);
    expect(await host.openChannel(lease, 'inbox', () => {})).toMatchObject({
      snapshot: null, snapshotAvailability: 'ready', streamSequence: 1,
    });
  });

  it('turns bounded ephemeral overflow into a gap before newer live events', async () => {
    const { bridge, lease } = await harness({
      limits: { maxQueuedEventsPerChannel: 1, burstEvents: 10 },
    });
    const channel = bridge.connect(lease).channel('conversation');
    expect(await channel.publish({ payload: { delta: 1 } })).toMatchObject({ accepted: true, sequence: 1 });
    expect(await channel.publish({ payload: { delta: 2 } })).toEqual({
      accepted: false, reason: 'rate_limited',
    });

    const events: BridgeHostEvent[] = [];
    await bridge.hostFor('pi').openChannel(lease, 'conversation', (event) => { events.push(event); });
    expect(await channel.publish({ payload: { delta: 3 } })).toMatchObject({ accepted: true, sequence: 2 });
    await waitForEvents(events, 2);
    expect(events).toEqual([
      { type: 'gap', afterSequence: 0 },
      { type: 'event', event: { sequence: 2, payload: { delta: 3 } } },
    ]);
  });

  it('does not let an in-flight older callback remove a newer snapshot operation', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('conversation');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: BridgeHostEvent[] = [];
    await bridge.hostFor('pi').openChannel(lease, 'conversation', async (event) => {
      events.push(event);
      if (event.type === 'event') await firstGate;
    });
    await channel.publish({ payload: { delta: 'old' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await channel.setSnapshot({ view: 'new baseline' });
    releaseFirst();
    await waitForEvents(events, 2);
    expect(events).toEqual([
      { type: 'event', event: { sequence: 1, payload: { delta: 'old' } } },
      { type: 'snapshot', sequence: 2, value: { view: 'new baseline' } },
    ]);
  });
});

describe('LocalAgentBridge durable lane', () => {
  it('requires a stable event id and deduplicates retries onto the original sequence', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('inbox');
    expect(await channel.publish({ payload: { state: 'done' } }, { delivery: 'durable' }))
      .toEqual({ accepted: false, reason: 'invalid' });
    expect(await channel.publish({ eventId: 'turn-1', payload: { state: 'done' } }, {
      delivery: 'durable',
    })).toEqual({ accepted: true, sequence: 1 });
    expect(await channel.publish({ eventId: 'turn-1', payload: { state: 'done' } }, {
      delivery: 'durable',
    })).toEqual({ accepted: true, sequence: 1, reason: 'duplicate' });
    expect(await channel.publish({ eventId: 'turn-1', payload: { state: 'error' } }, {
      delivery: 'durable',
    })).toEqual({ accepted: false, reason: 'invalid' });

    const replays: BridgeDurableReplay[] = [];
    const sink = vi.fn(async (replay: BridgeDurableReplay) => {
      replays.push(replay);
      return 'accepted' as const;
    });
    bridge.hostFor('pi').consumeDurableReplays('inbox', sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(replays[0]?.event).toEqual({
      eventId: 'turn-1', sequence: 1, payload: { state: 'done' },
    });
  });

  it('replays current-run durable events at or below the snapshot baseline', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('inbox');
    await channel.publish({ eventId: 'settled-1', payload: { state: 'done' } }, { delivery: 'durable' });
    await channel.setSnapshot({ state: 'done' });

    const live: BridgeHostEvent[] = [];
    const host = bridge.hostFor('pi');
    const opened = await host.openChannel(lease, 'inbox', (event) => { live.push(event); });
    expect(opened).toMatchObject({ snapshot: { state: 'done' }, streamSequence: 2 });

    const replays: BridgeDurableReplay[] = [];
    const durable = vi.fn(async (replay: BridgeDurableReplay) => {
      replays.push(replay);
      return 'accepted' as const;
    });
    host.consumeDurableReplays('inbox', durable);
    await vi.waitFor(() => expect(durable).toHaveBeenCalledTimes(1));
    expect(replays[0]).toMatchObject({
      runStatus: 'current',
      event: { eventId: 'settled-1', sequence: 1, payload: { state: 'done' } },
    });
    expect(live).toEqual([]);
  });

  it('keeps retry events spooled and deletes them only after accepted acknowledgement', async () => {
    const store = new MemoryBridgeStateStore();
    const { bridge, lease, runtime } = await harness({ store, retryDelayMs: 5 });
    await bridge.connect(lease).channel('inbox').publish({
      eventId: 'retry-1', payload: { state: 'done' },
    }, { delivery: 'durable' });
    const sink = vi.fn()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('accepted');
    bridge.hostFor('pi').consumeDurableReplays('inbox', sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
    await bridge.close();

    const restarted = (await harness({ store, runtime })).bridge;
    const afterRestart = vi.fn(async () => 'accepted' as const);
    restarted.hostFor('pi').consumeDurableReplays('inbox', afterRestart);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(afterRestart).not.toHaveBeenCalled();
  });

  it('drains pre-baseline durable events only after the consumer acknowledges them', async () => {
    const { bridge, lease } = await harness({ retryDelayMs: 5 });
    const channel = bridge.connect(lease).channel('inbox');
    await channel.publish({ eventId: 'settled-1', payload: { state: 'done' } }, {
      delivery: 'durable',
    });
    await channel.setSnapshot({ state: 'done' });

    const host = bridge.hostFor('pi');
    const opened = await host.openChannel(lease, 'inbox', () => {});
    expect(opened.streamSequence).toBe(2);
    let accept = false;
    const consumer = vi.fn(async () => (accept ? 'accepted' as const : 'retry' as const));
    host.consumeDurableReplays('inbox', consumer);

    let drained = false;
    const draining = host.drainDurable(lease.ref, 'inbox', opened.streamSequence)
      .then(() => { drained = true; });
    await vi.waitFor(() => expect(consumer).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);

    accept = true;
    await draining;
    expect(drained).toBe(true);
    await expect(host.drainDurable(lease.ref, 'inbox', 0)).resolves.toBeUndefined();
  });

  it('rejects invalid durable drains and pending drains when the Bridge closes', async () => {
    const { bridge, lease } = await harness({ retryDelayMs: 100 });
    const host = bridge.hostFor('pi');
    await expect(host.drainDurable({ ...lease.ref, runId: 'unknown' }, 'inbox', 1))
      .rejects.toBeInstanceOf(BridgeContractError);
    await expect(host.drainDurable(lease.ref, 'inbox', -1))
      .rejects.toBeInstanceOf(BridgeContractError);

    await bridge.connect(lease).channel('inbox').publish({
      eventId: 'pending-1', payload: { state: 'done' },
    }, { delivery: 'durable' });
    host.consumeDurableReplays('inbox', async () => 'retry');

    const abort = new AbortController();
    const cancelled = host.drainDurable(lease.ref, 'inbox', 1, { signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toThrow('Durable drain was cancelled');

    const draining = host.drainDurable(lease.ref, 'inbox', 1);
    const rejected = expect(draining).rejects.toThrow(/closed before durable drain/);
    await bridge.close();
    await rejected;
  });

  it('replays an already-spooled event as revoked but rejects new live control', async () => {
    const { bridge, lease, runtime } = await harness();
    const channel = bridge.connect(lease).channel('inbox');
    await channel.publish({ eventId: 'terminal-1', payload: { state: 'done' } }, {
      delivery: 'durable',
    });
    await runtime.revokePane('%1', 'process_exit');
    expect(await channel.publish({ payload: { state: 'working' } })).toEqual({
      accepted: false, reason: 'stale_lease',
    });
    await expect(bridge.hostFor('pi').openChannel(lease, 'inbox', () => {}))
      .rejects.toBeInstanceOf(BridgeContractError);

    const replays: BridgeDurableReplay[] = [];
    const sink = vi.fn(async (replay: BridgeDurableReplay) => {
      replays.push(replay);
      return 'accepted' as const;
    });
    bridge.hostFor('pi').consumeDurableReplays('inbox', sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(replays[0]).toMatchObject({ runStatus: 'revoked' });
  });

  it('serializes an older durable replay before a newer live callback', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('inbox');
    await channel.publish({ eventId: 'durable-1', payload: 'durable' }, { delivery: 'durable' });
    const order: string[] = [];
    await bridge.hostFor('pi').openChannel(lease, 'inbox', () => { order.push('live'); });
    await channel.publish({ payload: 'ephemeral' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);

    bridge.hostFor('pi').consumeDurableReplays('inbox', async () => {
      order.push('durable');
      return 'accepted';
    });
    await vi.waitFor(() => expect(order).toEqual(['durable', 'live']));
  });
});

describe('LocalAgentBridge request lane', () => {
  it('dispatches a bounded request with a stable context and cloned response', async () => {
    let request = 0;
    const { bridge, lease } = await harness({ newRequestId: () => `request-${++request}` });
    const channel = bridge.connect(lease).channel('conversation');
    let observedPayload: unknown;
    let observedContext: { requestId: string; deadlineAt: number; aborted: boolean } | undefined;
    channel.handle('send', async (payload, context) => {
      observedPayload = payload;
      observedContext = {
        requestId: context.requestId,
        deadlineAt: context.deadlineAt,
        aborted: context.signal.aborted,
      };
      return { accepted: true, nested: payload };
    });

    const payload = { text: 'hello' };
    const result = await bridge.hostFor('pi').request(lease, 'conversation', 'send', payload);
    payload.text = 'changed';
    expect(observedPayload).toEqual({ text: 'hello' });
    expect(observedContext).toMatchObject({ requestId: 'request-1', aborted: false });
    expect(observedContext!.deadlineAt).toBeGreaterThan(Date.now());
    expect(result).toEqual({ accepted: true, nested: { text: 'hello' } });
  });

  it('validates handler ownership, names, payload size and timeout policy', async () => {
    const { bridge, lease } = await harness({
      limits: { maxFrameBytes: 100, defaultRequestTimeoutMs: 25, maxRequestTimeoutMs: 50 },
    });
    const channel = bridge.connect(lease).channel('conversation');
    channel.handle('send', async () => ({ ok: true }));
    expect(() => channel.handle('send', async () => null)).toThrow(BridgeContractError);
    expect(() => channel.handle('../bad', async () => null)).toThrow(BridgeContractError);
    await expect(bridge.hostFor('pi').request(lease, 'conversation', 'missing', {}))
      .rejects.toMatchObject({ code: 'unavailable' });
    await expect(bridge.hostFor('pi').request(
      lease, 'conversation', 'send', 'x'.repeat(200),
    )).rejects.toBeInstanceOf(BridgeContractError);
    await expect(bridge.hostFor('pi').request(
      lease, 'conversation', 'send', {}, { timeoutMs: 51 },
    )).rejects.toBeInstanceOf(BridgeContractError);
  });

  it('times out once, aborts the handler and ignores its late response', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('conversation');
    let handlerSignal: AbortSignal | undefined;
    channel.handle('send', async (_payload, context) => {
      handlerSignal = context.signal;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { accepted: true };
    });
    await expect(bridge.hostFor('pi').request(
      lease, 'conversation', 'send', {}, { timeoutMs: 10 },
    )).rejects.toMatchObject({ code: 'timeout' });
    expect(handlerSignal?.aborted).toBe(true);
    expect(handlerSignal?.reason).toMatchObject({ code: 'timeout' });
  });

  it('propagates caller cancellation and handler removal immediately', async () => {
    const { bridge, lease } = await harness();
    const channel = bridge.connect(lease).channel('conversation');
    let calls = 0;
    const remove = channel.handle('send', async (_payload, context) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return null;
    });
    const caller = new AbortController();
    const cancelled = bridge.hostFor('pi').request(
      lease, 'conversation', 'send', {}, { signal: caller.signal },
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

    const removed = bridge.hostFor('pi').request(lease, 'conversation', 'send', {});
    await vi.waitFor(() => expect(calls).toBe(2));
    remove();
    await expect(removed).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bridge.hostFor('pi').request(lease, 'conversation', 'send', {}))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('cancels old transport requests on reconnect and lease revoke', async () => {
    const { bridge, lease, runtime } = await harness();
    const first = bridge.connect(lease);
    let calls = 0;
    first.channel('conversation').handle('send', async (_payload, context) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return null;
    });
    const reconnecting = bridge.hostFor('pi').request(lease, 'conversation', 'send', {});
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = bridge.connect(lease);
    await expect(reconnecting).rejects.toMatchObject({ code: 'unavailable' });

    second.channel('conversation').handle('send', async (_payload, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return null;
    });
    const revoking = bridge.hostFor('pi').request(lease, 'conversation', 'send', {});
    await runtime.revokePane('%1', 'session_replaced');
    await expect(revoking).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('enforces per-run concurrency and releases the slot after completion', async () => {
    const { bridge, lease } = await harness({
      limits: { maxRequestsPerRun: 1, maxRequestsPerAdapter: 1 },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => { await gate; return { ok: true }; });
    bridge.connect(lease).channel('conversation').handle('send', handler);
    const first = bridge.hostFor('pi').request(lease, 'conversation', 'send', { id: 1 });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(bridge.hostFor('pi').request(lease, 'conversation', 'send', { id: 2 }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    release();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(bridge.hostFor('pi').request(lease, 'conversation', 'send', { id: 3 }))
      .resolves.toEqual({ ok: true });
  });

  it('rejects handler failures and invalid responses without leaking their errors', async () => {
    const { bridge, lease } = await harness({ limits: { maxFrameBytes: 100 } });
    const channel = bridge.connect(lease).channel('conversation');
    channel.handle('fail', async () => { throw new Error('provider secret'); });
    channel.handle('invalid', async () => undefined);
    channel.handle('large', async () => 'x'.repeat(200));
    const host = bridge.hostFor('pi');
    const failed = host.request(lease, 'conversation', 'fail', {});
    await expect(failed).rejects.toEqual(expect.objectContaining({
      code: 'handler_error', message: 'Bridge request handler failed',
    }));
    await expect(host.request(lease, 'conversation', 'invalid', {}))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(host.request(lease, 'conversation', 'large', {}))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('cancels pending requests when the Bridge closes', async () => {
    const { bridge, lease } = await harness();
    bridge.connect(lease).channel('conversation').handle('send', async (_payload, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return null;
    });
    const pending = bridge.hostFor('pi').request(lease, 'conversation', 'send', {});
    const rejected = expect(pending).rejects.toBeInstanceOf(BridgeRequestError);
    await bridge.close();
    await rejected;
  });
});

describe('LocalAgentBridge persistence and boundaries', () => {
  it('persists sequence, snapshot, durable spool and an ephemeral restart gap', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-agent-bridge-'));
    tempDirectories.push(directory);
    const store = new FileBridgeStateStore(path.join(directory, '.handmux', 'bridge.json'));
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
    const first = await harness({ store, runtime });
    const channel = first.bridge.connect(first.lease).channel('conversation');
    await channel.publish({ eventId: 'durable-1', payload: 'durable' }, { delivery: 'durable' });
    await channel.setSnapshot({ view: 'base' });
    await channel.publish({ payload: { delta: 'lost-on-restart' } });
    await first.bridge.close();

    const second = await harness({ store, runtime });
    const events: BridgeHostEvent[] = [];
    const opened = await second.bridge.hostFor('pi').openChannel(
      second.lease,
      'conversation',
      (event) => { events.push(event); },
    );
    expect(opened).toMatchObject({ snapshot: { view: 'base' }, streamSequence: 2 });
    const replays: BridgeDurableReplay[] = [];
    const durable = vi.fn(async (replay: BridgeDurableReplay) => {
      replays.push(replay);
      return 'accepted' as const;
    });
    second.bridge.hostFor('pi').consumeDurableReplays('conversation', durable);
    await waitForEvents(events, 1);
    expect(events).toEqual([{ type: 'gap', afterSequence: 2 }]);
    expect(replays[0]?.event.sequence).toBe(1);
    expect(await second.bridge.connect(second.lease).channel('conversation').publish({ payload: 'next' }))
      .toEqual({ accepted: true, sequence: 4 });
    expect(fs.statSync(path.join(directory, '.handmux', 'bridge.json')).mode & 0o777).toBe(0o600);
  });

  it('rolls back sequence allocation when atomic durable persistence fails', async () => {
    class FailingStore implements BridgeStateStore {
      state: PersistedBridgeState | null = null;
      fail = true;
      load(): unknown { return this.state; }
      save(state: PersistedBridgeState): void {
        if (this.fail) throw new Error('disk full');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingStore();
    const { bridge, lease } = await harness({ store });
    const channel = bridge.connect(lease).channel('inbox');
    expect(await channel.publish({ eventId: 'done-1', payload: 'done' }, { delivery: 'durable' }))
      .toEqual({ accepted: false, reason: 'spool_full' });
    store.fail = false;
    expect(await channel.publish({ eventId: 'done-1', payload: 'done' }, { delivery: 'durable' }))
      .toEqual({ accepted: true, sequence: 1 });
  });

  it('enforces static adapters, trusted names, JSON payloads, sizes and spool quota', async () => {
    const { bridge, lease } = await harness({
      limits: { maxFrameBytes: 200, maxDurableSpoolBytesPerAdapter: 120 },
    });
    expect(() => bridge.hostFor('unknown')).toThrow(BridgeContractError);
    const connection = bridge.connect(lease);
    expect(() => connection.channel('handmux.internal')).toThrow(BridgeContractError);
    expect(() => connection.channel('../bad')).toThrow(BridgeContractError);
    const channel = connection.channel('inbox');
    expect(await channel.publish({ payload: { bad: undefined } })).toEqual({
      accepted: false, reason: 'invalid',
    });
    expect(await channel.publish({ payload: 'x'.repeat(200) })).toEqual({
      accepted: false, reason: 'invalid',
    });
    expect(await channel.publish({ eventId: 'large-1', payload: 'x'.repeat(50) }, {
      delivery: 'durable',
    })).toEqual({ accepted: false, reason: 'spool_full' });
  });

  it('fails closed on corrupt durable state and after Bridge shutdown', async () => {
    const corrupt: BridgeStateStore = {
      load: () => ({ version: 1, channels: [{ broken: true }] }),
      save: () => {},
    };
    const runtime = new AgentRunRuntime();
    expect(() => new LocalAgentBridge({ runs: runtime, adapterIds: ['pi'], store: corrupt }))
      .toThrow(BridgeContractError);

    const { bridge, lease } = await harness();
    const host = bridge.hostFor('pi');
    await bridge.close();
    expect(() => bridge.connect(lease)).toThrow(BridgeContractError);
    await expect(host.openChannel(lease, 'inbox', () => {})).rejects.toBeInstanceOf(BridgeContractError);
    expect(() => host.consumeDurableReplays('inbox', async () => 'accepted'))
      .toThrow(BridgeContractError);
  });
});
