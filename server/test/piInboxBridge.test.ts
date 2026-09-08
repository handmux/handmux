import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiBridgeClient } from '../connectors/pi/bridgeClient.js';
import { LocalAgentBridge } from '../src/agent-runtime/bridge.js';
import { MemoryBridgeStateStore } from '../src/agent-runtime/bridgeStore.js';
import { LocalAgentBridgeTransportServer } from '../src/agent-runtime/bridgeTransport.js';
import type { BridgeDurableReplay } from '../src/agent-runtime/bridgeTypes.js';
import { InboxService } from '../src/agent-runtime/inbox.js';
import { MemoryInboxStateStore } from '../src/agent-runtime/inboxStore.js';
import type { InboxStateStore, PersistedInboxState } from '../src/agent-runtime/inboxStore.js';
import type { InboxOrderedProjector } from '../src/agent-runtime/inboxTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';
import { PiInboxBridgeCoordinator } from '../src/agents/piInboxBridge.js';

const bridges: LocalAgentBridge[] = [];
const coordinators: PiInboxBridgeCoordinator[] = [];
const transports: LocalAgentBridgeTransportServer[] = [];
const clients: PiBridgeClient[] = [];
const tempDirectories: string[] = [];
const AUTH_TOKEN = 'test-pi-bridge-auth-token-that-is-at-least-32-bytes';

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  coordinators.splice(0).forEach((coordinator) => coordinator.close());
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function setup(options: { inboxStore?: InboxStateStore } = {}): Promise<{
  runtime: AgentRunRuntime;
  lease: AgentRunLease;
  inbox: InboxService;
  bridge: LocalAgentBridge;
  bridgeStore: MemoryBridgeStateStore;
  projector: InboxOrderedProjector;
}> {
  const runtime = new AgentRunRuntime({ newRunId: () => 'pi-run-1' });
  const lease = await runtime.controller('pi', async () => true).attach({
    paneId: '%1',
    attachmentId: 'pi-extension-1',
    sessionId: 'pi-session-1',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
  });
  const inbox = new InboxService({
    runs: runtime,
    adapterIds: ['pi'],
    ...(options.inboxStore ? { store: options.inboxStore } : {}),
    now: () => 10_000,
    newServiceEpoch: () => 'inbox-epoch',
    newNotificationId: () => 'terminal-notification-1',
  });
  const bridgeStore = new MemoryBridgeStateStore();
  const bridge = new LocalAgentBridge({
    runs: runtime,
    adapterIds: ['pi'],
    store: bridgeStore,
    retryDelayMs: 5,
  });
  bridges.push(bridge);
  return {
    runtime,
    lease,
    inbox,
    bridge,
    bridgeStore,
    projector: inbox.projectorFor('pi'),
  };
}

function coordinator(
  bridge: LocalAgentBridge,
  projector: InboxOrderedProjector,
): PiInboxBridgeCoordinator {
  const created = new PiInboxBridgeCoordinator({ host: bridge.hostFor('pi'), projector });
  coordinators.push(created);
  return created;
}

