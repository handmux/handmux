import { describe, expect, it, vi } from 'vitest';
import { InteractionService } from '../src/agent-runtime/interaction.js';
import { MemoryInteractionStateStore } from '../src/agent-runtime/interactionStore.js';
import type {
  InteractionStateStore,
  PersistedInteractionState,
} from '../src/agent-runtime/interactionStore.js';
import type {
  AgentInteractionAdapterV1,
  InteractionAdapterEvent,
  InteractionAdapterEventSink,
  InteractionAdapterPending,
  InteractionEvent,
  InteractionReceipt,
} from '../src/agent-runtime/interactionTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease, ScopedAgentRunController } from '../src/agent-runtime/run.js';

function approval(id = 'native-approval'): InteractionAdapterPending {
  return {
    id, type: 'approval', prompt: 'Allow command?', correlationId: 'tool-1',
    options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
  };
}

interface AdapterHarness {
  adapter: AgentInteractionAdapterV1;
  checkpointCursor: string;
  checkpointPending: InteractionAdapterPending[];
  dispatch: ReturnType<typeof vi.fn<(request: unknown) => Promise<InteractionReceipt>>>;
  close: ReturnType<typeof vi.fn>;
  onObserve?: (sink: InteractionAdapterEventSink) => void | Promise<void>;
  emit(event: InteractionAdapterEvent): Promise<void>;
}

function adapterHarness(): AdapterHarness {
  let sink: InteractionAdapterEventSink | undefined;
  const harness = {} as AdapterHarness;
  harness.checkpointCursor = 'cursor-10';
  harness.checkpointPending = [approval()];
  harness.dispatch = vi.fn(async () => ({ status: 'accepted' }));
  harness.close = vi.fn();
  harness.emit = async (event) => {
    if (!sink) throw new Error('not observing');
    await sink(event);
  };
  harness.adapter = {
    apiVersion: 1,
    async observeNative(_run, next) {
      sink = next;
      await harness.onObserve?.(next);
      return {
        checkpoint: {
          sourceCursor: harness.checkpointCursor,
          pending: structuredClone(harness.checkpointPending),
        },
        close: harness.close,
      };
    },
    dispatchResponse: async (_run, request) => harness.dispatch(structuredClone(request)),
  };
  return harness;
}

function tokenFactory(): () => string {
  let next = 0;
  return () => `token-${++next}`;
}

async function runHarness(
  store: InteractionStateStore = new MemoryInteractionStateStore(),
  now: () => number = () => 10_000,
): Promise<{
  runtime: AgentRunRuntime;
  controller: ScopedAgentRunController;
  lease: AgentRunLease;
  adapter: AdapterHarness;
  service: InteractionService;
}> {
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const controller = runtime.controller('pi', async () => true);
  const lease = await controller.attach({
    paneId: '%1', attachmentId: 'pi-extension', sessionId: 'session-1',
    process: { pid: 101 },
  });
  const adapter = adapterHarness();
  const service = new InteractionService({
    runs: runtime, adapters: { pi: adapter.adapter }, store,
    now, newToken: tokenFactory(),
  });
  return { runtime, controller, lease, adapter, service };
}

