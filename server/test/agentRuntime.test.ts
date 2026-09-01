import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AdapterLogger,
  ForegroundProcessIdentity,
  LivePane,
  ReadonlyPaneSource,
} from '../src/agent-runtime/adapter.js';
import type { AgentConversationAdapterV1 } from '../src/agent-runtime/conversationTypes.js';
import type { AgentInteractionAdapterV1 } from '../src/agent-runtime/interactionTypes.js';
import {
  createBuiltinAgentRuntime,
  createClaudeConversationActivityReader,
  createCodexConversationActivityReader,
} from '../src/agent-runtime/builtinRuntime.js';
import { connectBridgeTransport } from '../src/agent-runtime/bridgeTransport.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { AgentRuntime } from '../src/agent-runtime/runtime.js';
import type { AgentRuntimeAdapterFactory } from '../src/agent-runtime/runtime.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentAttachmentCandidate, AgentRunLease } from '../src/agent-runtime/run.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

const AUTH_TOKEN = 'runtime-test-auth-token-that-is-at-least-32-bytes';
const directories: string[] = [];
const runtimes: AgentRuntime[] = [];

class TestPanes implements ReadonlyPaneSource {
  snapshot: readonly LivePane[];
  readonly listeners = new Set<(snapshot: readonly LivePane[]) => void>();

  constructor(snapshot: readonly LivePane[]) { this.snapshot = snapshot; }

  async list(): Promise<readonly LivePane[]> { return structuredClone(this.snapshot); }