describe('Pi Inbox Bridge vertical binding', () => {
  it('replays a durable terminal event captured while the Handmux Server was fully offline', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-offline-inbox-'));
    tempDirectories.push(directory);
    const socketPath = path.join(directory, 'bridge.sock');
    const credentialFile = path.join(directory, 'credential.json');
    const stateFile = path.join(directory, 'pi-state.json');
    fs.writeFileSync(credentialFile, JSON.stringify({ version: 1, authToken: AUTH_TOKEN }), { mode: 0o600 });
    const candidate = {
      paneId: '%1', attachmentId: 'pi-extension-1', sessionId: 'pi-session-1',
      process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    };

    // Pi must durably accept callbacks even though no socket or Handmux process exists yet.
    const offline = new PiBridgeClient({ socketPath, credentialFile, stateFile, candidate });
    offline.publishDurable('inbox', 'offline-done-1', {
      kind: 'set', state: 'done', eventId: 'offline-done-1', message: 'Finished while offline',
    });
    offline.setSnapshot('inbox', {
      availability: 'ready',
      current: { state: 'done', eventId: 'offline-done-1', message: 'Finished while offline' },
    });
    offline.close();

    const runtime = new AgentRunRuntime({ newRunId: () => 'pi-run-offline-1' });
    const controller = runtime.controller('pi', async () => true);
    const inbox = new InboxService({
      runs: runtime, adapterIds: ['pi'], now: () => 10_000,
      newServiceEpoch: () => 'inbox-epoch-offline',
      newNotificationId: () => 'terminal-notification-offline-1',
    });
    const bridge = new LocalAgentBridge({
      runs: runtime, adapterIds: ['pi'], retryDelayMs: 5,
    });
    bridges.push(bridge);
    const binding = coordinator(bridge, inbox.projectorFor('pi'));
    binding.start();
    const transport = new LocalAgentBridgeTransportServer({
      socketPath,
      authToken: AUTH_TOKEN,
      bridge,
      authorize: (_agentId, attached) => controller.attach(attached),
      connected: (lease) => binding.bind(lease).then(() => undefined),
    });
    transports.push(transport);
    await transport.start();

    const live = new PiBridgeClient({
      socketPath, credentialFile, stateFile, candidate, retryDelayMs: 5, maxRetryDelayMs: 10,
    });
    clients.push(live);
    live.start();

    await vi.waitFor(() => expect(inbox.read()).toMatchObject({
      availability: { pi: { availability: 'ready' } },
      records: [{
        state: 'done', eventId: 'offline-done-1', acceptedAt: 10_000, inboxSequence: 1,
      }],
      terminalNotifications: [{
        id: 'terminal-notification-offline-1', eventId: 'offline-done-1',
      }],
    }));
    expect(inbox.read().terminalNotifications[0]).not.toHaveProperty('readAt');
    await vi.waitFor(() => expect(
      JSON.parse(fs.readFileSync(stateFile, 'utf8')).durable,
    ).toEqual([]));
  });

  it('accepts pre-baseline durable done before restoring the newer snapshot', async () => {
    const h = await setup();
    const channel = h.bridge.connect(h.lease).channel('inbox');
    await channel.publish({
      eventId: 'turn-1-done',
      payload: { kind: 'set', state: 'done', message: 'Finished offline' },
    }, { delivery: 'durable' });
    await channel.setSnapshot({
      availability: 'ready',
      current: { state: 'done', eventId: 'turn-1-done', message: 'Finished offline' },
    });

    const binding = coordinator(h.bridge, h.projector);
    binding.start();
    await binding.bind(h.lease);

    expect(h.inbox.read().records[0]).toMatchObject({
      state: 'done', eventId: 'turn-1-done', acceptedAt: 10_000, inboxSequence: 1,
    });
    expect(h.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ eventId: 'turn-1-done', acceptedAt: 10_000 }),
    ]);

    binding.close();
    await h.bridge.close();
    const restarted = new LocalAgentBridge({
      runs: h.runtime,
      adapterIds: ['pi'],
      store: h.bridgeStore,
      retryDelayMs: 5,
    });
    bridges.push(restarted);
    const replay = vi.fn(async (_event: BridgeDurableReplay) => 'accepted' as const);
    restarted.hostFor('pi').consumeDurableReplays('inbox', replay);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replay).not.toHaveBeenCalled();
  });

  it('acks a waiting replay as superseded when the ready snapshot has resumed work', async () => {
    const h = await setup();
    const channel = h.bridge.connect(h.lease).channel('inbox');
    await channel.publish({
      eventId: 'question-1',
      payload: { kind: 'set', state: 'waiting', message: 'Approve?' },
    }, { delivery: 'durable' });
    await channel.setSnapshot({
      availability: 'ready',
      current: { state: 'working', message: 'Approval already received' },
    });

    await coordinator(h.bridge, h.projector).bind(h.lease);
    expect(h.inbox.read().revision).toBe(1);
    expect(h.inbox.read().records[0]).toMatchObject({
      state: 'working', message: 'Approval already received',
    });
    expect(h.inbox.read().records[0]).not.toHaveProperty('acceptedAt');
    expect(h.inbox.read().terminalNotifications).toEqual([]);
  });

  it('buffers post-baseline live events until the durable restore barrier completes', async () => {
    const h = await setup();
    const channel = h.bridge.connect(h.lease).channel('inbox');
    await channel.setSnapshot({
      availability: 'ready', current: { state: 'working', message: 'Initial work' },
    });

    let restoreStarted!: () => void;
    const started = new Promise<void>((resolve) => { restoreStarted = resolve; });
    let releaseRestore!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const base = h.projector;
    const gated: InboxOrderedProjector = {
      forRun: (run) => base.forRun(run),
      submitTerminalReplay: (replay) => base.submitTerminalReplay(replay),
      restore: async (result) => {
        restoreStarted();
        await gate;
        return base.restore(result);
      },
    };
    const binding = coordinator(h.bridge, gated).bind(h.lease);
    await started;
    await channel.publish({
      eventId: 'turn-1-done',
      payload: { kind: 'set', state: 'done', eventId: 'turn-1-done', message: 'Live done' },
    });
    releaseRestore();
    await binding;

    expect(h.inbox.read().records[0]).toMatchObject({
      state: 'done', eventId: 'turn-1-done', message: 'Live done', inboxSequence: 1,
    });
    expect(h.inbox.read().terminalNotifications).toHaveLength(1);
  });

  it('routes revoked durable terminal outcomes to the canonical notification store only', async () => {
    const h = await setup();
    await h.bridge.connect(h.lease).channel('inbox').publish({
      eventId: 'offline-error-1',
      payload: { kind: 'set', state: 'error', reason: 'provider_failed' },
    }, { delivery: 'durable' });
    await h.runtime.revokePane('%1', 'process_exit');

    coordinator(h.bridge, h.projector).start();
    await vi.waitFor(() => expect(h.inbox.read().terminalNotifications).toHaveLength(1));
    expect(h.inbox.read().records).toEqual([]);
    expect(h.inbox.read().terminalNotifications[0]).toMatchObject({
      runId: 'pi-run-1', eventId: 'offline-error-1', state: 'error', reason: 'provider_failed',
    });
  });

  it('retries durable delivery after Inbox persistence recovers', async () => {
    class RecoveringStore implements InboxStateStore {
      state: PersistedInboxState | null = null;
      fail = true;
      load(): unknown { return this.state; }
      save(state: PersistedInboxState): void {
        if (this.fail) throw new Error('disk unavailable');
        this.state = structuredClone(state);
      }
    }
    const store = new RecoveringStore();
    const h = await setup({ inboxStore: store });
    const channel = h.bridge.connect(h.lease).channel('inbox');
    await channel.publish({
      eventId: 'turn-1-done', payload: { kind: 'set', state: 'done' },
    }, { delivery: 'durable' });
    await channel.setSnapshot({
      availability: 'ready', current: { state: 'done', eventId: 'turn-1-done' },
    });

    const binding = coordinator(h.bridge, h.projector).bind(h.lease);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.inbox.read().records).toEqual([]);
    store.fail = false;
    await binding;
    expect(h.inbox.read().records[0]).toMatchObject({
      state: 'done', eventId: 'turn-1-done', inboxSequence: 1,
    });
    expect(h.inbox.read().terminalNotifications).toHaveLength(1);
  });

  it('aggregates two bindings and recomputes the baseline after unavailable, updates, and close', async () => {
    let nextRun = 0;
    const runtime = new AgentRunRuntime({ newRunId: () => `pi-run-${++nextRun}` });
    const controller = runtime.controller('pi', async () => true);
    const first = await controller.attach({
      paneId: '%1', attachmentId: 'pi-extension-1', sessionId: 'pi-session-1',
      process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    });
    const second = await controller.attach({
      paneId: '%2', attachmentId: 'pi-extension-2', sessionId: 'pi-session-2',
      process: { pid: 202, startedAt: 2_000, tty: '/dev/ttys002' },
    });
    const inbox = new InboxService({ runs: runtime, adapterIds: ['pi'] });
    const bridge = new LocalAgentBridge({ runs: runtime, adapterIds: ['pi'], retryDelayMs: 5 });
    bridges.push(bridge);
    const firstChannel = bridge.connect(first).channel('inbox');
    const secondChannel = bridge.connect(second).channel('inbox');
    await firstChannel.setSnapshot({
      availability: 'ready', current: { state: 'working', message: 'first' },
    });
    const binding = coordinator(bridge, inbox.projectorFor('pi'));
    const firstBinding = await binding.bind(first);
    const secondBinding = await binding.bind(second);

    expect(inbox.read()).toMatchObject({
      availability: { pi: { availability: 'degraded' } },
      records: [expect.objectContaining({
        run: expect.objectContaining({ paneId: '%1' }), state: 'working', message: 'first',
      })],
    });

    await secondChannel.setSnapshot({
      availability: 'ready', current: { state: 'done', eventId: 'second-done', message: 'second' },
    });
    await vi.waitFor(() => expect(inbox.read().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%1' }), message: 'first' }),
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%2' }), message: 'second' }),
    ])));
    expect(inbox.read().records).toHaveLength(2);

    await firstChannel.setSnapshot({
      availability: 'ready', current: { state: 'working', message: 'first updated' },
    });
    await vi.waitFor(() => expect(inbox.read().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%1' }), message: 'first updated' }),
      expect.objectContaining({ run: expect.objectContaining({ paneId: '%2' }), message: 'second' }),
    ])));
    expect(inbox.read().records).toHaveLength(2);

    secondBinding.close();
    await vi.waitFor(() => expect(inbox.read()).toMatchObject({
      availability: { pi: { availability: 'ready' } },
      records: [expect.objectContaining({
        run: expect.objectContaining({ paneId: '%1' }), message: 'first updated',
      })],
    }));
    expect(inbox.read().records).toHaveLength(1);
    firstBinding.close();
  });

  it('cancels an in-flight durable barrier when the coordinator closes', async () => {
    class FailingStore implements InboxStateStore {
      load(): unknown { return null; }
      save(): void { throw new Error('disk unavailable'); }
    }
    const h = await setup({ inboxStore: new FailingStore() });
    const channel = h.bridge.connect(h.lease).channel('inbox');
    await channel.publish({
      eventId: 'turn-1-done', payload: { kind: 'set', state: 'done' },
    }, { delivery: 'durable' });
    await channel.setSnapshot({
      availability: 'ready', current: { state: 'done', eventId: 'turn-1-done' },
    });

    const binding = coordinator(h.bridge, h.projector);
    const pending = binding.bind(h.lease);
    const rejected = expect(pending).rejects.toThrow('Durable drain was cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    binding.close();
    await rejected;
  });
});
