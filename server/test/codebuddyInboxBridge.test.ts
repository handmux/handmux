import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeBuddyHookBridgeConnector } from '../connectors/codebuddy/index.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import type { ForegroundProcessIdentity, LivePane, ProcessContext, ReadonlyPaneSource } from '../src/agent-runtime/adapter.js';
import type { AgentRuntime } from '../src/agent-runtime/runtime.js';

const AUTH_TOKEN = 'codebuddy-bridge-auth-token-that-is-at-least-32-bytes';
const SESSION = 'codebuddy-session-1';
// The owning CodeBuddy process as the Hook shell records it: the launcher Node process, NOT the pane's
// foreground leaf, which on a real 2.155.0 install is often a transient tool child in the same group.
const CODEBUDDY_PROCESS = { pid: 400, startedAt: 1_000, tty: '/dev/ttys001' };
const PANE_ID = '%1';

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];
const connectors: CodeBuddyHookBridgeConnector[] = [];

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
  // Short prefix: the Bridge's unix socket path must stay inside the platform's ~104-byte sun_path limit.
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cb-bridge-'));
  directories.push(value);
  return value;
}

// CodeBuddy is never the pane's foreground leaf, so the fixture must mirror that: the leaf is a transient
// tool child while the launcher — the row the adapter verifies and anchors the lease on — sits in the group.
function codebuddyPane(): LivePane {
  return {
    paneId: PANE_ID, sessionName: 'main', windowId: '@1', windowName: 'codebuddy',
    currentCommand: 'node', tty: '/dev/ttys001',
  };
}

function codebuddyProcess(): ProcessContext {
  return {
    inspectForeground: async (): Promise<ForegroundProcessIdentity> => ({
      pid: 401, startedAt: 1_001, tty: '/dev/ttys001',
      commandLine: 'npm list', executable: '/usr/local/bin/node',
    }),
    inspectForegroundGroup: async (): Promise<readonly ForegroundProcessIdentity[]> => [
      { ...CODEBUDDY_PROCESS, ppid: 90, commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence' },
      { pid: 401, ppid: 400, startedAt: 1_001, tty: '/dev/ttys001', commandLine: 'npm list' },
    ],
  };
}

// The shared writer updates the pane's latest row under a lock and (on SessionEnd) deletes it. These helpers
// reproduce its output BYTE-FOR-BYTE, including the `agent` and `eventId` literals it still stamps for every
// Agent it serves — a fixture that "improved" those would hide exactly the identity mismatch that decides
// whether a completion notifies. Everything stays in a temp directory; the real ~/.codebuddy is never touched.
const WRITER_AGENT = 'claude';
const WRITER_EVENT_PREFIX = 'claude-hook';

function writeStateRow(
  file: string,
  src: string,
  sequence: number,
  payload: Record<string, unknown>,
  agent = WRITER_AGENT,
): void {
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return {}; }
  })();
  state[PANE_ID] = { ts: sequence * 10, src, host: 'test-host', agent, process: CODEBUDDY_PROCESS, sequence, payload };
  fs.writeFileSync(file, JSON.stringify(state));
}

function clearState(file: string): void {
  fs.writeFileSync(file, JSON.stringify({}));
}

function writeSpoolEvent(
  eventDirectory: string,
  sequence: number,
  src: string,
  payload: Record<string, unknown>,
  { agent = WRITER_AGENT, sessionId = SESSION }: { agent?: string; sessionId?: string } = {},
): void {
  fs.mkdirSync(eventDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(eventDirectory, `event-${String(sequence).padStart(16, '0')}-400.json`),
    JSON.stringify({
      version: 1,
      type: 'event',
      agent,
      eventId: `${WRITER_EVENT_PREFIX}-${sequence}`,
      sequence,
      paneId: PANE_ID,
      src,
      sourceOccurredAt: sequence * 10,
      sessionId,
      process: CODEBUDDY_PROCESS,
      payload: { ...payload, session_id: sessionId },
    }),
  );
}

function eventFiles(eventDirectory: string): string[] {
  try {
    return fs.readdirSync(eventDirectory).filter((name) => name.endsWith('.json'));
  } catch { return []; }
}

async function harness() {
  const directory = root();
  const runtimeDirectory = path.join(directory, 'runtime');
  const hookStateFile = path.join(directory, 'codebuddy-state.json');
  const eventDirectory = `${hookStateFile}.events`;
  const panes = new TestPanes(codebuddyPane());
  const process = codebuddyProcess();
  const runtime = createBuiltinAgentRuntime({
    panes,
    process,
    stateDirectory: runtimeDirectory,
    authToken: AUTH_TOKEN,
    newRunId: (() => { let next = 0; return () => `codebuddy-run-${++next}`; })(),
  });
  runtimes.push(runtime);
  await runtime.start();
  const connector = new CodeBuddyHookBridgeConnector({
    socketPath: runtime.socketPath,
    credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
    stateDirectory: path.join(runtimeDirectory, 'connectors', 'codebuddy'),
    hookStateFile,
    eventDirectory,
    panes,
    process,
    pollMs: 50,
    retryDelayMs: 5,
    maxRetryDelayMs: 10,
  });
  connectors.push(connector);
  connector.start();
  return { runtime, connector, hookStateFile, eventDirectory };
}

