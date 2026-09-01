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

describe('Conversation activation', () => {
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
    expect(signals[0]?.aborted).toBe(true);
    await expect(service.activate(run)).rejects.toMatchObject({ code: 'unavailable' });
    expect(activate).toHaveBeenCalledTimes(2);
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
    const controller = createCodexConversationActivationController({
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        sendKey: vi.fn(async () => {
          identity = shell;
          command = 'zsh';
          current.abort.abort(new Error('original process exited'));
        }),
        capturePlain: vi.fn(async () => (
          'To continue this session, run codex resume 12345678-1234-1234-1234-123456789abc'
        )),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    const service = new AgentConversationActivationService({ codex: controller });
    await expect(service.activate(current.value)).resolves.toBeUndefined();
    expect(runPaneCommand).toHaveBeenCalledOnce();
  });

  it('never sends a second interrupt after the original Codex process was replaced', async () => {
    const original = { pid: 10, startedAt: 100, tty: 'ttys001', executable: '/usr/bin/codex' };
    const replacement = { pid: 11, startedAt: 200, tty: 'ttys001', executable: '/usr/bin/codex' };
    let identity = original;
    const sendKey = vi.fn(async () => { identity = replacement; });
    const controller = createCodexConversationActivationController({
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: 'codex', sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        sendKey,
        capturePlain: vi.fn(async () => ''),
        runPaneCommand: vi.fn(async () => {}),
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(lease().value, new AbortController().signal))
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
      panes: {
        list: vi.fn(async () => [{
          paneId: '%1', currentCommand: command, sessionName: 's', windowId: '@1', windowName: 'w',
        }]),
        subscribe: vi.fn(() => () => {}),
      },
      process: { inspectForeground: vi.fn(async () => identity) },
      commands: {
        sendKey: vi.fn(async () => { identity = firstShell; command = 'zsh'; }),
        capturePlain: vi.fn(async () => {
          identity = changedShell;
          return 'To continue this session, run codex resume 12345678-1234-1234-1234-123456789abc';
        }),
        runPaneCommand,
      },
      wait: vi.fn(async () => {}),
    });
    await expect(controller.activate(lease().value, new AbortController().signal))
      .rejects.toThrow(/shell changed/);
    expect(runPaneCommand).not.toHaveBeenCalled();
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
