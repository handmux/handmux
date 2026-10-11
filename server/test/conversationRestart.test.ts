import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentConversationRestartService,
  ConversationRestartError,
} from '../src/agent-runtime/conversationRestart.js';
import { createCodexConversationRestartController } from '../src/agents/codexConversationRestart.js';
import { CodexRestartReceiptStore } from '../src/agents/codexRestartReceipt.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';
import type { ForegroundProcessIdentity, LivePane } from '../src/agent-runtime/adapter.js';

const SESSION_ID = '12345678-1234-1234-1234-123456789abc';
const EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME = '/home/test';
const SOCKET = `${HOME}/.handmux/codex-app/1.sock`;
const COMMAND = `handmux codex resume ${SESSION_ID}`;

function lease(overrides: Record<string, unknown> = {}) {
  const abort = new AbortController();
  const value: AgentRunLease = {
    ref: { agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: SESSION_ID },
    signal: abort.signal,
    process: { pid: 10, startedAt: 100, tty: '/dev/ttys001' },
    ...overrides,
  };
  return { value, abort };
}

function pane(currentCommand = 'codex'): LivePane {
  return {
    paneId: '%1', sessionName: 'work', windowId: '@1', windowName: 'main',
    currentCommand, tty: '/dev/ttys001',
  };
}

function tui(overrides: Partial<ForegroundProcessIdentity> = {}): ForegroundProcessIdentity {
  return {
    pid: 10, ppid: 20, startedAt: 100, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
    commandLine: `/usr/local/bin/codex --remote unix://${SOCKET} --cd /repo`,
    ...overrides,
  };
}

function wrapper(overrides: Partial<ForegroundProcessIdentity> = {}): ForegroundProcessIdentity {
  return {
    pid: 20, ppid: 2, startedAt: 200, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
    commandLine: '/usr/local/lib/node_modules/handmux/bin/handmux.js codex',
    ...overrides,
  };
}

function appServer(overrides: Partial<ForegroundProcessIdentity> = {}): ForegroundProcessIdentity {
  return {
    pid: 21, ppid: 20, startedAt: 201, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
    commandLine: `/usr/local/bin/codex app-server --listen unix://${SOCKET}`,
    ...overrides,
  };
}