describe('CodeBuddy Hook → LocalAgentBridge → Inbox vertical slice', () => {
  it('binds the CodeBuddy session to the run and carries working → done', async () => {
    const { runtime, hookStateFile, eventDirectory } = await harness();
    writeStateRow(hookStateFile, 'prompt', 1, { session_id: SESSION, prompt: '跑一下测试' });
    writeSpoolEvent(eventDirectory, 1, 'prompt', { session_id: SESSION, prompt: '跑一下测试' });

    // The session binding is what lets the phone open the conversation lens at all: the run must carry the
    // session_id the Hook reported, not just the process-presence run Slice A produced.
    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      expect.objectContaining({ agentId: 'codebuddy', paneId: PANE_ID, sessionId: SESSION }),
    ]), { timeout: 2_000 });
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ agentId: 'codebuddy', sessionId: SESSION }),
        state: 'working', message: '跑一下测试',
      }),
    ]), { timeout: 2_000 });
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);

    writeStateRow(hookStateFile, 'stop', 2, { session_id: SESSION, last_assistant_message: '测试通过' });
    writeSpoolEvent(eventDirectory, 2, 'stop', { session_id: SESSION, last_assistant_message: '测试通过' });

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'done', message: '测试通过' }),
    ]), { timeout: 2_000 });
    await vi.waitFor(() => expect(runtime.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ agentId: 'codebuddy', state: 'done', message: '测试通过' }),
    ]), { timeout: 2_000 });
    // Each acknowledged edge releases its Hook source file; a stuck one would be re-read on every poll.
    await vi.waitFor(() => expect(eventFiles(eventDirectory)).toEqual([]), { timeout: 2_000 });
  });

  it('closes a running turn as an error on StopFailure', async () => {
    const { runtime, hookStateFile, eventDirectory } = await harness();
    writeStateRow(hookStateFile, 'prompt', 1, { session_id: SESSION, prompt: '开始' });
    writeSpoolEvent(eventDirectory, 1, 'prompt', { session_id: SESSION, prompt: '开始' });
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'working' }),
    ]), { timeout: 2_000 });

    // No Stop fires for a turn that died on an API error, so StopFailure is the only closing edge: without
    // it the pane would stay 进行中 forever.
    writeStateRow(hookStateFile, 'stopfail', 2, { session_id: SESSION, error_type: 'overloaded' });
    writeSpoolEvent(eventDirectory, 2, 'stopfail', { session_id: SESSION, error_type: 'overloaded' });

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'error', message: '服务过载' }),
    ]), { timeout: 2_000 });
    await vi.waitFor(() => expect(runtime.inbox.read().terminalNotifications).toEqual([
      expect.objectContaining({ agentId: 'codebuddy', state: 'error', message: '服务过载' }),
    ]), { timeout: 2_000 });
  });

  it('clears the pane projection on SessionEnd while the process keeps the run alive', async () => {
    const { runtime, hookStateFile, eventDirectory } = await harness();
    writeStateRow(hookStateFile, 'stop', 1, { session_id: SESSION, last_assistant_message: 'done' });
    writeSpoolEvent(eventDirectory, 1, 'stop', { session_id: SESSION, last_assistant_message: 'done' });
    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([
      expect.objectContaining({ state: 'done' }),
    ]), { timeout: 2_000 });

    // SessionEnd: the writer deletes the pane's latest row and spools the closing edge. The provider session
    // is over, so its Inbox item must go — but the pane is still running CodeBuddy, and only process
    // identity may decide whether the run itself is revoked.
    clearState(hookStateFile);
    writeSpoolEvent(eventDirectory, 2, 'end', { session_id: SESSION });

    await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([]), { timeout: 2_000 });
    expect(runtime.activeRuns()).toEqual([
      expect.objectContaining({ agentId: 'codebuddy', paneId: PANE_ID }),
    ]);
    await vi.waitFor(() => expect(eventFiles(eventDirectory)).toEqual([]), { timeout: 2_000 });
  });

  it('ignores rows and events that a foreign provider left behind', async () => {
    const { runtime, connector, hookStateFile, eventDirectory } = await harness();
    writeStateRow(hookStateFile, 'stop', 1, { session_id: SESSION, last_assistant_message: 'not CodeBuddy' }, 'codex');
    writeSpoolEvent(eventDirectory, 1, 'stop', { session_id: SESSION, last_assistant_message: 'not CodeBuddy' }, {
      agent: 'codex',
    });

    await connector.reconcile();
    await connector.reconcile();
    expect(runtime.inbox.read().records).toEqual([]);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
    // An unprojected source stays queued: dropping it would silently lose evidence, acking it would claim
    // state nobody verified.
    expect(eventFiles(eventDirectory)).toEqual([
      'event-0000000000000001-400.json',
    ]);
  });

  it('does not turn notification noise into an Inbox card', async () => {
    const { runtime, hookStateFile, eventDirectory } = await harness();
    writeStateRow(hookStateFile, 'notify', 1, { session_id: SESSION, notification_type: 'auth_success' });
    writeSpoolEvent(eventDirectory, 1, 'notify', { session_id: SESSION, notification_type: 'auth_success' });

    // The pane is still CodeBuddy, so its run and Inbox baseline must be ready — with no fabricated state.
    await vi.waitFor(() => expect(runtime.inbox.read().availability.codebuddy).toEqual({
      availability: 'ready',
    }), { timeout: 2_000 });
    await vi.waitFor(() => expect(eventFiles(eventDirectory)).toEqual([]), { timeout: 2_000 });
    expect(runtime.inbox.read().records).toEqual([]);
    expect(runtime.inbox.read().terminalNotifications).toEqual([]);
  });

  it('attaches a neutral CodeBuddy pane before its first Hook event', async () => {
    const { runtime } = await harness();
    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      { agentId: 'codebuddy', paneId: PANE_ID, runId: 'codebuddy-run-1' },
    ]), { timeout: 2_000 });
    await vi.waitFor(() => expect(runtime.inbox.read().availability.codebuddy).toEqual({
      availability: 'ready',
    }), { timeout: 2_000 });
    expect(runtime.inbox.read().records).toEqual([]);
  });
});
