import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentConversationActivationService,
  ConversationActivationError,
} from '../src/agent-runtime/conversationActivation.js';
import { createCodexConversationActivationController } from '../src/agents/codexConversationActivation.js';
import { CodexActivationReceiptStore } from '../src/agents/codexActivationReceipt.js';

const lease = (process: { pid: number; startedAt?: number; tty?: string } = {
  pid: 10, startedAt: 100, tty: 'ttys001',
}) => {
  const abort = new AbortController();
  return {
    abort,
    value: {
      ref: { agentId: 'codex', paneId: '%1', runId: 'run-1' },
      signal: abort.signal,
      process,
    },
  };
};

const unmanagedApp = () => ({
  discover: vi.fn(async () => ({ managed: false as const, threadId: null })),
});
const activationProgress = () => ({ recovery: vi.fn() });
const openSession = (cwd = '/repo') => ({
  sessionId: '12345678-1234-1234-1234-123456789abc',
  file: '/home/test/.codex/sessions/2026/09/06/rollout-12345678-1234-1234-1234-123456789abc.jsonl',
  cwd,
  fd: '42',
  device: '1',
  inode: '2',
  command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
});

describe('Conversation activation', () => {
  it('only describes takeover after Codex ownership is authoritatively unmanaged', async () => {
    let commandLine: string | undefined;
    let executable: string | undefined = '/usr/bin/codex';
    const base = {
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: {
        inspectForeground: vi.fn(async () => ({
          pid: 10, startedAt: 100, tty: 'ttys001',
          ...(executable ? { executable } : {}),
          ...(commandLine ? { commandLine } : {}),
        })),
      },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(),
        runPaneCommand: vi.fn(),
      },
      wait: vi.fn(async () => {}),
    };
    let managed: boolean | null = null;
    let threadId: string | null = null;
    const app = { discover: vi.fn(async () => ({ managed, threadId })) };
    const controller = createCodexConversationActivationController({ ...base, app });
    await expect(controller.describe(lease().value)).resolves.toBeNull();

    commandLine = '/usr/bin/codex resume';
    await expect(controller.describe(lease().value)).resolves.toEqual({
      effect: 'replace-process-preserve-session',
    });

    commandLine = '/usr/bin/codex --remote unix:///home/test/.handmux/codex-app/1.sock';
    await expect(controller.describe(lease().value)).resolves.toBeNull();

    managed = true;
    threadId = 'thread-1';
    await expect(controller.describe(lease().value)).resolves.toBeNull();

    managed = false;
    threadId = null;
    await expect(controller.describe(lease().value)).resolves.toBeNull();

    commandLine = '/usr/bin/codex resume';
    await expect(controller.describe(lease().value)).resolves.toEqual({
      effect: 'replace-process-preserve-session',
    });

    await expect(controller.describe(lease({
      pid: 11, startedAt: 200, tty: 'ttys001',
    }).value)).resolves.toBeNull();
    await expect(controller.describe(lease({ pid: 10 }).value)).resolves.toBeNull();
    executable = undefined;
    await expect(controller.describe(lease().value)).resolves.toBeNull();
  });

  it('activates a native Codex when only a stale App Server socket makes ownership unknown', async () => {
    const original = {
      pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      commandLine: '/usr/bin/codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const shell = {
      pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh',
    };
    let identity = original;
    let currentCommand = 'codex';
    const sendKey = vi.fn(async () => {
      identity = shell;
      currentCommand = 'zsh';
    });
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: { discover: vi.fn(async () => ({ managed: null })) },
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand, sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey, output: vi.fn(() => null), close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });

    await expect(controller.describe(lease().value)).resolves.toEqual({
      effect: 'replace-process-preserve-session',
    });
    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).resolves.toMatchObject({ recovery: { sessionId: openSession().sessionId } });
    expect(sendKey).toHaveBeenCalledOnce();
    expect(runPaneCommand).toHaveBeenCalledWith('%1', openSession().command);
  });

  it('fails closed when Codex ownership discovery returns no result', async () => {
    const original = {
      pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      commandLine: '/usr/bin/codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const inspectOpenSession = vi.fn(async () => openSession());
    const openOutputCapture = vi.fn();
    const controller = createCodexConversationActivationController({
      app: { discover: vi.fn(async () => undefined) },
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => original) },
      commands: { inspectOpenSession, openOutputCapture, runPaneCommand: vi.fn() },
    });

    await expect(controller.describe(lease().value)).resolves.toBeNull();
    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).rejects.toThrow(/run changed before/);
    expect(inspectOpenSession).not.toHaveBeenCalled();
    expect(openOutputCapture).not.toHaveBeenCalled();
  });

  it('bounds activation, aborts the controller operation, and releases the pane/run lock', async () => {
    const signals: AbortSignal[] = [];
    const activate = vi.fn(async (_run, signal: AbortSignal) => {
      signals.push(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate,
    } }, { timeoutMs: 5 });
    const run = lease().value;
    await expect(service.activate(run)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.activate(run)).rejects.toMatchObject({ recovery: undefined });
    expect(signals[0]?.aborted).toBe(true);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('keeps reported recovery when the controller hangs until the hard timeout', async () => {
    const recovery = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate: vi.fn(async (_run, _signal, progress) => {
        progress.recovery(recovery);
        await new Promise<void>(() => {});
      }),
    } }, { timeoutMs: 5 });
    await expect(service.activate(lease().value)).rejects.toMatchObject({
      code: 'unavailable', recovery,
    });
  });

  it('rejects malformed recovery progress without returning it', async () => {
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate: vi.fn(async (_run, _signal, progress) => {
        (progress.recovery as (value: unknown) => void)({
          kind: 'codex_resume',
          sessionId: 'not-a-session',
          command: 'handmux codex resume not-a-session',
        });
      }),
    } });
    await expect(service.activate(lease().value)).rejects.toMatchObject({
      code: 'contract_violation', recovery: undefined,
    });
  });

  it('validates recovery receipts and recover results returned by controllers', async () => {
    const recovery = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const changed = {
      kind: 'codex_resume' as const,
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      command: 'handmux codex resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
    const controller = {
      apiVersion: 1 as const,
      describe: vi.fn(async () => null),
      activate: vi.fn(async () => {}),
      recovery: vi.fn(async () => ({
        operationId: 'bad', recovery, phase: 'prepared' as const,
        state: 'current' as const, canResume: true,
      })),
      recover: vi.fn(async (_paneId: string, _operationId: string, _signal: AbortSignal,
        progress: { recovery(value: typeof recovery): void }) => {
        progress.recovery(recovery);
        return { recovery: changed };
      }),
    };
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).rejects.toMatchObject({ code: 'contract_violation' });
    await expect(service.recover('%1', 'a'.repeat(64)))
      .rejects.toMatchObject({ code: 'contract_violation' });
  });

  it('rejects recovery when controller progress changes after its first value', async () => {
    const first = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const changed = {
      kind: 'codex_resume' as const,
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      command: 'handmux codex resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => null),
      activate: vi.fn(async () => {}),
      recover: vi.fn(async (_paneId, _operationId, _signal, progress) => {
        progress.recovery(first);
        progress.recovery(changed);
        return { recovery: changed };
      }),
    } });

    await expect(service.recover('%1', 'a'.repeat(64))).rejects.toMatchObject({
      code: 'contract_violation', recovery: undefined,
    });
  });

  it('rejects an error whose recovery differs from the recovery already reported', async () => {
    const first = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const changed = {
      kind: 'codex_resume' as const,
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      command: 'handmux codex resume aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate: vi.fn(async (_run, _signal, progress) => {
        progress.recovery(first);
        throw new ConversationActivationError('resume failed', 'unavailable', changed);
      }),
    } });
    await expect(service.activate(lease().value)).rejects.toMatchObject({
      code: 'contract_violation', recovery: undefined,
    });
  });

  it('deduplicates concurrent activation for the same pane/run and hides provider errors', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const activate = vi.fn(async () => pending);
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate,
    } });
    const run = lease().value;
    const first = service.activate(run);
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    await expect(service.activate(run)).rejects.toMatchObject({ code: 'in_progress' });
    release();
    await first;

    activate.mockRejectedValueOnce(new Error('/Users/private/provider.sock failed'));
    await expect(service.activate(run)).rejects.toEqual(expect.objectContaining({
      code: 'unavailable',
      message: 'Conversation activation could not finish; continue in the terminal or try again',
    }));
  });

  it('rejects a revoked lease before activation starts', async () => {
    const activate = vi.fn(async () => {});
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate,
    } });
    const current = lease();
    current.abort.abort(new Error('replaced'));
    await expect(service.activate(current.value)).rejects.toMatchObject({ code: 'unavailable' });
    expect(activate).not.toHaveBeenCalled();
  });

  it('does not self-cancel when the original run is revoked by the controlled replacement', async () => {
    const current = lease();
    const activate = vi.fn(async (_run, signal: AbortSignal) => {
      current.abort.abort(new Error('original process exited'));
      expect(signal.aborted).toBe(false);
    });
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
      activate,
    } });
    await expect(service.activate(current.value)).resolves.toBeUndefined();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('completes capture and managed resume after C-c revokes the original lease', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const current = lease();
    const runPaneCommand = vi.fn(async () => {});
    const close = vi.fn();
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => {
            identity = shell;
            command = 'zsh';
            current.abort.abort(new Error('original process exited'));
          }),
          output: vi.fn(() => Buffer.from(
            'Token usage: total=10 input=9 output=1\r\n'
            + 'To continue this session, run codex resume, then select '
            + '调查标题 (aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) '
            + '(12345678-1234-1234-1234-123456789abc)\r\n',
          )),
          close,
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    const service = new AgentConversationActivationService({ codex: controller });
    await expect(service.activate(current.value)).resolves.toEqual({
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    });
    expect(runPaneCommand).toHaveBeenCalledOnce();
    expect(runPaneCommand).toHaveBeenCalledWith(
      '%1', 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('waits through incomplete foreground snapshots after C-c until the shell is verified', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const incomplete = { pid: 10, startedAt: 100, tty: 'ttys001' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity: typeof original | typeof incomplete | typeof shell = original;
    let command = 'codex';
    let waits = 0;
    const runPaneCommand = vi.fn(async () => {});
    const outputFrames = [
      Buffer.from('\x1b[2KShutting down...'),
      Buffer.from('\x1b[?25h'),
      Buffer.from('To continue this session, run codex res'),
      Buffer.from('ume 12345678-1234-1234-1234-123456789abc\r\n'),
    ];
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => { identity = incomplete; command = 'zsh'; }),
          output: vi.fn(() => Buffer.concat(outputFrames)),
          outputFrames: vi.fn(() => outputFrames),
          close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {
        waits += 1;
        if (waits === 3) { identity = shell; command = 'zsh'; }
      }),
    });

    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).resolves.toEqual({
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    });
    expect(runPaneCommand).toHaveBeenCalledOnce();
    expect(waits).toBe(3);
  });

  it('fails within the bounded exit wait when foreground identity stays incomplete after C-c', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const incomplete = { pid: 10, startedAt: 100, tty: 'ttys001' };
    let identity: typeof original | typeof incomplete = original;
    const sendKey = vi.fn(async () => { identity = incomplete; });
    const wait = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({ sendKey, output: vi.fn(() => null), close: vi.fn() })),
        runPaneCommand: vi.fn(async () => {}),
      },
      wait,
    });

    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).rejects.toThrow(/Codex did not exit/);
    expect(sendKey).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(10);
  });

  it('returns a copyable recovery command only after a verified session cannot be resumed', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const controller = createCodexConversationActivationController({
      app: { discover: vi.fn(async () => ({ managed: false, threadId: null })) },
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => { identity = shell; command = 'zsh'; }),
          output: vi.fn(() => Buffer.from(
            'Token usage: total=10 input=9 output=1\r\n'
            + 'To continue this session, run codex resume '
            + '12345678-1234-1234-1234-123456789abc\r\n',
          )),
          close: vi.fn(),
        })),
        runPaneCommand: vi.fn(async () => { throw new Error('/private/socket failed'); }),
      },
      wait: vi.fn(async () => {}),
    });
    const service = new AgentConversationActivationService({ codex: controller });
    await expect(service.activate(lease().value)).rejects.toMatchObject({
      code: 'unavailable',
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    });
  });

  it('does not depend on a human-readable exit notice after the session was locked before C-c', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const current = lease();
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => {
            identity = shell;
            command = 'zsh';
            current.abort.abort(new Error('original process exited'));
          }),
          output: vi.fn(() => Buffer.from('Session ID: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\r\n')),
          close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(current.value, new AbortController().signal, activationProgress()))
      .resolves.toMatchObject({ recovery: { sessionId: openSession().sessionId } });
    expect(runPaneCommand).toHaveBeenCalledWith('%1', openSession().command);
  });

  it('persists recovery before C-c and advances its phase with compare-and-set', async () => {
    const original = {
      pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
    };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const order: string[] = [];
    const durable = {
      operationId: 'a'.repeat(64),
      agentId: 'codex' as const,
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: original,
      sessionId: openSession().sessionId,
      command: openSession().command,
      phase: 'prepared' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const receipts = {
      prepare: vi.fn(() => { order.push('prepare'); return durable; }),
      transition: vi.fn((_id, _expected, phase) => {
        order.push(phase);
        return { ...durable, phase };
      }),
      clearManaged: vi.fn(() => false),
      latestForPane: vi.fn(() => durable),
      get: vi.fn(() => durable),
    };
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        paneEpoch: vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => {
            order.push('C-c');
            identity = shell;
            command = 'zsh';
          }),
          output: vi.fn(() => null),
          close: vi.fn(),
        })),
        runPaneCommand: vi.fn(async () => { order.push('resume'); }),
      },
      receipts,
      wait: vi.fn(async () => {}),
    });

    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).resolves.toMatchObject({ recovery: { sessionId: openSession().sessionId } });
    expect(order).toEqual(['prepare', 'C-c', 'interrupted', 'resuming', 'resume']);
    expect(receipts.prepare).toHaveBeenCalledWith(expect.objectContaining({
      pane: expect.objectContaining({ tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      process: original,
      sessionId: openSession().sessionId,
    }));
  });

  it('clears a durable receipt when discovery proves the same session is managed', async () => {
    const receipts = {
      prepare: vi.fn(), transition: vi.fn(), clearManaged: vi.fn(() => true),
      latestForPane: vi.fn(() => null), get: vi.fn(() => null),
    };
    const controller = createCodexConversationActivationController({
      app: { discover: vi.fn(async () => ({ managed: true, threadId: openSession().sessionId })) },
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => ({
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
        commandLine: '/usr/bin/codex --remote unix:///tmp/codex.sock',
      })) },
      commands: {
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(),
        runPaneCommand: vi.fn(),
      },
      receipts,
    });

    await expect(controller.describe(lease().value)).resolves.toBeNull();
    expect(receipts.clearManaged).toHaveBeenCalledWith('%1', openSession().sessionId);
  });

  it('reloads an interrupted receipt after restart and recovers it at most once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    const file = path.join(directory, 'receipts.json');
    const firstStore = new CodexActivationReceiptStore(file, { now: () => 1_000 });
    const prepared = firstStore.prepare({
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: {
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      },
      sessionId: openSession().sessionId,
      command: openSession().command,
    });
    firstStore.transition(prepared.operationId, 'prepared', 'interrupted');
    const restartedStore = new CodexActivationReceiptStore(file, { now: () => 2_000 });
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'zsh', sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => ({
        pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh',
      })) },
      commands: {
        paneEpoch: vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(),
        runPaneCommand,
      },
      receipts: restartedStore,
    });
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).resolves.toMatchObject({
      operationId: prepared.operationId,
      state: 'current',
      phase: 'interrupted',
      canResume: true,
    });
    await expect(service.recover('%1', prepared.operationId)).resolves.toMatchObject({
      recovery: { sessionId: openSession().sessionId },
    });
    await expect(service.recover('%1', prepared.operationId)).resolves.toMatchObject({
      recovery: { sessionId: openSession().sessionId },
    });
    expect(runPaneCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery lookup read-only while the exact original Codex is still running', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'));
    const receipt = store.prepare({
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: {
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      },
      sessionId: openSession().sessionId,
      command: openSession().command,
    });
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => ({
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      })) },
      commands: {
        paneEpoch: vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(),
        runPaneCommand,
      },
      receipts: store,
    });
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).resolves.toMatchObject({
      operationId: receipt.operationId, state: 'current', phase: 'prepared', canResume: false,
    });
    expect(store.get(receipt.operationId)).not.toBeNull();
    await expect(service.recover('%1', receipt.operationId)).rejects.toMatchObject({
      code: 'unavailable', recovery: { command: openSession().command },
    });
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['the shell already returned', {
      pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh',
    }, 'zsh', true],
    ['a different Codex process replaced it', {
      pid: 11, startedAt: 200, tty: 'ttys001', executable: '/usr/bin/codex',
    }, 'codex', false],
  ])('keeps a prepared receipt when %s', async (_label, identity, currentCommand, canResume) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'));
    const receipt = store.prepare({
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: {
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      },
      sessionId: openSession().sessionId,
      command: openSession().command,
    });
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand, sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        paneEpoch: vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(),
        runPaneCommand: vi.fn(),
      },
      receipts: store,
    });
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).resolves.toMatchObject({
      operationId: receipt.operationId, phase: 'prepared', canResume,
    });
    expect(store.get(receipt.operationId)).not.toBeNull();
  });

  it.each([
    ['a non-shell executable', { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/usr/bin/python' }],
    ['a missing executable', { pid: 20, startedAt: 200, tty: 'ttys001' }],
  ])('does not resume when tmux says zsh but foreground identity has %s', async (_label, identity) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'));
    const receipt = store.prepare({
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: {
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      },
      sessionId: openSession().sessionId,
      command: openSession().command,
    });
    store.transition(receipt.operationId, 'prepared', 'interrupted');
    const runPaneCommand = vi.fn();
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'zsh', sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        paneEpoch: vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(),
        runPaneCommand,
      },
      receipts: store,
    });
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).resolves.toMatchObject({ canResume: false });
    await expect(service.recover('%1', receipt.operationId)).rejects.toMatchObject({
      code: 'unavailable', recovery: { command: openSession().command },
    });
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it('exposes a reused-pane receipt for copy only and never injects its command', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'));
    const receipt = store.prepare({
      pane: {
        paneId: '%1', sessionName: 's', windowId: '@1',
        tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      process: {
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      },
      sessionId: openSession().sessionId,
      command: openSession().command,
    });
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'zsh', sessionName: 'new', windowId: '@9', windowName: 'w',
          tty: 'ttys009',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => ({
        pid: 99, startedAt: 900, tty: 'ttys009', executable: '/bin/zsh',
      })) },
      commands: {
        paneEpoch: vi.fn(async () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(),
        runPaneCommand,
      },
      receipts: store,
    });
    const service = new AgentConversationActivationService({ codex: controller });

    await expect(service.recovery('%1')).resolves.toMatchObject({
      state: 'stale', canResume: false, recovery: { command: openSession().command },
    });
    await expect(service.recover('%1', receipt.operationId)).rejects.toMatchObject({
      code: 'unavailable', recovery: { command: openSession().command },
    });
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it('ignores unrelated UUIDs printed after exit and resumes only the pre-C-c FD session', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const current = lease();
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => {
            identity = shell;
            command = 'zsh';
            current.abort.abort(new Error('original process exited'));
          }),
          output: vi.fn(() => Buffer.from(
            'shell output (12345678-1234-1234-1234-123456789abc)\r\n',
          )),
          close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(current.value, new AbortController().signal, activationProgress()))
      .resolves.toMatchObject({ recovery: { sessionId: openSession().sessionId } });
    expect(runPaneCommand).toHaveBeenCalledWith('%1', openSession().command);
  });

  it('fails closed before C-c when the foreground PID has no unique root rollout', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => null),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => { identity = shell; command = 'zsh'; }),
          output: vi.fn(() => Buffer.from(
            'Token usage: total=10 input=9 output=1\r\n'
            + 'To continue this session, run codex resume '
            + '12345678-1234-1234-1234-123456789abc\r\n',
          )),
          close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });

    await expect(controller.activate(lease().value, new AbortController().signal, activationProgress()))
      .rejects.toThrow(/could not be identified safely/);
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it('uses the lease fingerprint to reject a different unmanaged native Codex before C-c', async () => {
    const replacement = {
      pid: 11,
      startedAt: 200,
      tty: 'ttys001',
      executable: '/usr/bin/codex',
      commandLine: '/usr/bin/codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const openOutputCapture = vi.fn();
    const inspectOpenSession = vi.fn(async () => openSession());
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => replacement) },
      commands: {
        inspectOpenSession,
        openOutputCapture,
        runPaneCommand: vi.fn(),
      },
    });

    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).rejects.toThrow(/run changed before/);
    expect(inspectOpenSession).not.toHaveBeenCalled();
    expect(openOutputCapture).not.toHaveBeenCalled();
  });

  it('never interrupts a managed replacement when an old sessionless lease is reused', async () => {
    const original = {
      pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      commandLine: '/usr/bin/codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const shell = {
      pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh', commandLine: '/bin/zsh',
    };
    const managed = {
      pid: 30, startedAt: 300, tty: 'ttys001', executable: '/usr/bin/codex',
      commandLine: '/usr/bin/codex --remote unix:///tmp/codex.sock',
    };
    let identity = original;
    let currentCommand = 'codex';
    let isManaged = false;
    const sendKey = vi.fn(async () => {
      identity = shell;
      currentCommand = 'zsh';
    });
    const openOutputCapture = vi.fn(async () => ({
      sendKey,
      output: vi.fn(() => null),
      close: vi.fn(),
    }));
    const controller = createCodexConversationActivationController({
      app: { discover: vi.fn(async () => ({ managed: isManaged, threadId: null })) },
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand, sessionName: 's', windowId: '@1', windowName: 'w',
          tty: 'ttys001',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture,
        runPaneCommand: vi.fn(async () => {
          identity = managed;
          currentCommand = 'codex';
          isManaged = true;
        }),
      },
      wait: vi.fn(async () => {}),
    });
    const service = new AgentConversationActivationService({ codex: controller });
    const oldLease = lease().value;

    await expect(service.activate(oldLease)).resolves.toMatchObject({
      recovery: { sessionId: openSession().sessionId },
    });
    await expect(service.activate(oldLease)).rejects.toMatchObject({ code: 'unavailable' });
    expect(sendKey).toHaveBeenCalledOnce();
    expect(openOutputCapture).toHaveBeenCalledOnce();
  });

  it('requires a complete stable process fingerprint on a destructive lease', async () => {
    const openOutputCapture = vi.fn();
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => ({
        pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
      })) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture,
        runPaneCommand: vi.fn(),
      },
    });

    await expect(controller.activate(
      lease({ pid: 10 }).value, new AbortController().signal, activationProgress(),
    )).rejects.toThrow(/run identity is incomplete/);
    expect(openOutputCapture).not.toHaveBeenCalled();
  });

  it('rechecks that the same rollout FD is still held immediately before C-c', async () => {
    const original = {
      pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
    };
    const sendKey = vi.fn(async () => {});
    const inspectOpenSession = vi.fn()
      .mockResolvedValueOnce(openSession())
      .mockResolvedValueOnce({ ...openSession(), fd: '99' });
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => original) },
      commands: {
        inspectOpenSession,
        openOutputCapture: vi.fn(async () => ({ sendKey, output: vi.fn(() => null), close: vi.fn() })),
        runPaneCommand: vi.fn(async () => {}),
      },
      wait: vi.fn(async () => {}),
    });

    await expect(controller.activate(lease().value, new AbortController().signal, activationProgress()))
      .rejects.toThrow(/session changed before/);
    expect(inspectOpenSession).toHaveBeenCalledTimes(2);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it.each([
    ['a different Codex process', {
      pid: 11, startedAt: 200, tty: 'ttys001', executable: '/usr/bin/codex',
    }],
    ['another foreground program', {
      pid: 11, startedAt: 200, tty: 'ttys001', executable: '/usr/bin/python',
    }],
  ])('never sends a second interrupt after the original Codex process was replaced by %s', async (
    _label, replacement,
  ) => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    let identity = original;
    const sendKey = vi.fn(async () => { identity = replacement; });
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey,
          output: vi.fn(() => null),
          close: vi.fn(),
        })),
        runPaneCommand: vi.fn(async () => {}),
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(lease().value, new AbortController().signal, activationProgress()))
      .rejects.toThrow(/process changed/);
    expect(sendKey).toHaveBeenCalledOnce();
  });

  it('revalidates the same shell immediately before launching the managed resume', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const firstShell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    const changedShell = { pid: 21, startedAt: 300, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    let shellReads = 0;
    const runPaneCommand = vi.fn(async () => {});
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => {
        if (identity === firstShell && shellReads++ > 0) identity = changedShell;
        return identity;
      }) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => { identity = firstShell; command = 'zsh'; }),
          output: vi.fn(() => Buffer.from('human-readable output is irrelevant\r\n')),
          close: vi.fn(),
        })),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(lease().value, new AbortController().signal, activationProgress()))
      .rejects.toMatchObject({
        code: 'unavailable',
        recovery: {
          command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
        },
      });
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it('closes a control capture when activation is aborted during an unacknowledged interrupt', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const shell = { pid: 20, startedAt: 200, tty: 'ttys001', executable: '/bin/zsh' };
    let identity = original;
    let command = 'codex';
    let rejectSend!: (reason: Error) => void;
    const sendKey = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const close = vi.fn(() => rejectSend(new Error('capture closed')));
    const openOutputCapture = vi.fn()
      .mockResolvedValueOnce({ sendKey, output: vi.fn(() => null), close })
      .mockResolvedValueOnce({
        sendKey: vi.fn(async () => { identity = shell; command = 'zsh'; }),
        output: vi.fn(() => Buffer.from(
          'Token usage: total=10 input=9 output=1\r\n'
          + 'To continue this session, run codex resume 12345678-1234-1234-1234-123456789abc\r\n',
        )),
        close: vi.fn(),
      });
    const controller = createCodexConversationActivationController({
      app: unmanagedApp(),
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        inspectOpenSession: vi.fn(async () => openSession()),
        openOutputCapture,
        runPaneCommand: vi.fn(async () => {}),
      },
      wait: vi.fn(async () => {}),
    });
    const abort = new AbortController();
    const activation = controller.activate(lease().value, abort.signal, activationProgress());
    await vi.waitFor(() => expect(sendKey).toHaveBeenCalledOnce());

    abort.abort(new Error('request timed out'));

    await expect(activation).rejects.toThrow(/capture closed/);
    expect(close).toHaveBeenCalled();

    await expect(controller.activate(
      lease().value, new AbortController().signal, activationProgress(),
    )).resolves.toEqual({
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    });
    expect(openOutputCapture).toHaveBeenCalledTimes(2);
  });

  it('returns a stable unavailable error when descriptor discovery fails', async () => {
    const service = new AgentConversationActivationService({ codex: {
      apiVersion: 1,
      describe: vi.fn(async () => { throw new Error('/private/path'); }),
      activate: vi.fn(async () => {}),
    } });
    await expect(service.describe(lease().value)).rejects.toEqual(expect.objectContaining<Partial<ConversationActivationError>>({
      code: 'unavailable', message: 'Conversation activation is temporarily unavailable',
    }));
  });
});
