import { describe, expect, it, vi } from 'vitest';
import { InteractionService } from '../src/agent-runtime/interaction.js';
import { InteractionLiveHub } from '../src/agent-runtime/interactionLiveHub.js';
import type {
  AgentInteractionAdapterV1,
  InteractionEvent,
  InteractionEventSink,
  InteractionLiveHandle,
} from '../src/agent-runtime/interactionTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';

function harness() {
  const controller = new AbortController();
  const lease: AgentRunLease = {
    ref: { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'thread-1' },
    signal: controller.signal,
  };
  let sink: InteractionEventSink | undefined;
  const close = vi.fn();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const open = vi.fn(async (_run: AgentRunLease, next: InteractionEventSink) => {
    sink = next;
    return {
      revision: 4,
      pending: [{
        id: 'interaction-1', runId: 'run-1', type: 'approval', prompt: 'Allow?',
        options: [{ id: 'allow', label: 'Allow' }], resolutionToken: 'resolution-1',
      }],
      closed,
      close,
    } satisfies InteractionLiveHandle;
  });
  return {
    lease,
    controller,
    close,
    resolveClosed,
    open,
    async emit(event: InteractionEvent) {
      if (!sink) throw new Error('not observing');
      await sink(event);
    },
  };
}

describe('InteractionLiveHub', () => {
  it('shares one Core observation and gives each subscriber an atomic current baseline', async () => {
    const h = harness();
    const hub = new InteractionLiveHub({ interaction: { open: h.open }, idleGraceMs: 0 });
    const first = await hub.subscribe(h.lease);
    const second = await hub.subscribe(h.lease);
    expect(h.open).toHaveBeenCalledOnce();
    expect(first.checkpoint).toEqual({
      revision: 4,
      pending: [expect.objectContaining({ id: 'interaction-1', resolutionToken: 'resolution-1' })],
    });
    const opened: InteractionEvent = {
      type: 'opened', revision: 5,
      interaction: {
        id: 'interaction-2', runId: 'run-1', type: 'text', prompt: 'Name?',
        resolutionToken: 'resolution-2',
      },
    };
    await h.emit(opened);
    expect(await first[Symbol.asyncIterator]().next()).toEqual({ value: opened, done: false });
    expect(await second[Symbol.asyncIterator]().next()).toEqual({ value: opened, done: false });

    first.close();
    second.close();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('uses the latest projected pending state when a client reconnects during the grace period', async () => {
    const h = harness();
    const hub = new InteractionLiveHub({ interaction: { open: h.open }, idleGraceMs: 60_000 });
    const first = await hub.subscribe(h.lease);
    await h.emit({ type: 'resolved', revision: 5, interactionId: 'interaction-1' });
    expect((await first[Symbol.asyncIterator]().next()).value).toMatchObject({ type: 'resolved' });
    first.close();

    const second = await hub.subscribe(h.lease);
    expect(second.checkpoint).toEqual({ revision: 5, pending: [] });
    expect(h.open).toHaveBeenCalledOnce();
    second.close();
    hub.close();
  });

  it('upserts an opened interaction whose public identity is already pending', async () => {
    const h = harness();
    const hub = new InteractionLiveHub({ interaction: { open: h.open }, idleGraceMs: 60_000 });
    const first = await hub.subscribe(h.lease);
    const updated: InteractionEvent = {
      type: 'opened', revision: 5,
      interaction: {
        id: 'interaction-1', runId: 'run-1', type: 'approval', prompt: 'Allow updated command?',
        options: [{ id: 'allow', label: 'Allow' }], resolutionToken: 'resolution-1',
      },
    };

    await h.emit(updated);
    expect(await first[Symbol.asyncIterator]().next()).toEqual({ value: updated, done: false });
    const late = await hub.subscribe(h.lease);
    expect(late.checkpoint).toEqual({
      revision: 5,
      pending: [expect.objectContaining({
        id: 'interaction-1', prompt: 'Allow updated command?', resolutionToken: 'resolution-1',
      })],
    });
    first.close();
    late.close();
    hub.close();
  });

  it('fails a corrupt revision closed instead of exposing divergent pending state', async () => {
    const h = harness();
    const hub = new InteractionLiveHub({ interaction: { open: h.open } });
    const subscription = await hub.subscribe(h.lease);
    await expect(h.emit({
      type: 'resolved', revision: 8, interactionId: 'interaction-1',
    })).rejects.toThrow(/revision/i);
    expect(await subscription[Symbol.asyncIterator]().next()).toEqual({
      value: undefined, done: true,
    });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('fails a same-id opened event closed when its Core-owned resolution token changes', async () => {
    const h = harness();
    const hub = new InteractionLiveHub({ interaction: { open: h.open } });
    const subscription = await hub.subscribe(h.lease);
    await expect(h.emit({
      type: 'opened', revision: 5,
      interaction: {
        id: 'interaction-1', runId: 'run-1', type: 'approval', prompt: 'Allow?',
        options: [{ id: 'allow', label: 'Allow' }], resolutionToken: 'replacement-token',
      },
    })).rejects.toThrow(/opened event is invalid/i);
    expect(await subscription[Symbol.asyncIterator]().next()).toEqual({
      value: undefined, done: true,
    });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('delivers Core lease-revocation cancellations before closing app subscriptions', async () => {
    const runs = new AgentRunRuntime({ newRunId: () => 'run-1' });
    const controller = runs.controller('codex', async () => true);
    const lease = await controller.attach({
      paneId: '%1', attachmentId: 'codex-app-server', sessionId: 'thread-1',
      process: { pid: 101 },
    });
    const nativeClose = vi.fn();
    const adapter: AgentInteractionAdapterV1 = {
      apiVersion: 1,
      async observeNative() {
        return {
          checkpoint: {
            sourceCursor: 'cursor-1',
            pending: [{
              id: 'native-1', type: 'approval', prompt: 'Allow?',
              options: [{ id: 'allow', label: 'Allow' }],
            }],
          },
          close: nativeClose,
        };
      },
      async dispatchResponse() { return { status: 'accepted' }; },
    };
    const service = new InteractionService({
      runs,
      adapters: { codex: adapter },
      newToken: (() => { let id = 0; return () => `token-${++id}`; })(),
    });
    const hub = new InteractionLiveHub({ interaction: service });
    const subscription = await hub.subscribe(lease);
    const pending = subscription.checkpoint.pending[0]!;

    await controller.revoke(lease, 'provider_clear');
    expect(await subscription[Symbol.asyncIterator]().next()).toEqual({
      value: {
        type: 'cancelled', revision: 1,
        interactionId: pending.id, reason: 'stale_run',
      },
      done: false,
    });
    expect(await subscription[Symbol.asyncIterator]().next()).toEqual({
      value: undefined, done: true,
    });
    expect(nativeClose).toHaveBeenCalledOnce();
  });
});
