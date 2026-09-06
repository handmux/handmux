import { describe, expect, it, vi } from 'vitest';
import {
  AgentConversationActivationService,
  ConversationActivationError,
} from '../src/agent-runtime/conversationActivation.js';
import { createCodexConversationActivationController } from '../src/agents/codexConversationActivation.js';

const lease = () => {
  const abort = new AbortController();
  return {
    abort,
    value: { ref: { agentId: 'codex', paneId: '%1', runId: 'run-1' }, signal: abort.signal },
  };
};

const unmanagedApp = () => ({
  discover: vi.fn(async () => ({ managed: false as const, threadId: null })),
});
const activationProgress = () => ({ recovery: vi.fn() });

describe('Conversation activation', () => {
  it('only describes takeover after Codex ownership is authoritatively unmanaged', async () => {
    let commandLine: string | undefined;
    const base = {
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: {
        inspectForeground: vi.fn(async () => ({
          pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex',
          ...(commandLine ? { commandLine } : {}),
        })),
      },
      commands: {
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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

  it('rejects activation when no fresh exit notice follows the interrupt boundary', async () => {
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
      .rejects.toThrow(/did not expose a resumable session/);
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it('fails closed when fresh output contains only an unrelated UUID', async () => {
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
      .rejects.toThrow(/did not expose a resumable session/);
    expect(runPaneCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['the matching rollout is missing', null],
    ['the matching rollout belongs to another cwd', '/other-repo'],
  ])('fails closed when %s', async (_label, resolvedCwd) => {
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => resolvedCwd),
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
      .rejects.toThrow(/current pane session/);
    expect(runPaneCommand).not.toHaveBeenCalled();
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
        openOutputCapture: vi.fn(async () => ({
          sendKey: vi.fn(async () => { identity = firstShell; command = 'zsh'; }),
          output: vi.fn(() => {
            identity = changedShell;
            return Buffer.from('Token usage: total=10 input=9 output=1\r\n'
              + 'To continue this session, run codex resume '
              + '12345678-1234-1234-1234-123456789abc\r\n');
          }),
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
        paneCurrentPath: vi.fn(async () => '/repo'),
        sessionCwd: vi.fn(async () => '/repo'),
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
