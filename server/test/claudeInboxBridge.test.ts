import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHookBridgeConnector } from '../connectors/claude/index.js';
import { LocalConnectorBridgeClient } from '../connectors/bridgeClient.js';
import type { ForegroundProcessIdentity, LivePane, ReadonlyPaneSource } from '../src/agent-runtime/adapter.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import type { AgentRuntime } from '../src/agent-runtime/runtime.js';

const AUTH_TOKEN = 'claude-bridge-auth-token-that-is-at-least-32-bytes';
const directories: string[] = [];
const runtimes: AgentRuntime[] = [];
const connectors: ClaudeHookBridgeConnector[] = [];

class TestPanes implements ReadonlyPaneSource {
  readonly panes: readonly LivePane[];
  constructor(panes: LivePane | readonly LivePane[]) {
    this.panes = Array.isArray(panes) ? panes : [panes as LivePane];
  }
  async list(): Promise<readonly LivePane[]> { return structuredClone(this.panes); }
  subscribe(): () => void { return () => {}; }
}

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-claude-bridge-'));
  directories.push(value);
  return value;
}

function writeEvent({
  eventDirectory,
  sequence,
  sessionId,
  src,
  payload,
  sourceProcess,
}: {
  eventDirectory: string;
  sequence: number;
  sessionId: string;
  src: string;
  payload: Record<string, unknown>;
  sourceProcess?: { pid: number; startedAt: number; tty: string };
}): void {
  fs.mkdirSync(eventDirectory, { recursive: true });
  fs.writeFileSync(path.join(
    eventDirectory,
    `event-${String(sequence).padStart(16, '0')}-100.json`,
  ), JSON.stringify({
    version: 1,
    type: 'event',
    eventId: `claude-hook-${sequence}`,
    sequence,
    paneId: '%1',
    src,
    sessionId,
    sourceOccurredAt: sequence * 10,
    ...(sourceProcess === undefined ? {} : { process: sourceProcess }),
    payload: { ...payload, session_id: sessionId },
  }));
}