function makeHarness(options: {
  processIdentity?: ForegroundProcessIdentity;
  processGroup?: readonly ForegroundProcessIdentity[];
  managed?: boolean | null;
  threadId?: string | null;
  paneEpoch?: string | null;
  pane?: LivePane | null;
  terminate?: (pid: number, signal: NodeJS.Signals) => void | boolean | Promise<void | boolean>;
  runPaneCommand?: (paneId: string, command: string) => void | Promise<void>;
  runtimeReady?: (paneId: string, sessionId: string, previousRunId: string) => boolean | Promise<boolean>;
  receiptStore?: CodexRestartReceiptStore;
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-restart-'));
  const receiptFile = path.join(directory, 'receipts.json');
  const receipts = options.receiptStore ?? new CodexRestartReceiptStore(receiptFile, {
    now: () => 10_000,
  });
  let currentPane = options.pane === undefined ? pane() : options.pane;
  let currentIdentity: ForegroundProcessIdentity | null = options.processIdentity ?? tui();
  let currentGroup: readonly ForegroundProcessIdentity[] = options.processGroup ?? [tui(), wrapper(), appServer()];
  let managed = options.managed === undefined ? true : options.managed;
  let threadId = options.threadId === undefined ? SESSION_ID : options.threadId;
  let epoch = options.paneEpoch === undefined ? EPOCH : options.paneEpoch;
  let now = 1_000;
  const released = vi.fn();
  const pauseSessionDelivery = vi.fn(async () => released);
  const terminate = vi.fn(async (pid: number, signal: NodeJS.Signals) => {
    if (options.terminate) return await options.terminate(pid, signal);
    currentIdentity = {
      pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh',
    };
    currentGroup = [currentIdentity];
    currentPane = pane('zsh');
    managed = false;
    threadId = null;
  });
  const runPaneCommand = vi.fn(async (paneId: string, command: string) => {
    if (options.runPaneCommand) return await options.runPaneCommand(paneId, command);
    currentIdentity = {
      pid: 40, ppid: 50, startedAt: 400, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
      commandLine: `/usr/local/bin/codex --remote unix://${SOCKET} --cd /repo resume ${SESSION_ID}`,
    };
    currentGroup = [currentIdentity, wrapper({ pid: 50, startedAt: 500 }), appServer({ pid: 51, ppid: 50, startedAt: 501 })];
    currentPane = pane('codex');
    managed = true;
    threadId = SESSION_ID;
  });
  const inspectForegroundFresh = vi.fn(async () => currentIdentity && structuredClone(currentIdentity));
  const inspectForegroundGroupFresh = vi.fn(async () => structuredClone(currentGroup));
  const listPanes = vi.fn(async () => currentPane ? [structuredClone(currentPane)] : []);
  const paneEpoch = vi.fn(async () => epoch);
  const controller = createCodexConversationRestartController({
    app: { discover: vi.fn(async () => ({ managed, threadId })) },
    panes: {
      list: listPanes,
      subscribe: vi.fn(() => () => {}),
    },
    process: {
      inspectForeground: vi.fn(async () => currentIdentity && structuredClone(currentIdentity)),
      inspectForegroundFresh,
      inspectForegroundGroupFresh,
    },
    commands: {
      paneEpoch,
      runPaneCommand,
      terminate,
    },
    receipts,
    pauseSessionDelivery,
    resolveRun: vi.fn((ref) => ref.runId === 'run-1' ? run.value : null),
    isRuntimeRunReady: options.runtimeReady ?? (async () => managed === true && threadId === SESSION_ID
      && currentIdentity?.pid === 40),
    home: HOME,
    now: () => now,
    wait: async (ms: number) => { now += ms; },
    pollMs: 100,
    timeoutMs: 500,
  });
  const run = lease();
  const service = new AgentConversationRestartService({ codex: controller }, { timeoutMs: 2_000 });
  return {
    controller, service, run, receipts, pauseSessionDelivery, released, terminate, runPaneCommand,
    receiptFile, inspectForegroundFresh, inspectForegroundGroupFresh, listPanes, paneEpoch,
    appManaged: () => managed,
    appThread: () => threadId,
    setApp: (next: { managed: boolean | null; threadId: string | null }) => {
      managed = next.managed; threadId = next.threadId;
    },
    setPane: (next: LivePane | null) => { currentPane = next; },
    setIdentity: (next: ForegroundProcessIdentity | null) => { currentIdentity = next; },
    setGroup: (next: readonly ForegroundProcessIdentity[]) => { currentGroup = next; },
    setEpoch: (next: string | null) => { epoch = next; },
  };
}

describe('Codex conversation restart', () => {
  it('stops only the verified TUI, resumes the same session, and releases delivery at readiness', async () => {
    const h = makeHarness();

    const receipt = await h.service.restart(h.run.value);

    expect(receipt).toMatchObject({ phase: 'ready', state: 'current', canResume: false });
    expect(receipt.recovery).toEqual({ kind: 'codex_resume', sessionId: SESSION_ID, command: COMMAND });
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(h.runPaneCommand).toHaveBeenCalledTimes(1);
    expect(h.runPaneCommand).toHaveBeenCalledWith('%1', COMMAND);
    expect(h.pauseSessionDelivery).toHaveBeenCalledOnce();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
  });

  it('refuses to stop a managed App Server whose thread differs from the requested session', async () => {
    const h = makeHarness({ threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'unavailable', recovery: { recovery: { command: COMMAND }, canResume: false },
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.pauseSessionDelivery).not.toHaveBeenCalled();
    expect(h.released).not.toHaveBeenCalled();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
  });

  it('does not treat an unrelated Codex TUI as a Handmux-managed wrapper child', async () => {
    const h = makeHarness({
      processGroup: [tui(), wrapper({ commandLine: '/usr/local/bin/node unrelated-script.js' }), appServer()],
    });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.runPaneCommand).not.toHaveBeenCalled();
    expect(h.pauseSessionDelivery).not.toHaveBeenCalled();
    expect(h.released).not.toHaveBeenCalled();
  });

  it.each([
    ['pid', { pid: 11 }],
    ['start time', { startedAt: 101 }],
    ['TTY', { tty: '/dev/ttys002' }],
    ['executable', { executable: '/tmp/not-codex' }],
  ])('does not signal when the fresh TUI %s differs from the locked run', async (_label, changes) => {
    const h = makeHarness();
    h.inspectForegroundFresh.mockResolvedValue(tui());
    h.inspectForegroundFresh.mockResolvedValueOnce(tui()).mockResolvedValue(tui(changes));

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: _label === 'executable' ? 'unavailable' : 'stale_run',
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it('does not signal the TUI if the direct Handmux wrapper generation changes before SIGTERM', async () => {
    const h = makeHarness();
    h.inspectForegroundGroupFresh
      .mockResolvedValueOnce([tui(), wrapper(), appServer()])
      .mockResolvedValue([tui(), wrapper({ startedAt: 201 }), appServer()]);

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'stale_run' });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it.each([
    ['tmux epoch', { epoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['pane identity', { pane: { ...pane(), windowId: '@2' } }],
  ])('does not signal after the %s changes before the stop boundary', async (_label, changes) => {
    const h = makeHarness();
    if ('epoch' in changes) h.paneEpoch.mockResolvedValueOnce(EPOCH).mockResolvedValue(changes.epoch);
    if ('pane' in changes) h.listPanes.mockResolvedValueOnce([pane()]).mockResolvedValue([changes.pane]);

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'stale_run' });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it('clears the receipt and releases delivery when SIGTERM fails and the original TUI remains alive', async () => {
    const h = makeHarness({ terminate: async () => { throw new Error('permission denied'); } });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.terminate).toHaveBeenCalledOnce();
    expect(h.runPaneCommand).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
  });

  it('keeps the queue fenced when the signaled TUI never yields to its shell', async () => {
    const h = makeHarness({ terminate: async () => {} });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'unavailable', recovery: { phase: 'prepared', canResume: false },
    });
    expect(h.runPaneCommand).not.toHaveBeenCalled();
    expect(h.released).not.toHaveBeenCalled();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(true);
  });

  it('keeps recovery and the delivery fence if command injection fails after the TUI exits', async () => {
    const h = makeHarness({ runPaneCommand: async () => { throw new Error('tmux disconnected'); } });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'unavailable', recovery: { phase: 'resuming', recovery: { command: COMMAND } },
    });
    expect(h.runPaneCommand).toHaveBeenCalledTimes(1);
    expect(h.runPaneCommand).toHaveBeenCalledWith('%1', COMMAND);
    expect(h.released).not.toHaveBeenCalled();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(true);
  });

  it('never injects into a replacement pane after the old TUI stops', async () => {
    let h!: ReturnType<typeof makeHarness>;
    h = makeHarness({ terminate: async () => {
      h.setIdentity({ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' });
      h.setPane({ ...pane('zsh'), windowId: '@2' });
      h.setApp({ managed: false, threadId: null });
      h.setGroup([]);
    } });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'unavailable', recovery: { state: 'stale', canResume: false },
    });
    expect(h.runPaneCommand).not.toHaveBeenCalled();
    expect(h.released).not.toHaveBeenCalled();
  });

  it('keeps a stopped session pending across service recreation until the same managed thread is ready', async () => {
    const h = makeHarness({ terminate: async () => {} });
    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'unavailable' });
    const reloadedReceipts = new CodexRestartReceiptStore(h.receiptFile);
    const reloaded = makeHarness({ receiptStore: reloadedReceipts, pane: pane('zsh'),
      processIdentity: { pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' },
      processGroup: [{ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' }],
      managed: false, threadId: null });

    expect(reloaded.receipts.isPending('codex', SESSION_ID)).toBe(true);
    await expect(reloaded.controller.recovery('%1')).resolves.toMatchObject({
      phase: 'prepared', state: 'current', canResume: true,
    });
  });

  it('does not release the queue merely because the new App Server reports the old thread', async () => {
    const h = makeHarness({ runtimeReady: async () => false });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'unavailable', recovery: { phase: 'resuming' },
    });
    expect(h.released).not.toHaveBeenCalled();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(true);
  });

  it('deduplicates two restart requests for the same pane while the first one owns the process', async () => {
    let markSignal!: () => void;
    const signaled = new Promise<void>((resolve) => { markSignal = resolve; });
    let releaseSignal!: () => void;
    const waitSignal = new Promise<void>((resolve) => { releaseSignal = resolve; });
    const h = makeHarness({ terminate: async () => {
      markSignal();
      await waitSignal;
      // Simulate the original TUI and wrapper having exited after the signal.
      h.setIdentity({ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' });
      h.setPane(pane('zsh'));
      h.setGroup([{ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' }]);
      h.setApp({ managed: false, threadId: null });
    } });
    const first = h.service.restart(h.run.value);
    await signaled;
    const second = h.service.restart(h.run.value);
    releaseSignal();

    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(h.terminate).toHaveBeenCalledOnce();
  });

  it('does not type a recovery command if the shell generation changes during the final check', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-restart-recovery-'));
    const receipts = new CodexRestartReceiptStore(path.join(directory, 'receipts.json'));
    const saved = receipts.prepare({
      pane: { paneId: '%1', sessionName: 'work', windowId: '@1', tty: '/dev/ttys001', tmuxEpoch: EPOCH },
      process: {
        tui: {
          pid: 10, ppid: 20, startedAt: 100, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
        },
        wrapper: {
          pid: 20, ppid: 2, startedAt: 200, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
        },
      },
      sessionId: SESSION_ID,
      previousRunId: 'run-1',
    });
    receipts.transition(saved.operationId, 'prepared', 'stopped');
    const shell = {
      pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh',
    };
    const other = {
      pid: 31, ppid: 2, startedAt: 301, tty: '/dev/ttys001', executable: '/bin/bash', commandLine: '/bin/bash',
    };
    const h = makeHarness({
      receiptStore: receipts,
      pane: pane('zsh'),
      processIdentity: shell,
      processGroup: [shell],
      managed: false,
      threadId: null,
    });
    h.inspectForegroundFresh
      .mockResolvedValueOnce(shell)
      .mockResolvedValueOnce(shell)
      .mockResolvedValueOnce(other);

    await expect(h.controller.recover('%1', saved.operationId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'stale_run' });
    expect(h.runPaneCommand).not.toHaveBeenCalled();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(true);
    expect(h.receipts.get(saved.operationId)?.phase).toBe('resuming');
  });

  it('bounds a hung controller operation and aborts only its internal timeout signal', async () => {
    const observedSignals: AbortSignal[] = [];
    const controller = {
      apiVersion: 1 as const,
      restart: vi.fn(async (_run: AgentRunLease, signal: AbortSignal) => {
        observedSignals.push(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      }),
      recovery: vi.fn(async () => null),
      recover: vi.fn(async () => {
        throw new Error('unused');
      }),
    };
    const bounded = new AgentConversationRestartService({ codex: controller }, { timeoutMs: 5 });

    await expect(bounded.restart(lease().value)).rejects.toMatchObject({ code: 'unavailable' });
    expect(controller.restart).toHaveBeenCalledOnce();
    expect(observedSignals[0]?.aborted).toBe(true);
  });
});
