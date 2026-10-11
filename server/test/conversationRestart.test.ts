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
import type { AgentConversationRestartControllerV1, ConversationRestartReceipt } from '../src/agent-runtime/conversationRestart.js';
import type { ForegroundProcessIdentity, LivePane } from '../src/agent-runtime/adapter.js';

const SESSION_ID = '12345678-1234-1234-1234-123456789abc';
const EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME = '/home/test';
const SOCKET = `${HOME}/.handmux/codex-app/1.sock`;
const COMMAND = `handmux codex resume ${SESSION_ID}`;

describe('shared conversation restart routing', () => {
  const operationId = 'a'.repeat(64);
  const receipt = (agentId: string): ConversationRestartReceipt => ({
    agentId, paneId: '%1', operationId,
    recovery: { kind: 'resume_command', sessionId: 'session-1', command: 'agent resume session-1' },
    phase: 'stopped', state: 'current', canResume: true,
  });
  const controller = (agentId: string): AgentConversationRestartControllerV1 => ({
    apiVersion: 1,
    validRecovery: (value) => value.kind === 'resume_command'
      && value.sessionId === 'session-1' && value.command === 'agent resume session-1',
    restart: vi.fn(async () => receipt(agentId)),
    recovery: vi.fn(async () => receipt(agentId)),
    recover: vi.fn(async () => receipt(agentId)),
  });

  it('routes a supported non-Codex run and its shell-gap recovery by receipt identity', async () => {
    const pi = controller('pi');
    const codex = controller('codex');
    codex.recovery = vi.fn(async () => null);
    const service = new AgentConversationRestartService({ codex, pi });
    const run = lease({ ref: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' } });
    expect(await service.restart(run.value)).toEqual(receipt('pi'));
    expect(await service.recovery('%1')).toEqual(receipt('pi'));
    expect(await service.recover('%1', operationId)).toEqual(receipt('pi'));
    expect(pi.recover).toHaveBeenCalledWith('%1', operationId, expect.any(AbortSignal));
    expect(codex.recover).not.toHaveBeenCalled();
  });

  it('rejects ambiguous or mismatched recovery without dispatching a destructive command', async () => {
    const first = controller('codex');
    const second = controller('pi');
    const service = new AgentConversationRestartService({ codex: first, pi: second });
    await expect(service.recovery('%1')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.recover('%1', operationId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(first.recover).not.toHaveBeenCalled();
    expect(second.recover).not.toHaveBeenCalled();
    second.recovery = vi.fn(async () => ({ ...receipt('pi'), paneId: '%2' }));
    await expect(service.recovery('%1')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('ignores completed receipts from a previous Agent and rejects an unknown Agent', async () => {
    const codex = controller('codex');
    codex.recovery = vi.fn(async () => ({ ...receipt('codex'), phase: 'ready' as const, canResume: false }));
    const pi = controller('pi');
    const service = new AgentConversationRestartService({ codex, pi });
    expect(await service.recovery('%1')).toEqual(receipt('pi'));
    expect(await service.recover('%1', operationId)).toEqual(receipt('pi'));
    const unknown = lease({ ref: { agentId: 'new-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-1' } });
    await expect(service.restart(unknown.value)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('returns a completed receipt when it is the only recovery result, without allowing another resume', async () => {
    const codex = controller('codex');
    const ready = { ...receipt('codex'), phase: 'ready' as const, canResume: false };
    codex.recovery = vi.fn(async () => ready);
    const service = new AgentConversationRestartService({ codex });

    await expect(service.recovery('%1')).resolves.toEqual(ready);
    await expect(service.recover('%1', operationId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(codex.recover).not.toHaveBeenCalled();
  });

  it('does not publish a controller receipt for another session or an unvalidated native command', async () => {
    const pi = controller('pi');
    pi.restart = vi.fn(async () => ({ ...receipt('pi'), recovery: {
      kind: 'resume_command', sessionId: 'different-session', command: 'agent resume session-1',
    } }));
    const service = new AgentConversationRestartService({ pi });
    const run = lease({ ref: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' } });
    await expect(service.restart(run.value)).rejects.toMatchObject({ code: 'unavailable' });
    pi.restart = vi.fn(async () => ({ ...receipt('pi'), recovery: {
      kind: 'resume_command', sessionId: 'session-1', command: 'different agent command',
    } }));
    await expect(service.restart(run.value)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not expose a changed command from a failed recovery with the same operation id', async () => {
    const pi = controller('pi');
    const changed = { ...receipt('pi'), recovery: {
      kind: 'resume_command', sessionId: 'session-1', command: 'different agent command',
    } };
    pi.validRecovery = () => true;
    pi.recover = vi.fn(async () => {
      throw new ConversationRestartError('provider failed', 'unavailable', changed);
    });
    const service = new AgentConversationRestartService({ pi });
    await expect(service.recover('%1', operationId)).rejects.toMatchObject({
      code: 'unavailable', recovery: undefined,
    });
  });
});

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

function npmCodexShimFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-npm-shim-'));
  const bin = path.join(directory, '@openai', 'codex', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.js'), '#!/usr/bin/env node\n');
  const launcher = path.join(directory, 'codex');
  fs.symlinkSync(path.join(bin, 'codex.js'), launcher);
  const tuiShim = {
    pid: 22, ppid: 20, startedAt: 202, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
    commandLine: `node ${launcher} --remote unix://${SOCKET} --cd /repo`,
  };
  const appServerShim = {
    pid: 23, ppid: 20, startedAt: 203, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
    commandLine: `node ${launcher} app-server --listen unix://${SOCKET}`,
  };
  return { launcher, tuiShim, appServerShim };
}

function makeHarness(options: {
  processIdentity?: ForegroundProcessIdentity;
  processGroup?: readonly ForegroundProcessIdentity[];
  runProcess?: AgentRunLease['process'];
  managed?: boolean | null;
  threadId?: string | null;
  paneEpoch?: string | null;
  pane?: LivePane | null;
  terminate?: (pid: number, signal: NodeJS.Signals) => void | boolean | Promise<void | boolean>;
  runPaneCommand?: (paneId: string, command: string) => void | Promise<void>;
  runtimeReady?: (paneId: string, sessionId: string, previousRunId: string) => boolean | Promise<boolean>;
  receiptStore?: CodexRestartReceiptStore;
  appServerProbeStates?: readonly ('same' | 'replaced' | 'exited' | 'unknown')[];
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
  let appServerProbeState: 'same' | 'replaced' | 'exited' | 'unknown' = 'same';
  const appServerProbeStates = [...(options.appServerProbeStates ?? [])];
  const events: string[] = [];
  const released = vi.fn();
  const pauseSessionDelivery = vi.fn(async () => released);
  const terminate = vi.fn(async (pid: number, signal: NodeJS.Signals) => {
    if (options.terminate) return await options.terminate(pid, signal);
    appServerProbeState = 'exited';
    currentIdentity = {
      pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh',
    };
    currentGroup = [currentIdentity];
    currentPane = pane('zsh');
    managed = false;
    threadId = null;
  });
  const runPaneCommand = vi.fn(async (paneId: string, command: string) => {
    events.push('resume-command');
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
  const inspectProcessGenerationFresh = vi.fn(async () => {
    if (appServerProbeStates.length) appServerProbeState = appServerProbeStates.shift()!;
    events.push(`app-server:${appServerProbeState}`);
    return appServerProbeState;
  });
  const listPanes = vi.fn(async () => currentPane ? [structuredClone(currentPane)] : []);
  const paneEpoch = vi.fn(async () => epoch);
  const run = lease(options.runProcess ? { process: options.runProcess } : {});
  let runResolved = true;
  const resolveRun = vi.fn((ref) => ref.runId === 'run-1' && runResolved ? run.value : null);
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
      inspectProcessGenerationFresh,
    },
    commands: {
      paneEpoch,
      runPaneCommand,
      terminate,
    },
    receipts,
    pauseSessionDelivery,
    resolveRun,
    isRuntimeRunReady: options.runtimeReady ?? (async () => managed === true && threadId === SESSION_ID
      && currentIdentity?.pid === 40),
    home: HOME,
    now: () => now,
    wait: async (ms: number) => { now += ms; },
    pollMs: 100,
    timeoutMs: 500,
  });
  const service = new AgentConversationRestartService({ codex: controller }, { timeoutMs: 2_000 });
  return {
    controller, service, run, receipts, pauseSessionDelivery, released, terminate, runPaneCommand,
    receiptFile, inspectForegroundFresh, inspectForegroundGroupFresh, inspectProcessGenerationFresh,
    listPanes, paneEpoch, resolveRun, events,
    group: () => structuredClone(currentGroup),
    appManaged: () => managed,
    appThread: () => threadId,
    setApp: (next: { managed: boolean | null; threadId: string | null }) => {
      managed = next.managed; threadId = next.threadId;
    },
    setPane: (next: LivePane | null) => { currentPane = next; },
    setIdentity: (next: ForegroundProcessIdentity | null) => { currentIdentity = next; },
    setGroup: (next: readonly ForegroundProcessIdentity[]) => { currentGroup = next; },
    setEpoch: (next: string | null) => { epoch = next; },
    setAppServerProbe: (next: 'same' | 'replaced' | 'exited' | 'unknown') => { appServerProbeState = next; },
    appServerProbe: () => appServerProbeState,
    revokeRun: () => { runResolved = false; },
  };
}

describe('Codex conversation restart', () => {
  it('restarts the verified TUI when the older App Server was selected as foreground', async () => {
    const h = makeHarness({
      processIdentity: appServer(),
      processGroup: [appServer(), tui(), wrapper()],
      runProcess: { pid: 21, startedAt: 201, tty: '/dev/ttys001' },
    });

    const receipt = await h.service.restart(h.run.value);

    expect(receipt.phase).toBe('ready');
    expect(h.terminate).toHaveBeenCalledOnce();
    expect(h.terminate).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(h.runPaneCommand).toHaveBeenCalledOnce();
    expect(h.runPaneCommand).toHaveBeenCalledWith('%1', COMMAND);
  });

  it('recognizes readiness when the replacement App Server is selected as foreground', async () => {
    let h!: ReturnType<typeof makeHarness>;
    h = makeHarness({
      processIdentity: appServer(),
      processGroup: [appServer(), tui(), wrapper()],
      runProcess: { pid: 21, startedAt: 201, tty: '/dev/ttys001' },
      runtimeReady: async () => true,
      runPaneCommand: async () => {
        h.setIdentity(appServer({ pid: 51, ppid: 50, startedAt: 501 }));
        h.setGroup([
          appServer({ pid: 51, ppid: 50, startedAt: 501 }),
          tui({ pid: 40, ppid: 50, startedAt: 400 }),
          wrapper({ pid: 50, startedAt: 500 }),
        ]);
        h.setPane(pane('node'));
        h.setApp({ managed: true, threadId: SESSION_ID });
      },
    });

    const receipt = await h.service.restart(h.run.value);

    expect(receipt.phase).toBe('ready');
    expect(h.terminate).toHaveBeenCalledOnce();
    expect(h.terminate).toHaveBeenCalledWith(10, 'SIGTERM');
  });

  it('refuses to stop Codex when two managed App Servers share the same wrapper and socket', async () => {
    const h = makeHarness({ processGroup: [tui(), wrapper(), appServer(),
      appServer({ pid: 24, startedAt: 204 })] });
    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started' });
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('restarts through both verified npm Codex shims and persists their generations', async () => {
    const { tuiShim, appServerShim } = npmCodexShimFixture();
    let h!: ReturnType<typeof makeHarness>;
    h = makeHarness({
      processIdentity: tui({ ppid: tuiShim.pid }),
      processGroup: [tui({ ppid: tuiShim.pid }), tuiShim, wrapper(), appServerShim,
        appServer({ ppid: appServerShim.pid })],
      runPaneCommand: async () => {
        const nextTuiShim = { ...tuiShim, pid: 52, ppid: 50, startedAt: 502 };
        const nextAppServerShim = { ...appServerShim, pid: 53, ppid: 50, startedAt: 503 };
        const nextTui = tui({ pid: 40, ppid: 52, startedAt: 400 });
        h.setIdentity(nextTui);
        h.setGroup([nextTui, nextTuiShim, wrapper({ pid: 50, startedAt: 500 }),
          nextAppServerShim, appServer({ pid: 51, ppid: 53, startedAt: 501 })]);
        h.setPane(pane('codex'));
        h.setApp({ managed: true, threadId: SESSION_ID });
      },
    });

    const receipt = await h.service.restart(h.run.value);

    expect(receipt.phase).toBe('ready');
    expect(h.terminate).toHaveBeenCalledOnce();
    expect(h.terminate).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(h.runPaneCommand).toHaveBeenCalledOnce();
    expect(h.runPaneCommand).toHaveBeenCalledWith('%1', COMMAND);
    expect(h.receipts.get(receipt.operationId)?.process).toMatchObject({
      tuiShim: { pid: tuiShim.pid, startedAt: tuiShim.startedAt },
      appServerShim: { pid: appServerShim.pid, startedAt: appServerShim.startedAt },
    });
    expect(new CodexRestartReceiptStore(h.receiptFile).get(receipt.operationId)?.process)
      .toMatchObject({ tuiShim: { pid: tuiShim.pid }, appServerShim: { pid: appServerShim.pid } });
  });

  it('rejects a lookalike Node script before stopping any process', async () => {
    const { tuiShim, appServerShim } = npmCodexShimFixture();
    const fakeTuiShim = { ...tuiShim, commandLine: tuiShim.commandLine.replace(/codex --remote/, 'fake-codex.js --remote') };
    const h = makeHarness({
      processIdentity: tui({ ppid: fakeTuiShim.pid }),
      processGroup: [tui({ ppid: fakeTuiShim.pid }), fakeTuiShim, wrapper(), appServerShim,
        appServer({ ppid: appServerShim.pid })],
    });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'not_started', recovery: undefined,
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.pauseSessionDelivery).not.toHaveBeenCalled();
    expect(h.receipts.latestForPane('%1')).toBeNull();
  });

  it('rejects a changed npm shim generation at the final stop boundary', async () => {
    const { tuiShim, appServerShim } = npmCodexShimFixture();
    const original = [tui({ ppid: tuiShim.pid }), tuiShim, wrapper(), appServerShim,
      appServer({ ppid: appServerShim.pid })];
    const h = makeHarness({ processIdentity: original[0]!, processGroup: original });
    h.inspectForegroundGroupFresh.mockResolvedValueOnce(original).mockResolvedValue([
      original[0]!, { ...tuiShim, startedAt: tuiShim.startedAt + 1 }, wrapper(), appServerShim,
      original[4]!,
    ]);

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'not_started', recovery: undefined,
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.receipts.latestForPane('%1')).toBeNull();
  });

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
      code: 'not_started', recovery: undefined,
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

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started', recovery: undefined });
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
      code: 'not_started', recovery: undefined,
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it('does not signal the TUI if the direct Handmux wrapper generation changes before SIGTERM', async () => {
    const h = makeHarness();
    h.inspectForegroundGroupFresh
      .mockResolvedValueOnce([tui(), wrapper(), appServer()])
      .mockResolvedValue([tui(), wrapper({ startedAt: 201 }), appServer()]);

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started', recovery: undefined });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it('removes the pending receipt when Codex exits independently before any stop signal', async () => {
    const h = makeHarness();
    h.inspectForegroundGroupFresh.mockImplementation(async () => {
      if (h.inspectForegroundGroupFresh.mock.calls.length === 2) {
        h.setIdentity(null);
        h.setGroup([]);
        h.setApp({ managed: false, threadId: null });
      }
      return h.group();
    });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({
      code: 'not_started', recovery: undefined,
    });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.receipts.latestForPane('%1')).toBeNull();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it.each([
    ['tmux epoch', { epoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['pane identity', { pane: { ...pane(), windowId: '@2' } }],
  ])('does not signal after the %s changes before the stop boundary', async (_label, changes) => {
    const h = makeHarness();
    if ('epoch' in changes) h.paneEpoch.mockResolvedValueOnce(EPOCH).mockResolvedValue(changes.epoch);
    if ('pane' in changes) h.listPanes.mockResolvedValueOnce([pane()]).mockResolvedValue([changes.pane]);

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started', recovery: undefined });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
  });

  it('clears the receipt and releases delivery when SIGTERM fails and the original TUI remains alive', async () => {
    const h = makeHarness({ terminate: async () => { throw new Error('permission denied'); } });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started', recovery: undefined });
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

  it('releases the live delivery fence when recovery reconciliation discovers readiness', async () => {
    const h = makeHarness({ runPaneCommand: async () => { throw new Error('tmux disconnected'); } });
    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.released).not.toHaveBeenCalled();

    const resumed = tui({ pid: 40, ppid: 50, startedAt: 400,
      commandLine: `/usr/local/bin/codex --remote unix://${SOCKET} --cd /repo resume ${SESSION_ID}` });
    h.setIdentity(resumed);
    h.setGroup([resumed, wrapper({ pid: 50, startedAt: 500 }), appServer({ pid: 51, ppid: 50, startedAt: 501 })]);
    h.setPane(pane('codex'));
    h.setApp({ managed: true, threadId: SESSION_ID });

    await expect(h.controller.recovery('%1')).resolves.toMatchObject({ phase: 'ready' });
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
  });

  it.each(['prepared', 'stopped'] as const)(
    'reconciles a manually resumed session from a %s receipt', async (phase) => {
      const h = makeHarness({
        processIdentity: tui({ pid: 40, ppid: 50, startedAt: 400,
          commandLine: `/usr/local/bin/codex --remote unix://${SOCKET} --cd /repo resume ${SESSION_ID}` }),
        processGroup: [
          tui({ pid: 40, ppid: 50, startedAt: 400,
            commandLine: `/usr/local/bin/codex --remote unix://${SOCKET} --cd /repo resume ${SESSION_ID}` }),
          wrapper({ pid: 50, startedAt: 500 }), appServer({ pid: 51, ppid: 50, startedAt: 501 }),
        ],
        appServerProbeStates: ['exited'],
      });
      const saved = h.receipts.prepare({
        pane: { paneId: '%1', sessionName: 'work', windowId: '@1', tty: '/dev/ttys001', tmuxEpoch: EPOCH },
        process: { tui: {
          pid: 10, ppid: 20, startedAt: 100, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
        }, wrapper: {
          pid: 20, ppid: 2, startedAt: 200, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
        }, appServer: {
          pid: 21, ppid: 20, startedAt: 201, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
        } },
        sessionId: SESSION_ID,
        previousRunId: 'run-1',
      });
      if (phase === 'stopped') h.receipts.transition(saved.operationId, 'prepared', 'stopped');

      await expect(h.controller.recovery('%1')).resolves.toMatchObject({
        operationId: saved.operationId, phase: 'ready', canResume: false,
      });
      expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
    },
  );

  it('rechecks the run lease after the final asynchronous process probe before SIGTERM', async () => {
    const h = makeHarness();
    h.inspectForegroundGroupFresh.mockImplementation(async () => {
      if (h.inspectForegroundGroupFresh.mock.calls.length === 2) h.revokeRun();
      return h.group();
    });

    await expect(h.service.restart(h.run.value)).rejects.toMatchObject({ code: 'not_started', recovery: undefined });
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.released).toHaveBeenCalledOnce();
    expect(h.receipts.isPending('codex', SESSION_ID)).toBe(false);
  });

  it('waits for the original App Server process generation to exit before resuming', async () => {
    let h!: ReturnType<typeof makeHarness>;
    h = makeHarness({
      terminate: async () => {
        h.setIdentity({ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' });
        h.setGroup([{ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' }]);
        h.setPane(pane('zsh'));
        h.setApp({ managed: false, threadId: null });
      },
      appServerProbeStates: ['same', 'same', 'exited'],
    });

    const receipt = await h.service.restart(h.run.value);
    expect(receipt.phase).toBe('ready');
    expect(h.inspectProcessGenerationFresh).toHaveBeenCalledWith(expect.objectContaining({
      pid: 21, startedAt: 201,
    }));
    expect(h.events.filter((event) => event.startsWith('app-server:'))).toContain('app-server:exited');
    const resumeIndex = h.events.indexOf('resume-command');
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(h.events.slice(0, resumeIndex)).toContain('app-server:same');
    expect(h.events.slice(0, resumeIndex)).toContain('app-server:exited');
  });

  it('keeps recovery manual when the old App Server exit cannot be confirmed', async () => {
    const h = makeHarness({
      pane: pane('zsh'),
      managed: false,
      threadId: null,
      processIdentity: { pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' },
      processGroup: [{ pid: 30, ppid: 2, startedAt: 300, tty: '/dev/ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh' }],
      appServerProbeStates: ['unknown'],
    });
    const saved = h.receipts.prepare({
      pane: { paneId: '%1', sessionName: 'work', windowId: '@1', tty: '/dev/ttys001', tmuxEpoch: EPOCH },
      process: { tui: {
        pid: 10, ppid: 20, startedAt: 100, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
      }, wrapper: {
        pid: 20, ppid: 2, startedAt: 200, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
      }, appServer: {
        pid: 21, ppid: 20, startedAt: 201, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
      } },
      sessionId: SESSION_ID,
      previousRunId: 'run-1',
    });
    h.receipts.transition(saved.operationId, 'prepared', 'stopped');

    await expect(h.controller.recover('%1', saved.operationId, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(h.runPaneCommand).not.toHaveBeenCalled();
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
      managed: false, threadId: null, appServerProbeStates: ['exited'] });

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
      h.setAppServerProbe('exited');
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
        appServer: {
          pid: 21, ppid: 20, startedAt: 201, tty: '/dev/ttys001', executable: '/usr/local/bin/codex',
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
    h.setAppServerProbe('exited');
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
      validRecovery: () => true,
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