function writeGap({
  eventDirectory,
  sessionId,
  paneId = '%1',
  eventId = 'claude-gap-test',
  marker = 'deadbeefdeadbeef',
  sourceProcess,
}: {
  eventDirectory: string;
  sessionId: string;
  paneId?: string;
  eventId?: string;
  marker?: string;
  sourceProcess?: { pid: number; startedAt: number; tty: string };
}): string {
  fs.mkdirSync(eventDirectory, { recursive: true });
  const file = path.join(eventDirectory, `gap-${marker}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    type: 'gap',
    eventId,
    paneId,
    sessionId,
    ...(sourceProcess === undefined ? {} : { process: sourceProcess }),
  }));
  return file;
}

function writeState(
  hookStateFile: string,
  sequence: number,
  sessionId: string,
  src: string,
  payload: Record<string, unknown>,
  sourceProcess?: { pid: number; startedAt: number; tty: string },
): void {
  fs.writeFileSync(hookStateFile, JSON.stringify({
    '%1': {
      ts: sequence * 10,
      src,
      sequence,
      ...(sourceProcess === undefined ? {} : { process: sourceProcess }),
      payload: { ...payload, session_id: sessionId },
    },
  }));
}

describe('Claude Hook → LocalAgentBridge → Inbox vertical slice', () => {
  it('attaches a neutral live Claude pane before its first Hook event', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'neutral-claude-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile: path.join(directory, 'claude-state.json'),
      eventDirectory: path.join(directory, 'claude-state.json.events'),
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      { agentId: 'claude', paneId: '%1', runId: 'neutral-claude-run' },
    ]));
    await vi.waitFor(() => expect(runtime.inbox.read().availability.claude).toEqual({
      availability: 'ready',
    }));
    expect(runtime.inbox.read().records).toEqual([]);
  });

  it('keeps both Claude pane baselines when their Bridge bindings arrive independently', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const panes = new TestPanes([
      {
        paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude-1',
        currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
      },
      {
        paneId: '%2', sessionName: 'main', windowId: '@2', windowName: 'claude-2',
        currentCommand: 'claude', tty: '/dev/ttys002', foregroundPid: 202,
      },
    ]);
    const foreground = (paneId: string): ForegroundProcessIdentity => paneId === '%1'
      ? { pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude' }
      : { pid: 202, startedAt: 2_000, tty: '/dev/ttys002', executable: '/opt/claude/bin/claude' };
    fs.writeFileSync(hookStateFile, JSON.stringify({
      '%1': {
        ts: 10, src: 'prompt', sequence: 1,
        process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
        payload: { session_id: 'claude-session-1', prompt: 'first task' },
      },
      '%2': {
        ts: 20, src: 'stop', sequence: 2,
        process: { pid: 202, startedAt: 2_000, tty: '/dev/ttys002' },
        payload: { session_id: 'claude-session-2', last_assistant_message: 'second finished' },
      },
    }));
    let nextRun = 0;
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async (pane) => foreground(pane.paneId) },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => `claude-run-${++nextRun}`,
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory: `${hookStateFile}.events`,
      panes,
      process: { inspectForeground: async (pane) => foreground(pane.paneId) },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        run: expect.objectContaining({ paneId: '%1', sessionId: 'claude-session-1' }),
        state: 'working', message: 'first task',
      }),
      expect.objectContaining({
        run: expect.objectContaining({ paneId: '%2', sessionId: 'claude-session-2' }),
        state: 'done', message: 'second finished',
      }),
    ])), { timeout: 2_000 });
    expect(runtime.inbox.read().records).toHaveLength(2);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);

    fs.writeFileSync(hookStateFile, JSON.stringify({
      '%1': {
        ts: 30, src: 'prompt', sequence: 3,
        process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
        payload: { session_id: 'claude-session-1', prompt: 'first task updated' },
      },
      '%2': {
        ts: 20, src: 'stop', sequence: 2,
        process: { pid: 202, startedAt: 2_000, tty: '/dev/ttys002' },
        payload: { session_id: 'claude-session-2', last_assistant_message: 'second finished' },
      },
    }));
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        run: expect.objectContaining({ paneId: '%1' }),
        state: 'working', message: 'first task updated',
      }),
      expect.objectContaining({
        run: expect.objectContaining({ paneId: '%2' }),
        state: 'done', message: 'second finished',
      }),
    ])));
    expect(runtime.inbox.read().records).toHaveLength(2);
  });

  it('ignores a legacy Codex row that remains in the shared Hook state file', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    fs.writeFileSync(hookStateFile, JSON.stringify({
      '%1': {
        ts: 10,
        src: 'stop',
        agent: 'codex',
        bindingVersion: 2,
        payload: {
          session_id: 'old-codex-thread',
          last_assistant_message: 'must not become a Claude terminal result',
        },
      },
    }));

    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'neutral-claude-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory: `${hookStateFile}.events`,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      { agentId: 'claude', paneId: '%1', runId: 'neutral-claude-run' },
    ]));
    await vi.waitFor(() => expect(runtime.inbox.read().availability.claude).toEqual({
      availability: 'ready',
    }));
    expect(runtime.inbox.read().records).toEqual([]);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
  });

  it('restores the legacy Hook baseline without unread and replaces the lease through the Bridge', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    writeState(hookStateFile, 1, 'claude-session-1', 'stop', {
      last_assistant_message: 'finished',
    });
    let nextRun = 0;
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: vi.fn(async () => foreground) },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => `claude-run-${++nextRun}`,
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory: `${hookStateFile}.events`,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({
          agentId: 'claude', runId: 'claude-run-1', sessionId: 'claude-session-1',
        }),
        state: 'done', message: 'finished',
      }),
    ]));
    expect(runtime.inbox.read().records[0]).not.toHaveProperty('acceptedAt');
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
    const first = runtime.activeRuns()[0]!;

    writeState(hookStateFile, 2, 'claude-session-2', 'prompt', { prompt: 'continue' });
    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      expect.objectContaining({
        agentId: 'claude', paneId: '%1', runId: 'claude-run-2', sessionId: 'claude-session-2',
      }),
    ]), { timeout: 2_000 });
    expect(runtime.runs.status(first)).toBe('revoked');
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ runId: 'claude-run-2', sessionId: 'claude-session-2' }),
        state: 'working', message: 'continue',
      }),
    ]));
  });

  it('keeps the latest state and degrades instead of clearing when the Hook quota leaves a gap', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    writeState(hookStateFile, 1, 'claude-session', 'prompt', { prompt: 'still working' }, {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001',
    });
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'claude-gap-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'working', message: 'still working' }),
    ]));

    const publishDurable = vi.spyOn(LocalConnectorBridgeClient.prototype, 'publishDurable');
    const gapFile = writeGap({
      eventDirectory,
      sessionId: 'claude-session',
      sourceProcess: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    });
    await vi.waitFor(() => expect(runtime.inbox.read()).toMatchObject({
      availability: { claude: { availability: 'degraded' } },
      records: [expect.objectContaining({ state: 'working', message: 'still working' })],
    }));
    expect(fs.existsSync(gapFile)).toBe(true);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
    await connector.reconcile();
    await connector.reconcile();
    expect(publishDurable.mock.calls.filter(([, eventId]) => eventId === 'claude-gap-test'))
      .toHaveLength(1);
  });

  it('deduplicates gap markers by pane and session within each Connector lifecycle', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const panes = new TestPanes([
      {
        paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude-1',
        currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
      },
      {
        paneId: '%2', sessionName: 'main', windowId: '@2', windowName: 'claude-2',
        currentCommand: 'claude', tty: '/dev/ttys002', foregroundPid: 202,
      },
    ]);
    const foreground = (paneId: string): ForegroundProcessIdentity => paneId === '%1'
      ? { pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude' }
      : { pid: 202, startedAt: 2_000, tty: '/dev/ttys002', executable: '/opt/claude/bin/claude' };
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async (pane) => foreground(pane.paneId) },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: (() => {
        let nextRun = 0;
        return () => `claude-composite-gap-run-${++nextRun}`;
      })(),
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();

    const sharedEventId = 'claude-gap-shared';
    const firstGap = writeGap({
      eventDirectory,
      paneId: '%1',
      sessionId: 'claude-session-1',
      eventId: sharedEventId,
      marker: '1111111111111111',
      sourceProcess: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    });
    const secondGap = writeGap({
      eventDirectory,
      paneId: '%2',
      sessionId: 'claude-session-2',
      eventId: sharedEventId,
      marker: '2222222222222222',
      sourceProcess: { pid: 202, startedAt: 2_000, tty: '/dev/ttys002' },
    });
    const publishDurable = vi.spyOn(LocalConnectorBridgeClient.prototype, 'publishDurable');
    const createConnector = (): ClaudeHookBridgeConnector => new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async (pane) => foreground(pane.paneId) },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });

    const firstConnector = createConnector();
    connectors.push(firstConnector);
    firstConnector.start();
    const gapPublishes = (): unknown[][] => publishDurable.mock.calls.filter(
      ([, eventId]) => eventId === sharedEventId,
    );
    await vi.waitFor(() => expect(gapPublishes()).toHaveLength(2));
    await firstConnector.reconcile();
    await firstConnector.reconcile();
    expect(gapPublishes()).toHaveLength(2);

    fs.unlinkSync(firstGap);
    await firstConnector.reconcile();
    await firstConnector.reconcile();
    expect(fs.existsSync(secondGap)).toBe(true);
    expect(gapPublishes()).toHaveLength(2);

    await firstConnector.close();
    const secondConnector = createConnector();
    connectors.push(secondConnector);
    secondConnector.start();
    await vi.waitFor(() => expect(gapPublishes()).toHaveLength(3));
    await secondConnector.reconcile();
    await secondConnector.reconcile();
    expect(gapPublishes()).toHaveLength(3);
  });

  it('replays an offline terminal spool, acknowledges its Hook file, and deduplicates a retry', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const connectorDirectory = path.join(runtimeDirectory, 'connectors', 'claude');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    writeEvent({
      eventDirectory, sequence: 10, sessionId: 'claude-session', src: 'stop',
      payload: { last_assistant_message: 'finished while offline' },
      sourceProcess: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    });
    writeState(hookStateFile, 10, 'claude-session', 'stop', {
      last_assistant_message: 'finished while offline',
    }, { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' });

    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'claude-offline-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: connectorDirectory,
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => {
      const files = fs.readdirSync(connectorDirectory).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      const queued = JSON.parse(fs.readFileSync(path.join(connectorDirectory, files[0]!), 'utf8')) as {
        durable: Array<{ eventId: string }>;
      };
      expect(queued.durable).toEqual([{ channel: 'inbox', eventId: 'claude-hook-10', payload: expect.anything() }]);
    });
    expect(fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    await runtime.start();
    await vi.waitFor(() => expect(runtime.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({
        agentId: 'claude', eventId: 'claude-hook-10', state: 'done',
        message: 'finished while offline',
      }),
    ]));
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));

    writeEvent({
      eventDirectory, sequence: 10, sessionId: 'claude-session', src: 'stop',
      payload: { last_assistant_message: 'finished while offline' },
      sourceProcess: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    });
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));
    expect(runtime.inbox.read().terminalNotifications).toHaveLength(1);
  });

  it('supersedes an offline permission with the authoritative later working baseline', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    const sourceProcess = { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' };
    writeEvent({
      eventDirectory, sequence: 10, sessionId: 'claude-session', src: 'permreq',
      payload: { tool_name: 'Bash' }, sourceProcess,
    });
    writeEvent({
      eventDirectory, sequence: 11, sessionId: 'claude-session', src: 'prompt',
      payload: { prompt: 'continued after approval' }, sourceProcess,
    });
    writeState(hookStateFile, 11, 'claude-session', 'prompt', {
      prompt: 'continued after approval',
    }, sourceProcess);
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'claude-superseded-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();
    await runtime.start();

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'working', message: 'continued after approval' }),
    ]));
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
  });

  it('deduplicates the same terminal event across a real Runtime and Connector restart', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    const sourceProcess = { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' };
    const writeTerminal = (): void => writeEvent({
      eventDirectory, sequence: 20, sessionId: 'claude-session', src: 'stop',
      payload: { last_assistant_message: 'restart-safe result' }, sourceProcess,
    });
    writeTerminal();
    writeState(hookStateFile, 20, 'claude-session', 'stop', {
      last_assistant_message: 'restart-safe result',
    }, sourceProcess);

    const createPair = (runId: string): {
      runtime: AgentRuntime;
      connector: ClaudeHookBridgeConnector;
    } => {
      const runtime = createBuiltinAgentRuntime({
        panes,
        process: { inspectForeground: async () => foreground },
        stateDirectory: runtimeDirectory,
        authToken: AUTH_TOKEN,
        newRunId: () => runId,
        claudeEvents: { paneSession: () => null },
      });
      const connector = new ClaudeHookBridgeConnector({
        socketPath: runtime.socketPath,
        credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
        stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
        hookStateFile,
        eventDirectory,
        panes,
        process: { inspectForeground: async () => foreground },
        pollMs: 50,
        retryDelayMs: 5,
        maxRetryDelayMs: 10,
      });
      runtimes.push(runtime);
      connectors.push(connector);
      return { runtime, connector };
    };

    const first = createPair('claude-run-before-restart');
    await first.runtime.start();
    first.connector.start();
    await vi.waitFor(() => expect(first.runtime.inbox.read().terminalNotifications).toHaveLength(1));
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));
    await first.connector.close();
    await first.runtime.close();

    writeTerminal();
    const second = createPair('claude-run-after-restart');
    await second.runtime.start();
    second.connector.start();
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));
    expect(second.runtime.inbox.read().terminalNotifications).toHaveLength(1);
    expect(second.runtime.inbox.read().terminalNotifications[0]).toMatchObject({
      eventId: 'claude-hook-20', message: 'restart-safe result',
    });
  });

  it('keeps the Hook source file when shutdown interrupts an offline durable acknowledgement', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const connectorDirectory = path.join(runtimeDirectory, 'connectors', 'claude');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 101,
    };
    const panes = new TestPanes(pane);
    const foreground: ForegroundProcessIdentity = {
      pid: 101, startedAt: 1_000, tty: '/dev/ttys001', executable: '/opt/claude/bin/claude',
    };
    writeEvent({
      eventDirectory, sequence: 30, sessionId: 'claude-session', src: 'stop',
      payload: { last_assistant_message: 'must remain queued' },
    });
    writeState(hookStateFile, 30, 'claude-session', 'stop', {
      last_assistant_message: 'must remain queued',
    });
    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => foreground },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'unused-offline-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: connectorDirectory,
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async () => foreground },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();
    await vi.waitFor(() => {
      const files = fs.readdirSync(connectorDirectory).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(connectorDirectory, files[0]!), 'utf8')).durable)
        .toHaveLength(1);
    });

    await connector.close();
    expect(fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('rejects stale offline events after the pane is reused by a new Claude process', async () => {
    const directory = root();
    const runtimeDirectory = path.join(directory, 'runtime');
    const hookStateFile = path.join(directory, 'claude-state.json');
    const eventDirectory = `${hookStateFile}.events`;
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys001', foregroundPid: 202,
    };
    const panes = new TestPanes(pane);
    const current: ForegroundProcessIdentity = {
      pid: 202,
      startedAt: 2_000,
      tty: '/dev/ttys001',
      executable: '/opt/claude/bin/claude',
    };
    const stale = { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' };
    writeEvent({
      eventDirectory, sequence: 1, sessionId: 'stale-session', src: 'stop',
      payload: { last_assistant_message: 'must not surface' },
      sourceProcess: stale,
    });
    writeState(hookStateFile, 1, 'stale-session', 'stop', {
      last_assistant_message: 'must not surface',
    }, stale);

    const runtime = createBuiltinAgentRuntime({
      panes,
      process: { inspectForeground: async () => current },
      stateDirectory: runtimeDirectory,
      authToken: AUTH_TOKEN,
      newRunId: () => 'current-neutral-run',
      claudeEvents: { paneSession: () => null },
    });
    runtimes.push(runtime);
    await runtime.start();
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath,
      credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors', 'claude'),
      hookStateFile,
      eventDirectory,
      panes,
      process: { inspectForeground: async () => current },
      pollMs: 50,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    connectors.push(connector);
    connector.start();

    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      { agentId: 'claude', paneId: '%1', runId: 'current-neutral-run' },
    ]));
    await vi.waitFor(() => expect(
      fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json')),
    ).toEqual([]));
    expect(runtime.inbox.read().records).toEqual([]);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
  });
});