  subscribe(listener: (snapshot: readonly LivePane[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(snapshot: readonly LivePane[]): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }
}

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-agent-runtime-'));
  directories.push(value);
  return value;
}

function pane(command = 'pi'): LivePane {
  return {
    paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
    currentCommand: command, tty: '/dev/ttys001', foregroundPid: 101,
  };
}

function candidate(overrides: Partial<AgentAttachmentCandidate> = {}): AgentAttachmentCandidate {
  return {
    paneId: '%1', attachmentId: 'extension-1', sessionId: 'session-1',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    ...overrides,
  };
}

function adapter(id: string, capabilities: AgentAdapter['capabilities'] = {}): AgentAdapter {
  return {
    adapterApiVersion: 1,
    id,
    label: id,
    process: { commands: [id] },
    capabilities,
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inertConversation: AgentConversationAdapterV1 = {
  apiVersion: 1,
  discoverNative: async () => null,
  readNativePage: async () => { throw new Error('not used'); },
};

const inertInteraction: AgentInteractionAdapterV1 = {
  apiVersion: 1,
  observeNative: async () => { throw new Error('not used'); },
  dispatchResponse: async () => ({ status: 'accepted' }),
};

function runtimeWithAllStateFiles(stateDirectory: string, logger?: AdapterLogger): AgentRuntime {
  return new AgentRuntime({
    adapters: [adapter('pi', {
      conversation: { apiVersion: 1 }, interaction: { apiVersion: 1 },
    })],
    panes: new TestPanes([]),
    process: { inspectForeground: async () => null },
    stateDirectory,
    authToken: AUTH_TOKEN,
    ...(logger === undefined ? {} : { logger }),
    adapterFactories: {
      pi: () => ({ conversation: inertConversation, interaction: inertInteraction }),
    },
  });
}

describe('AgentRuntime composition root', () => {
  it('maps Claude and Codex terminal identities to provider completion tokens', async () => {
    const signal = new AbortController().signal;
    const claudeRun = {
      ref: {
        agentId: 'claude', paneId: '%1', runId: 'claude-run', sessionId: 'claude-session',
      },
      signal,
    };
    const claudeReader = createClaudeConversationActivityReader({
      paneKind: () => 'done',
      paneCompletionToken: () => 'claude-completed:1234',
    } as NonNullable<Parameters<typeof createClaudeConversationActivityReader>[0]>);
    await expect(claudeReader.read(claudeRun)).resolves.toEqual({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'claude-completed:1234',
    });

    const status = vi.fn(async () => ({
      managed: true,
      status: { type: 'idle' }, activeTurnId: null,
      lastTurn: { id: 'turn-7', status: 'completed' }, approvals: [], userInputs: [],
    }));
    const codexReader = createCodexConversationActivityReader({ status } as unknown as Parameters<
      typeof createCodexConversationActivityReader
    >[0]);
    await expect(codexReader.read({
      ref: { agentId: 'codex', paneId: '%2', runId: 'codex-run', sessionId: 'thread-1' },
      signal,
    })).resolves.toEqual({
      activity: 'idle', activeTurn: { state: 'none' },
      completionToken: 'codex-completed:turn-7:completed',
    });
  });

  it.each([
    ['unmanaged App Server', { managed: false, status: { type: 'idle' } }],
    ['missing native status', { managed: true }],
    ['unknown native status', { managed: true, status: { type: 'reconnecting' } }],
  ])('fails closed for %s activity', async (_name, raw) => {
    const reader = createCodexConversationActivityReader({
      status: vi.fn(async () => raw),
    } as unknown as Parameters<typeof createCodexConversationActivityReader>[0]);
    await expect(reader.read({
      ref: { agentId: 'codex', paneId: '%2', runId: 'codex-run', sessionId: 'thread-1' },
      signal: new AbortController().signal,
    })).resolves.toEqual({ activity: 'unknown', activeTurn: { state: 'unknown' } });
  });

  it('does not claim or dispatch a Codex Queue item while App Server is disconnected', async () => {
    const runs = new AgentRunRuntime({ newRunId: () => 'codex-run' });
    const lease = await runs.controller('codex', async () => true).attach({
      paneId: '%2', attachmentId: 'codex-app', sessionId: 'thread-1', process: { pid: 202 },
    });
    const status = vi.fn(async () => ({ managed: false }));
    const reader = createCodexConversationActivityReader({ status } as unknown as Parameters<
      typeof createCodexConversationActivityReader
    >[0]);
    const dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const conversation = new ConversationService({
      runs,
      adapters: { codex: {
        apiVersion: 1,
        discoverNative: async () => null,
        readNativePage: async () => { throw new Error('not used'); },
        dispatchPrompt,
      } },
      activitySource: { read: async (run) => {
        const snapshot = await reader.read(run);
        return {
          ...snapshot,
          activeTurn: snapshot.activeTurn ?? { state: 'unknown' },
          revision: 1,
          epoch: run.ref.runId,
        };
      } },
    });

    await expect(conversation.send(lease, {
      clientRequestId: 'request-1', text: 'wait for reconnect', delivery: 'prompt',
    })).resolves.toMatchObject({ status: 'queued', submission: { state: 'queued' } });
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it('fences only Codex dispatch when legacy migration is blocked', async () => {
    const ids = ['codex', 'pi', 'claude'] as const;
    const statics = ids.map((id) => {
      const value = adapter(id, { conversation: { apiVersion: 1 } });
      return value;
    });
    const dispatch = Object.fromEntries(ids.map((id) => [id, vi.fn(async () => ({
      outcome: 'accepted' as const,
    }))])) as Record<(typeof ids)[number], ReturnType<typeof vi.fn>>;
    const interrupt = vi.fn(async () => ({ status: 'accepted' as const }));
    const factories = Object.fromEntries(ids.map((id) => [id, () => ({
      conversation: {
        apiVersion: 1 as const,
        discoverNative: async (target: { sessionId?: string; runId?: string }) => ({
          session: { agentId: id, sessionId: target.sessionId! },
          ...('runId' in target ? { run: target } : {}), sourceViewId: `${id}-view`,
          capabilities: {
            history: true as const, live: 'delta' as const,
            ...('runId' in target ? { sendable: true as const } : {}),
          },
        }),
        readNativePage: async (session: { sessionId: string }) => ({
          sessionId: session.sessionId, sourceViewId: `${id}-view`,
          sourceHistoryToken: `${id}-history`, items: [], hasMore: false,
        }),
        observeNative: async () => ({
          checkpoint: { sourceViewId: `${id}-view`, sourceSequence: 0 }, close() {},
        }),
        dispatchPrompt: dispatch[id],
        ...(id === 'codex' ? { dispatchInterrupt: interrupt } : {}),
      },
      conversationActivity: { read: async () => ({
        activity: 'idle' as const, activeTurn: { state: 'none' as const },
      }) },
    })])) as unknown as Record<string, AgentRuntimeAdapterFactory>;
    const livePanes = ids.map((id, index) => ({
      ...pane(id), paneId: `%${index + 1}`, windowId: `@${index + 1}`,
      tty: `/dev/ttys00${index + 1}`, foregroundPid: 101 + index,
    }));
    const runtime = new AgentRuntime({
      adapters: statics, panes: new TestPanes(livePanes),
      process: { inspectForeground: async (value) => ({
        pid: value.foregroundPid!,
        ...(value.tty === undefined ? {} : { tty: value.tty }),
        executable: `/opt/${value.currentCommand}`,
      }) },
      stateDirectory: directory(), authToken: AUTH_TOKEN,
      adapterFactories: factories,
      conversationStartupBlockReason: 'legacy Codex migration conflict',
    });
    runtimes.push(runtime);
    const leases = Object.fromEntries(await Promise.all(ids.map(async (id, index) => [
      id,
      await runtime.runControlFor(id).attach(candidate({
        paneId: `%${index + 1}`, attachmentId: `${id}-attachment`, sessionId: `${id}-session`,
        process: { pid: 101 + index, tty: `/dev/ttys00${index + 1}` },
      })),
    ]))) as Record<(typeof ids)[number], AgentRunLease>;

    expect(runtime.conversation).not.toBeNull();
    await expect(runtime.conversation!.readPage(
      { agentId: 'codex', sessionId: 'codex-session' }, { limit: 20 },
    )).resolves.toMatchObject({ status: 'ok' });
    const live = await runtime.conversation!.open(leases.codex, {}, () => {});
    live.close();
    await expect(runtime.conversation!.interrupt(leases.codex))
      .resolves.toEqual({ status: 'accepted' });
    await expect(runtime.conversation!.send(leases.codex, {
      clientRequestId: 'codex-request', text: 'must stay fenced', delivery: 'prompt',
    })).resolves.toEqual({
      status: 'rejected', reason: 'temporarily_unavailable', nativeMutation: false,
    });
    await expect(runtime.conversation!.queueAction(leases.codex, {
      action: 'remove', itemId: 'legacy-item',
    })).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(dispatch.codex).not.toHaveBeenCalled();

    for (const id of ['pi', 'claude'] as const) {
      await expect(runtime.conversation!.send(leases[id], {
        clientRequestId: `${id}-request`, text: `${id} still sends`, delivery: 'prompt',
      })).resolves.toMatchObject({ status: 'accepted' });
      expect(dispatch[id]).toHaveBeenCalledOnce();
    }
    expect(runtime.capabilities().every((entry) => entry.capabilities.conversation)).toBe(true);
  });

  it.each([
    ['bridge-state.json', 'bridge'],
    ['inbox-state.json', 'inbox'],
    ['conversation-state.json', 'conversation'],
    ['interaction-state.json', 'interaction'],
  ] as const)('quarantines malformed %s and starts with empty %s state', async (fileName, kind) => {
    const stateDirectory = directory();
    const file = path.join(stateDirectory, fileName);
    fs.writeFileSync(file, 'not json');
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } satisfies AdapterLogger;

    const runtime = runtimeWithAllStateFiles(stateDirectory, logger);
    runtimes.push(runtime);
    await runtime.start();

    const quarantined = fs.readdirSync(stateDirectory)
      .filter((name) => name.startsWith(`${fileName}.corrupt.`));
    if (kind === 'conversation') {
      expect(quarantined).toHaveLength(0);
      expect(fs.readFileSync(file, 'utf8')).toBe('not json');
      expect(runtime.conversation).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Conversation state is invalid; dispatch is disabled',
        expect.objectContaining({ kind, file }),
      );
      return;
    }
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(stateDirectory, quarantined[0]!), 'utf8')).toBe('not json');
    expect(fs.existsSync(file)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Corrupt Agent Runtime state was quarantined',
      expect.objectContaining({ kind, file }),
    );
  });

  it.each([
    ['bridge-state.json', 'bridge'],
    ['inbox-state.json', 'inbox'],
    ['conversation-state.json', 'conversation'],
    ['interaction-state.json', 'interaction'],
  ] as const)('quarantines schema-invalid %s and starts with empty %s state', async (fileName, kind) => {
    const stateDirectory = directory();
    const file = path.join(stateDirectory, fileName);
    fs.writeFileSync(file, '{"version":999}');
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } satisfies AdapterLogger;

    const runtime = runtimeWithAllStateFiles(stateDirectory, logger);
    runtimes.push(runtime);
    await runtime.start();

    const quarantined = fs.readdirSync(stateDirectory)
      .filter((name) => name.startsWith(`${fileName}.corrupt.`));
    if (kind === 'conversation') {
      expect(quarantined).toHaveLength(0);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"version":999}');
      expect(runtime.conversation).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Conversation state is invalid; dispatch is disabled',
        expect.objectContaining({ kind, file }),
      );
      return;
    }
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(stateDirectory, quarantined[0]!), 'utf8'))
      .toBe('{"version":999}');
    expect(fs.existsSync(file)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Corrupt Agent Runtime state was quarantined',
      expect.objectContaining({ kind, file }),
    );
  });

  it('keeps a malformed v2 Conversation ledger in place and disables dispatch', async () => {
    const stateDirectory = directory();
    const file = path.join(stateDirectory, 'conversation-state.json');
    const raw = JSON.stringify({
      version: 2, ledgerRevision: 0, cycles: [], legacySends: [],
      submissions: [{
        agentId: 'pi', sessionId: 'session-1', clientRequestId: 'request-1', text: 'hello',
        payloadHash: '0'.repeat(64), state: 'queued', revision: 1,
        queueOrderKey: '0000000000000001:0000000000000001', createdAt: 1, updatedAt: 1,
      }],
    });
    fs.writeFileSync(file, raw);
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } satisfies AdapterLogger;

    const runtime = runtimeWithAllStateFiles(stateDirectory, logger);
    runtimes.push(runtime);
    await runtime.start();

    expect(runtime.conversation).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(fs.readdirSync(stateDirectory)
      .filter((name) => name.startsWith('conversation-state.json.corrupt.'))).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Conversation state is invalid; dispatch is disabled',
      expect.objectContaining({ kind: 'conversation', file }),
    );
  });

  it.each(['EACCES', 'EIO'])('does not quarantine, retry, or swallow %s state read failures', (code) => {
    const failure = Object.assign(new Error('state read failed'), { code });
    const readStrict = vi.spyOn(PrivateStateStore.prototype, 'readStrict')
      .mockImplementation(function mockedReadStrict(this: PrivateStateStore<unknown>) {
        if (this.file.endsWith('bridge-state.json')) throw failure;
        return null;
      });
    const quarantine = vi.spyOn(PrivateStateStore.prototype, 'quarantine');

    expect(() => runtimeWithAllStateFiles(directory())).toThrow(failure);
    expect(readStrict).toHaveBeenCalledTimes(1);
    expect(quarantine).not.toHaveBeenCalled();
  });

  it('recovers corrupt state even when diagnostic logging fails', async () => {
    const stateDirectory = directory();
    fs.writeFileSync(path.join(stateDirectory, 'bridge-state.json'), 'not json');
    const logger: AdapterLogger = {
      debug: () => {},
      info: () => {},
      warn: () => { throw new Error('logger unavailable'); },
      error: () => {},
    };

    const runtime = runtimeWithAllStateFiles(stateDirectory, logger);
    runtimes.push(runtime);
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(fs.readdirSync(stateDirectory)
      .filter((name) => name.startsWith('bridge-state.json.corrupt.'))).toHaveLength(1);
  });

  it('owns one verified run, private transport, lifecycle, and persisted credential', async () => {
    const stateDirectory = directory();
    const panes = new TestPanes([pane()]);
    const process = vi.fn(async (): Promise<ForegroundProcessIdentity> => ({
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
    }));
    const start = vi.fn(() => vi.fn());
    const connected = vi.fn();
    const runtime = new AgentRuntime({
      adapters: [adapter('pi', { inbox: { apiVersion: 1 } })],
      panes,
      process: { inspectForeground: process },
      stateDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'run-1',
      newBridgeConnectionId: () => 'connection-1',
      adapterFactories: { pi: () => ({ inbox: true, start, onBridgeConnected: connected }) },
    });
    runtimes.push(runtime);
    await runtime.start();

    const client = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: runtime.bridgeAuthToken,
      adapterId: 'pi',
      candidate: candidate(),
    });
    expect(client.run).toEqual({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    });
    expect(connected).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalled();
    expect(fs.statSync(runtime.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(stateDirectory, 'bridge-credential.json')).mode & 0o777).toBe(0o600);
    expect(runtime.capabilities()[0]?.capabilities.inbox).toBe(true);

    const lease = runtime.runs.resolve(client.run)!;
    await runtime.close();
    await vi.waitFor(() => expect(client.signal.aborted).toBe(true));
    expect(lease.signal.reason).toBe('runtime_shutdown');
    expect(start.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(panes.listeners.size).toBe(0);

    const restarted = new AgentRuntime({
      adapters: [adapter('pi')], panes, process: { inspectForeground: process }, stateDirectory,
    });
    runtimes.push(restarted);
    expect(restarted.bridgeAuthToken).toBe(AUTH_TOKEN);
  });

  it('rolls back a transport start failure and retries without double-starting adapters', async () => {
    const stateDirectory = directory();
    const socketDirectory = path.join(stateDirectory, 'shared');
    fs.mkdirSync(socketDirectory, { mode: 0o755 });
    const panes = new TestPanes([]);
    const activateCleanup = vi.fn();
    const activate = vi.fn(async () => activateCleanup);
    const bindingCleanup = vi.fn();
    const bindingStart = vi.fn(async () => bindingCleanup);
    const runtime = new AgentRuntime({
      adapters: [{ ...adapter('pi'), activate }],
      panes,
      process: { inspectForeground: async () => null },
      stateDirectory,
      socketPath: path.join(socketDirectory, 'agent.sock'),
      authToken: AUTH_TOKEN,
      adapterFactories: { pi: () => ({ start: bindingStart }) },
    });
    runtimes.push(runtime);

    await expect(runtime.start()).rejects.toThrow(/private directory/i);
    expect(activate).not.toHaveBeenCalled();
    expect(bindingStart).not.toHaveBeenCalled();
    expect(panes.listeners.size).toBe(0);
    expect(runtime.health()).toContainEqual(expect.objectContaining({
      adapterId: 'pi', availability: 'unavailable', message: expect.stringMatching(/private directory/i),
    }));

    fs.chmodSync(socketDirectory, 0o700);
    await expect(Promise.all([runtime.start(), runtime.start()])).resolves.toEqual([undefined, undefined]);
    expect(activate).toHaveBeenCalledOnce();
    expect(bindingStart).toHaveBeenCalledOnce();
    expect(panes.listeners.size).toBe(1);
    expect(runtime.health()).toContainEqual(expect.objectContaining({
      adapterId: 'pi', availability: 'ready',
    }));

    await runtime.close();
    expect(activateCleanup).toHaveBeenCalledOnce();
    expect(bindingCleanup).toHaveBeenCalledOnce();
  });

  it('waits for Interaction cancellation and native close during Runtime shutdown', async () => {
    const panes = new TestPanes([pane()]);
    let releaseNativeClose!: () => void;
    const nativeClose = vi.fn(() => new Promise<void>((resolve) => { releaseNativeClose = resolve; }));
    const runtime = new AgentRuntime({
      adapters: [adapter('pi', { interaction: { apiVersion: 1 } })],
      panes,
      process: { inspectForeground: async () => ({
        pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => 'interaction-run',
      adapterFactories: {
        pi: () => ({
          interaction: {
            apiVersion: 1,
            observeNative: async () => ({
              checkpoint: {
                sourceCursor: 'cursor-1',
                pending: [{ id: 'approval-1', type: 'text', prompt: 'Value?' }],
              },
              close: nativeClose,
            }),
            dispatchResponse: async () => ({ status: 'accepted' }),
          },
        }),
      },
    });
    runtimes.push(runtime);
    await runtime.start();
    const lease = await runtime.runControlFor('pi').attach(candidate());
    const events: Array<{ type: string; reason?: string }> = [];
    const handle = await runtime.interaction!.open(lease, (event) => { events.push(event); });
    let closed = false;

    const closing = runtime.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(nativeClose).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(events).toEqual([expect.objectContaining({ type: 'cancelled', reason: 'stale_run' })]);

    releaseNativeClose();
    await closing;
    await handle.closed;
    expect(closed).toBe(true);
  });

  it('fails closed on process mismatch and revokes a run when its pane identity changes', async () => {
    const panes = new TestPanes([pane()]);
    let foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
    };
    const runtime = new AgentRuntime({
      adapters: [adapter('pi')],
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => 'run-1',
    });
    runtimes.push(runtime);
    await runtime.start();
    await expect(connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: candidate({ process: { pid: 999, startedAt: 1_000, tty: '/dev/ttys001' } }),
    })).rejects.toThrow(/closed during handshake/i);

    const client = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: candidate(),
    });
    foreground = { ...foreground, pid: 202, startedAt: 2_000 };
    panes.emit([{ ...pane(), foregroundPid: 202 }]);
    await vi.waitFor(() => expect(client.signal.aborted).toBe(true));
    expect(runtime.runs.status(client.run)).toBe('revoked');
  });

  it('uses the canonical resolver for pane identity and fails closed on ambiguous conflicts', async () => {
    const first = {
      ...adapter('first'),
      process: { commands: ['first'], ambiguousCommands: ['node'], verify: vi.fn(async () => true) },
    };
    const second = {
      ...adapter('second'),
      process: { commands: ['second'], ambiguousCommands: ['node'], verify: vi.fn(async () => true) },
    };
    const runtime = new AgentRuntime({
      adapters: [first, second],
      panes: new TestPanes([]),
      process: { inspectForeground: async () => ({
        pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/wrapper/node',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
    });
    runtimes.push(runtime);
    await expect(runtime.identifyPanes([
      pane('first'),
      { ...pane('node'), paneId: '%2' },
      { ...pane('zsh'), paneId: '%3' },
    ])).resolves.toEqual({ '%1': 'first', '%2': null, '%3': null });
    expect(first.process.verify).toHaveBeenCalledOnce();
    expect(second.process.verify).toHaveBeenCalledOnce();
  });

  it('preserves a live run across an unknown process probe and revokes only on confirmed mismatch', async () => {
    const panes = new TestPanes([pane()]);
    let foreground: ForegroundProcessIdentity | Error | null = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
    };
    const inspectForeground = vi.fn(async () => {
      if (foreground instanceof Error) throw foreground;
      return foreground;
    });
    const runtime = new AgentRuntime({
      adapters: [adapter('pi')],
      panes,
      process: { inspectForeground },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => 'run-probe',
    });
    runtimes.push(runtime);
    await runtime.start();
    const client = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: candidate(),
    });

    foreground = new Error('temporary ps failure');
    panes.emit([pane()]);
    await vi.waitFor(() => expect(inspectForeground).toHaveBeenCalledTimes(2));
    expect(client.signal.aborted).toBe(false);
    expect(runtime.runs.status(client.run)).toBe('current');

    foreground = null;
    panes.emit([pane()]);
    await vi.waitFor(() => expect(inspectForeground).toHaveBeenCalledTimes(3));
    expect(client.signal.aborted).toBe(false);
    expect(runtime.runs.status(client.run)).toBe('current');

    foreground = { pid: 202, startedAt: 2_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi' };
    panes.emit([{ ...pane(), foregroundPid: 202 }]);
    await vi.waitFor(() => expect(client.signal.aborted).toBe(true));
    expect(runtime.runs.status(client.run)).toBe('revoked');
  });

  it('isolates one adapter activation failure without disabling another adapter', async () => {
    const broken = { ...adapter('broken'), activate: vi.fn(async () => { throw new Error('boom'); }) };
    const healthy = adapter('healthy', { inbox: { apiVersion: 1 } });
    const panes = new TestPanes([pane('healthy')]);
    const runtime = new AgentRuntime({
      adapters: [broken, healthy],
      panes,
      process: { inspectForeground: async () => ({
        pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/healthy',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => 'healthy-run',
      adapterFactories: {
        healthy: () => ({
          inbox: true,
          start: () => { throw new Error('inbox boom'); },
        }),
      },
    });
    runtimes.push(runtime);
    await runtime.start();
    expect(runtime.health()).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapterId: 'broken', availability: 'unavailable', message: 'boom' }),
      expect.objectContaining({ adapterId: 'healthy', availability: 'ready' }),
      expect.objectContaining({
        adapterId: 'healthy', capability: 'inbox', availability: 'unavailable', message: 'inbox boom',
      }),
    ]));
    await expect(runtime.runControlFor('healthy').attach(candidate())).resolves.toMatchObject({
      ref: { agentId: 'healthy', runId: 'healthy-run' },
    });
    await expect(runtime.runControlFor('broken').attach(candidate()))
      .rejects.toMatchObject({ code: 'runtime-unavailable' });
  });

  it('wires proven Pi Inbox and Conversation capabilities without an external plugin loader', async () => {
    const panes = new TestPanes([pane()]);
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => ({
        pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => 'pi-run',
      newBridgeConnectionId: () => 'pi-connection',
    });
    runtimes.push(runtime);
    expect(runtime.capabilities().find((value) => value.id === 'pi')).toMatchObject({
      iconId: 'pi',
      capabilities: { inbox: true, conversation: true, interaction: false, subscriptionUsage: false },
      capabilityMetadata: { conversation: { experimental: true } },
    });
    expect(runtime.capabilities().some((value) => (
      Object.hasOwn(value.capabilities, 'conversationQueue')
    ))).toBe(false);
    expect(runtime.capabilities().find((value) => value.id === 'claude')).toMatchObject({
      capabilities: { inbox: true, conversation: true, interaction: false, subscriptionUsage: true },
    });
    await runtime.start();
    const client = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: candidate(),
    });
    await client.channel('inbox').setSnapshot({ availability: 'ready' });
    await vi.waitFor(() => expect(runtime.inbox.read().availability.pi).toEqual({ availability: 'ready' }));
    client.close();
  });

  it('does not advertise an invalid Subscription Usage binding', () => {
    const declared = adapter('usage-agent');
    declared.capabilities.subscriptionUsage = { apiVersion: 1 };
    const runtime = new AgentRuntime({
      adapters: [declared], panes: new TestPanes([]),
      process: { inspectForeground: async () => null },
      stateDirectory: directory(), authToken: AUTH_TOKEN,
      adapterFactories: {
        'usage-agent': () => ({ subscriptionUsage: { apiVersion: 1 } as never }),
      },
    });
    runtimes.push(runtime);
    expect(runtime.capabilities()[0]?.capabilities.subscriptionUsage).toBe(false);
    expect(runtime.health()).toContainEqual(expect.objectContaining({
      adapterId: 'usage-agent', capability: 'subscriptionUsage', availability: 'unavailable',
    }));
  });

  it('does not advertise an invalid Conversation Permission binding', () => {
    const declared = adapter('permission-agent');
    declared.capabilities.conversationPermission = { apiVersion: 1 };
    const runtime = new AgentRuntime({
      adapters: [declared], panes: new TestPanes([]),
      process: { inspectForeground: async () => null },
      stateDirectory: directory(), authToken: AUTH_TOKEN,
      adapterFactories: {
        'permission-agent': () => ({ conversationPermission: { apiVersion: 1 } as never }),
      },
    });
    runtimes.push(runtime);
    expect(runtime.capabilities()[0]?.capabilities.conversationPermission).toBe(false);
    expect(runtime.health()).toContainEqual(expect.objectContaining({
      adapterId: 'permission-agent', capability: 'conversationPermission', availability: 'unavailable',
    }));
  });

  it('publishes a read-only Session Control binding without reporting it unavailable', async () => {
    const declared = adapter('read-only-agent', { sessionControl: { apiVersion: 1 } });
    const runtime = new AgentRuntime({
      adapters: [declared], panes: new TestPanes([]),
      process: { inspectForeground: async () => null },
      stateDirectory: directory(), authToken: AUTH_TOKEN,
      adapterFactories: {
        'read-only-agent': () => ({
          sessionControl: {
            apiVersion: 1,
            readModelControl: async () => ({
              models: [{ id: 'model', label: 'Model', efforts: [] }],
              selected: { model: 'model', effort: null },
            }),
          },
        }),
      },
    });
    runtimes.push(runtime);
    expect(runtime.capabilities()[0]?.capabilities.sessionControl).toBe(true);
    expect(runtime.health()).not.toContainEqual(expect.objectContaining({
      adapterId: 'read-only-agent', capability: 'sessionControl', availability: 'unavailable',
    }));
    await expect(runtime.sessionControl?.readModelControl({
      ref: { agentId: 'read-only-agent', paneId: '%1', runId: 'run-1' },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ canUpdate: false, selected: { model: 'model' } });
  });

  it('statically wires Claude and managed Codex Inbox sources when native dependencies exist', () => {
    const panes = new TestPanes([]);
    const claudeEvents = {
      getStates: vi.fn(async () => ({})),
      paneSession: vi.fn(() => null),
    };
    const codexApp = {
      discover: vi.fn(async () => ({ managed: false, threadId: null })),
      inboxStates: vi.fn(async () => ({})),
      observeConversation: vi.fn(),
      observeInteractions: vi.fn(),
      decide: vi.fn(),
      answerInput: vi.fn(),
      send: vi.fn(),
      interrupt: vi.fn(),
    };
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => null },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      claudeEvents,
      codexApp: codexApp as unknown as NonNullable<Parameters<typeof createBuiltinAgentRuntime>[0]['codexApp']>,
    });
    runtimes.push(runtime);
    expect(runtime.capabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude', capabilities: expect.objectContaining({
          inbox: true, conversation: true, interaction: false,
          sessionControl: false, subscriptionUsage: true,
        }), capabilityMetadata: { conversation: { experimental: true } },
      }),
      expect.objectContaining({
        id: 'codex', capabilities: expect.objectContaining({
          inbox: true, conversation: true, interaction: true,
          sessionControl: false, subscriptionUsage: true,
        }), capabilityMetadata: { conversation: { experimental: false } },
      }),
    ]));
  });

  it('projects managed Codex native Inbox transitions while Claude waits for its Bridge Connector', async () => {
    const panes = new TestPanes([
      pane('claude'),
      {
        ...pane('codex'), paneId: '%2', windowId: '@2', tty: '/dev/ttys002', foregroundPid: 202,
      },
    ]);
    let codexKind: 'working' | 'done' = 'working';
    const claudeEvents = {
      paneSession: vi.fn(() => ({
        sessionId: 'claude-session', transcriptPath: null, agent: 'claude',
      })),
    };
    const codexApp = {
      discover: vi.fn(async () => ({ managed: true, threadId: 'codex-thread' })),
      inboxStates: vi.fn(async () => ({
        '%2': { kind: codexKind, msg: codexKind, ts: codexKind === 'working' ? 10 : 20, threadId: 'codex-thread' },
      })),
      observeConversation: vi.fn(),
      observeInteractions: vi.fn(),
      decide: vi.fn(),
      answerInput: vi.fn(),
      send: vi.fn(),
      interrupt: vi.fn(),
    };
    let run = 0;
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async (value) => ({
        pid: value.paneId === '%1' ? 101 : 202,
        startedAt: value.paneId === '%1' ? 1_000 : 2_000,
        ...(value.tty === undefined ? {} : { tty: value.tty }),
        executable: value.paneId === '%1' ? '/opt/claude/bin/claude' : '/opt/codex/bin/codex',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => `native-run-${++run}`,
      claudeEvents,
      codexApp: codexApp as unknown as NonNullable<Parameters<typeof createBuiltinAgentRuntime>[0]['codexApp']>,
    });
    runtimes.push(runtime);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: expect.objectContaining({ agentId: 'codex', sessionId: 'codex-thread' }), state: 'working' }),
    ])), { timeout: 2_000 });
    expect(runtime.activeRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'codex', paneId: '%2', sessionId: 'codex-thread' }),
    ]));
    expect(runtime.activeRuns()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'claude' }),
    ]));

    codexKind = 'done';
    await vi.waitFor(() => expect(runtime.inbox.read().terminalNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'codex', state: 'done' }),
    ])), { timeout: 2_000 });
  });

  it('replaces a Pi run once for an idempotent native session generation', async () => {
    const panes = new TestPanes([pane()]);
    let run = 0;
    const runtime = new AgentRuntime({
      adapters: [adapter('pi')],
      panes,
      process: { inspectForeground: async () => ({
        pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi',
      }) },
      stateDirectory: directory(),
      authToken: AUTH_TOKEN,
      newRunId: () => `run-${++run}`,
    });
    runtimes.push(runtime);
    await runtime.start();
    const first = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: candidate(),
    });
    const firstLease = runtime.runs.resolve(first.run)!;
    const replacementCandidate = candidate({ sessionId: 'session-2' });
    const second = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: replacementCandidate,
      generation: { id: 'pi-generation-2', replace: true },
    });
    expect(second.run.runId).toBe('run-2');
    expect(firstLease.signal.reason).toBe('session_replaced');

    const retry = await connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: replacementCandidate,
      generation: { id: 'pi-generation-2', replace: true },
    });
    expect(retry.run.runId).toBe('run-2');
    await vi.waitFor(() => expect(second.signal.aborted).toBe(true));
    const thirdCandidate = candidate({ sessionId: 'session-3' });
    const parallel = await Promise.all([1, 2].map(() => connectBridgeTransport({
      socketPath: runtime.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: thirdCandidate,
      generation: { id: 'pi-generation-3', replace: true },
    })));
    expect(parallel.map((connection) => connection.run.runId)).toEqual(['run-3', 'run-3']);
    expect(run).toBe(3);
    parallel.forEach((connection) => connection.close());
    retry.close();
  });
});