async function opened(h: Awaited<ReturnType<typeof runHarness>>): Promise<{
  events: InteractionEvent[];
  pending: Awaited<ReturnType<InteractionService['open']>>['pending'][number];
}> {
  const events: InteractionEvent[] = [];
  const handle = await h.service.open(h.lease, (event) => { events.push(event); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const item = handle.pending[0];
  if (!item) throw new Error('expected pending interaction');
  return { events, pending: item };
}

describe('InteractionService open and projection', () => {
  it('fails open closed when an adapter ignores an Interaction handoff buffer overflow', async () => {
    const h = await runHarness();
    h.adapter.checkpointPending = [];
    h.adapter.onObserve = (sink) => {
      for (let index = 0; index < 1025; index += 1) {
        void Promise.resolve(sink({
          type: 'opened', sourceCursor: `cursor-${index + 11}`,
          interaction: { id: `question-${index}`, type: 'text', prompt: 'Value?' },
        })).catch(() => {});
      }
    };
    const events: InteractionEvent[] = [];

    await expect(h.service.open(h.lease, (event) => { events.push(event); })).rejects.toThrow(/buffer/i);
    expect(h.adapter.close).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it('wraps provider identity and returns an atomic pending baseline', async () => {
    const h = await runHarness();
    const events: InteractionEvent[] = [];
    const handle = await h.service.open(h.lease, (event) => { events.push(event); });
    expect(handle.revision).toBe(0);
    expect(handle.pending).toEqual([{
      id: 'interaction:token-1', runId: 'run-1', correlationId: 'tool-1',
      type: 'approval', prompt: 'Allow command?',
      options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      resolutionToken: 'resolution:token-2',
    }]);
    expect(JSON.stringify(handle)).not.toContain('native-approval');
    expect(events).toEqual([]);
  });

  it('buffers callbacks during observe and never invokes the facade before open returns', async () => {
    const h = await runHarness();
    h.adapter.checkpointPending = [];
    let returned = false;
    const observations: boolean[] = [];
    h.adapter.onObserve = async (sink) => sink({
      type: 'opened', sourceCursor: 'cursor-11', interaction: {
        id: 'question-2', type: 'text', prompt: 'Value?',
      },
    });
    const handle = await h.service.open(h.lease, () => { observations.push(returned); });
    returned = true;
    expect(handle.pending).toEqual([]);
    await vi.waitFor(() => expect(observations).toEqual([true]));
  });

  it('projects opened, resolved, and cancelled with handle-scoped revisions', async () => {
    const h = await runHarness();
    h.adapter.checkpointPending = [];
    const events: InteractionEvent[] = [];
    await h.service.open(h.lease, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.adapter.emit({
      type: 'opened', sourceCursor: 'cursor-11',
      interaction: { id: 'text-1', type: 'text', prompt: 'Name?' },
    });
    await h.adapter.emit({
      type: 'opened', sourceCursor: 'cursor-12', interaction: approval('approval-2'),
    });
    await h.adapter.emit({ type: 'resolved', sourceCursor: 'cursor-13', interactionId: 'text-1' });
    await h.adapter.emit({
      type: 'cancelled', sourceCursor: 'cursor-14', interactionId: 'approval-2', reason: 'provider_rejected',
    });
    expect(events.map((event) => [event.type, event.revision])).toEqual([
      ['opened', 1], ['opened', 2], ['resolved', 3], ['cancelled', 4],
    ]);
  });

  it('retains public identity and token when the same native pending item is reopened', async () => {
    const h = await runHarness();
    const firstEvents: InteractionEvent[] = [];
    const first = await h.service.open(h.lease, (event) => { firstEvents.push(event); });
    await first.close();
    h.adapter.checkpointPending = [{ ...approval(), prompt: 'Allow this command?' }];
    const second = await h.service.open(h.lease, () => {});
    expect(second.pending[0]).toMatchObject({
      id: first.pending[0]?.id,
      resolutionToken: first.pending[0]?.resolutionToken,
      prompt: 'Allow this command?',
    });
  });

  it('fails duplicate source cursors closed and cancels visible pending state', async () => {
    const h = await runHarness();
    const { events, pending } = await opened(h);
    await expect(h.adapter.emit({
      type: 'cancelled', sourceCursor: 'cursor-10', interactionId: 'native-approval',
    })).rejects.toThrow(/cursor/i);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: 'cancelled', revision: 1, interactionId: pending.id, reason: 'stream_reset',
    });
    expect(h.adapter.close).toHaveBeenCalledOnce();
  });

  it('closes native observation when fail-closed persistence fails', async () => {
    class FailingStore implements InteractionStateStore {
      state: PersistedInteractionState | null = null;
      fail = false;
      load(): unknown { return this.state; }
      save(state: PersistedInteractionState): void {
        if (this.fail) throw new Error('disk unavailable');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingStore();
    const h = await runHarness(store);
    const { events } = await opened(h);
    store.fail = true;

    await expect(h.adapter.emit({
      type: 'cancelled', sourceCursor: 'cursor-10', interactionId: 'native-approval',
    })).rejects.toThrow(/cursor/i);

    await vi.waitFor(() => expect(h.adapter.close).toHaveBeenCalledOnce());
    expect(events).toEqual([]);
    expect(store.state?.interactions).toMatchObject([{
      sourceInteractionId: 'native-approval', state: 'pending',
    }]);
  });

  it('bounds expired resolved-record pruning during long-running mutations', async () => {
    const store = new MemoryInteractionStateStore();
    let now = 10_000;
    const h = await runHarness(store, () => now);
    h.adapter.checkpointPending = Array.from({ length: 257 }, (_, index) => ({
      id: `question-${index}`, type: 'text' as const, prompt: 'Value?',
    }));
    await h.service.open(h.lease, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 257; index += 1) {
      await h.adapter.emit({
        type: 'resolved', sourceCursor: `cursor-${index + 11}`,
        interactionId: `question-${index}`,
      });
    }
    now += 25 * 60 * 60 * 1000;

    await h.adapter.emit({
      type: 'opened', sourceCursor: 'cursor-new-1',
      interaction: { id: 'new-1', type: 'text', prompt: 'Again?' },
    });
    expect((store.load() as PersistedInteractionState).interactions).toHaveLength(2);

    await h.adapter.emit({
      type: 'opened', sourceCursor: 'cursor-new-2',
      interaction: { id: 'new-2', type: 'text', prompt: 'Again?' },
    });
    expect((store.load() as PersistedInteractionState).interactions).toMatchObject([
      { sourceInteractionId: 'new-1', state: 'pending' },
      { sourceInteractionId: 'new-2', state: 'pending' },
    ]);
  });

  it('fails live closed when an adapter ignores an uncloneable event rejection', async () => {
    const h = await runHarness();
    const { events, pending } = await opened(h);
    const invalid = {
      type: 'opened', sourceCursor: 'cursor-11',
      interaction: {
        id: 'question-2', type: 'text', prompt: 'Value?', extensions: () => {},
      },
    } as unknown as InteractionAdapterEvent;

    void Promise.resolve(h.adapter.emit(invalid)).catch(() => {});

    await vi.waitFor(() => expect(events).toEqual([{
      type: 'cancelled', revision: 1, interactionId: pending.id, reason: 'stream_reset',
    }]));
    expect(h.adapter.close).toHaveBeenCalledOnce();
  });
});

describe('InteractionService responses and lifecycle', () => {
  it('strips Core credentials, dispatches once, and resolves the public interaction', async () => {
    const h = await runHarness();
    const { events, pending } = await opened(h);
    let release!: () => void;
    h.adapter.dispatch.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ status: 'accepted' });
    }));
    const request = {
      interactionId: pending.id,
      resolutionToken: pending.resolutionToken,
      value: { type: 'approval' as const, optionId: 'allow' },
    };
    const first = h.service.respond(h.lease, request);
    await vi.waitFor(() => expect(h.adapter.dispatch).toHaveBeenCalledOnce());
    expect(await h.service.respond(h.lease, request)).toEqual({ status: 'already_resolved' });
    expect(h.adapter.dispatch).toHaveBeenCalledWith({
      interactionId: 'native-approval', value: { type: 'approval', optionId: 'allow' },
    });
    expect(JSON.stringify(h.adapter.dispatch.mock.calls)).not.toContain('resolution:');
    release();
    expect(await first).toEqual({ status: 'accepted' });
    expect(events).toEqual([{ type: 'resolved', revision: 1, interactionId: pending.id }]);
  });

  it('validates values by interaction type and rejects local-only interactions', async () => {
    const h = await runHarness();
    h.adapter.checkpointPending = [
      approval(),
      { id: 'select-1', type: 'select', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
      { id: 'multi-1', type: 'multi_select', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
      { id: 'local-1', type: 'local_only', prompt: 'Use terminal' },
    ];
    const handle = await h.service.open(h.lease, () => {});
    const byType = new Map(handle.pending.map((item) => [item.type, item]));
    const select = byType.get('select')!;
    expect(await h.service.respond(h.lease, {
      interactionId: select.id, resolutionToken: select.resolutionToken,
      value: { type: 'selection', optionIds: [] },
    })).toEqual({ status: 'rejected', reason: 'invalid_value' });
    const local = byType.get('local_only')!;
    expect(await h.service.respond(h.lease, {
      interactionId: local.id, resolutionToken: local.resolutionToken,
      value: { type: 'text', text: 'x' },
    })).toEqual({ status: 'rejected', reason: 'local_only' });
    expect(h.adapter.dispatch).not.toHaveBeenCalled();
  });

  it('validates an exact provider-neutral multi-field form before dispatch', async () => {
    const h = await runHarness();
    h.adapter.checkpointPending = [{
      id: 'form-1', type: 'form', intent: 'input_request', prompt: 'Input requested',
      fields: [
        { id: 'field:0', type: 'secret', prompt: 'Password' },
        {
          id: 'field:1', type: 'select', prompt: 'Color', allowOther: true,
          options: [{ id: 'blue', label: 'Blue', description: 'Calm' }],
        },
      ],
    }];
    const handle = await h.service.open(h.lease, () => {});
    const form = handle.pending[0]!;
    expect(form).toMatchObject({
      type: 'form', intent: 'input_request', fields: [{ type: 'secret' }, { allowOther: true }],
    });
    await expect(h.service.respond(h.lease, {
      interactionId: form.id, resolutionToken: form.resolutionToken,
      value: { type: 'form', answers: { 'field:0': 'secret-only' } },
    })).resolves.toEqual({ status: 'rejected', reason: 'invalid_value' });
    expect(h.adapter.dispatch).not.toHaveBeenCalled();

    await expect(h.service.respond(h.lease, {
      interactionId: form.id, resolutionToken: form.resolutionToken,
      value: { type: 'form', answers: { 'field:0': 'secret-only', 'field:1': 'Mauve' } },
    })).resolves.toEqual({ status: 'accepted' });
    expect(h.adapter.dispatch).toHaveBeenCalledWith({
      interactionId: 'form-1',
      value: { type: 'form', answers: { 'field:0': 'secret-only', 'field:1': 'Mauve' } },
    });
  });

  it('allows a retry after a definite provider rejection', async () => {
    const h = await runHarness();
    const { pending } = await opened(h);
    h.adapter.dispatch
      .mockResolvedValueOnce({ status: 'rejected', reason: 'provider_rejected' })
      .mockResolvedValueOnce({ status: 'accepted' });
    const request = {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval' as const, optionId: 'allow' },
    };
    expect(await h.service.respond(h.lease, request)).toEqual({
      status: 'rejected', reason: 'provider_rejected',
    });
    expect(await h.service.respond(h.lease, request)).toEqual({ status: 'accepted' });
    expect(h.adapter.dispatch).toHaveBeenCalledTimes(2);
  });

  it('consumes the token after an unknown result and never automatically redelivers', async () => {
    const h = await runHarness();
    const { pending } = await opened(h);
    h.adapter.dispatch.mockResolvedValueOnce({ status: 'unknown', reason: 'temporarily_unavailable' });
    const request = {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval' as const, optionId: 'allow' },
    };
    expect(await h.service.respond(h.lease, request)).toEqual({
      status: 'unknown', reason: 'temporarily_unavailable',
    });
    expect(await h.service.respond(h.lease, request)).toEqual({
      status: 'unknown', reason: 'temporarily_unavailable',
    });
    expect(h.adapter.dispatch).toHaveBeenCalledOnce();
  });

  it('does not dispatch until the first-response ledger is durable', async () => {
    class FailingStore implements InteractionStateStore {
      state: PersistedInteractionState | null = null;
      fail = false;
      load(): unknown { return this.state; }
      save(state: PersistedInteractionState): void {
        if (this.fail) throw new Error('disk unavailable');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingStore();
    const h = await runHarness(store);
    const { pending } = await opened(h);
    store.fail = true;
    expect(await h.service.respond(h.lease, {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval', optionId: 'allow' },
    })).toEqual({ status: 'unknown', reason: 'temporarily_unavailable' });
    expect(h.adapter.dispatch).not.toHaveBeenCalled();
  });

  it('reports unknown without redispatch when the terminal receipt cannot become durable', async () => {
    class FailingTerminalStore implements InteractionStateStore {
      state: PersistedInteractionState | null = null;
      saves = 0;
      load(): unknown { return this.state; }
      save(state: PersistedInteractionState): void {
        this.saves += 1;
        if (this.saves === 3) throw new Error('disk unavailable');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingTerminalStore();
    const h = await runHarness(store);
    const { pending } = await opened(h);
    const request = {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval' as const, optionId: 'allow' },
    };

    expect(await h.service.respond(h.lease, request)).toEqual({
      status: 'unknown', reason: 'temporarily_unavailable',
    });
    expect(await h.service.respond(h.lease, request)).toEqual({
      status: 'unknown', reason: 'stream_reset',
    });
    expect(h.adapter.dispatch).toHaveBeenCalledOnce();
  });

  it('marks a recovered dispatching response unknown instead of resending it', async () => {
    const store = new MemoryInteractionStateStore();
    const h = await runHarness(store);
    const { pending } = await opened(h);
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    h.adapter.dispatch.mockImplementationOnce(async () => {
      started();
      return new Promise<InteractionReceipt>(() => {});
    });
    void h.service.respond(h.lease, {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval', optionId: 'allow' },
    });
    await dispatched;
    const restartedAdapter = adapterHarness();
    const restarted = new InteractionService({
      runs: h.runtime, adapters: { pi: restartedAdapter.adapter }, store,
      now: () => 20_000, newToken: tokenFactory(),
    });
    expect(await restarted.respond(h.lease, {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval', optionId: 'allow' },
    })).toEqual({ status: 'unknown', reason: 'temporarily_unavailable' });
    expect(restartedAdapter.dispatch).not.toHaveBeenCalled();
  });

  it('cancels pending interactions and rejects controls when the run is revoked', async () => {
    const h = await runHarness();
    const { events, pending } = await opened(h);
    await h.controller.revoke(h.lease, 'provider_clear');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: 'cancelled', revision: 1, interactionId: pending.id, reason: 'stale_run',
    });
    expect(h.adapter.close).toHaveBeenCalledOnce();
    expect(await h.service.respond(h.lease, {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval', optionId: 'allow' },
    })).toEqual({ status: 'stale_run' });
  });

  it('rolls back and closes native observation when revoke persistence fails', async () => {
    class FailingStore implements InteractionStateStore {
      state: PersistedInteractionState | null = null;
      fail = false;
      load(): unknown { return this.state; }
      save(state: PersistedInteractionState): void {
        if (this.fail) throw new Error('disk unavailable');
        this.state = structuredClone(state);
      }
    }
    const store = new FailingStore();
    const h = await runHarness(store);
    const { events } = await opened(h);
    store.fail = true;

    await h.controller.revoke(h.lease, 'provider_clear');

    await vi.waitFor(() => expect(h.adapter.close).toHaveBeenCalledOnce());
    expect(events).toEqual([]);
    expect(store.state?.interactions).toMatchObject([{
      sourceInteractionId: 'native-approval', state: 'pending',
    }]);
  });

  it('does not emit a second terminal event when revoke wins an in-flight response', async () => {
    const h = await runHarness();
    const { events, pending } = await opened(h);
    let release!: () => void;
    h.adapter.dispatch.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ status: 'accepted' });
    }));
    const responding = h.service.respond(h.lease, {
      interactionId: pending.id, resolutionToken: pending.resolutionToken,
      value: { type: 'approval', optionId: 'allow' },
    });
    await vi.waitFor(() => expect(h.adapter.dispatch).toHaveBeenCalledOnce());
    await h.controller.revoke(h.lease, 'provider_clear');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    release();
    expect(await responding).toEqual({ status: 'stale_run' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cancelled', reason: 'stale_run' });
  });
});
