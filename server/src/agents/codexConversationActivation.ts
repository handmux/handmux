import type { ReadonlyPaneSource, ProcessContext } from '../agent-runtime/adapter.js';
import type { ForegroundProcessIdentity } from '../agent-runtime/adapter.js';
import type { AgentConversationActivationControllerV1 } from '../agent-runtime/conversationActivation.js';
import { serializePaneInput } from '../paneInput.js';
import { codex, codexExitSessionId } from './codex.js';

export interface CodexActivationCommands {
  sendKey(pane: string, key: string): Promise<unknown>;
  capturePlain(pane: string): Promise<string>;
  runPaneCommand(pane: string, command: string): Promise<unknown>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh']);

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Activation cancelled');
}

export function createCodexConversationActivationController({
  panes,
  process,
  commands,
  wait = pause,
}: {
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  commands: CodexActivationCommands;
  wait?: (ms: number) => Promise<void>;
}): AgentConversationActivationControllerV1 {
  if (!panes || !process || !commands || typeof commands.sendKey !== 'function'
    || typeof commands.capturePlain !== 'function' || typeof commands.runPaneCommand !== 'function') {
    throw new TypeError('Codex Conversation activation requires pane control');
  }
  const pane = async (paneId: string) => (await panes.list()).find((item) => item.paneId === paneId) ?? null;
  const codexIdentity = async (paneId: string): Promise<ForegroundProcessIdentity | null> => {
    const current = await pane(paneId);
    if (!current) return null;
    const identity = await process.inspectForeground(current);
    if (!identity) return null;
    return await codex.process.verify(current, { inspectForeground: async () => identity })
      ? identity : null;
  };
  const shellIdentity = async (paneId: string): Promise<ForegroundProcessIdentity | null> => {
    const current = await pane(paneId);
    if (!current) return null;
    const identity = await process.inspectForeground(current);
    if (!identity) return null;
    const executable = identity.executable?.split('/').pop()?.toLowerCase();
    return SHELLS.has(current.currentCommand.toLowerCase()) || (executable && SHELLS.has(executable))
      ? identity : null;
  };
  const sameProcess = (first: ForegroundProcessIdentity, second: ForegroundProcessIdentity): boolean => (
    first.pid === second.pid
    && (first.startedAt === undefined || second.startedAt === first.startedAt)
    && (first.tty === undefined || second.tty === first.tty)
  );
  return {
    apiVersion: 1,
    async describe(run) {
      if (run.ref.sessionId || run.signal.aborted || !await codexIdentity(run.ref.paneId)) return null;
      return { effect: 'replace-process-preserve-session' };
    },
    async activate(run, signal) {
      await serializePaneInput(run.ref.paneId, async () => {
        const paneId = run.ref.paneId;
        throwIfAborted(signal);
        const original = !run.ref.sessionId && !run.signal.aborted
          ? await codexIdentity(paneId) : null;
        throwIfAborted(signal);
        if (!original) throw new Error('The Agent run changed before Conversation activation');
        // Authorization is bound to the verified run above. Exiting that exact process intentionally revokes
        // its lease, so subsequent checks bind recovery to the shell that replaced it.
        let exited = false;
        let shell: ForegroundProcessIdentity | null = null;
        for (let press = 0; press < 2 && !exited; press += 1) {
          throwIfAborted(signal);
          const beforePress = await codexIdentity(paneId);
          if (!beforePress || !sameProcess(original, beforePress)) {
            throw new Error('The Agent process changed before Conversation activation');
          }
          throwIfAborted(signal);
          await commands.sendKey(paneId, 'C-c');
          for (let attempt = 0; attempt < 10; attempt += 1) {
            await wait(500);
            throwIfAborted(signal);
            if (!await pane(paneId)) throw new Error('The pane closed during Conversation activation');
            const currentIdentity = await codexIdentity(paneId);
            if (!currentIdentity) {
              shell = await shellIdentity(paneId);
              if (!shell) throw new Error('The pane did not return to the expected shell');
              exited = true;
              break;
            }
            if (!sameProcess(original, currentIdentity)) {
              throw new Error('The Agent process changed during Conversation activation');
            }
          }
        }
        if (!exited || !shell) throw new Error('Codex did not exit; close any open panel in the terminal and try again');
        let sessionId: string | null = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          throwIfAborted(signal);
          const beforeCapture = await shellIdentity(paneId);
          if (!beforeCapture || !sameProcess(shell, beforeCapture)) {
            throw new Error('The pane shell changed during Conversation activation');
          }
          try {
            const candidate = codexExitSessionId(await commands.capturePlain(paneId));
            if (codex.sessions.isId(candidate)) { sessionId = candidate; break; }
          } catch { throw new Error('The pane closed during Conversation activation'); }
          await wait(100);
        }
        if (!sessionId) throw new Error('Codex did not expose a resumable session; continue in the terminal');
        const resume = codex.sessions.managedResumeCmd?.(sessionId);
        if (!resume) throw new Error('Managed Conversation activation is unavailable');
        throwIfAborted(signal);
        const beforeResume = await shellIdentity(paneId);
        if (!beforeResume || !sameProcess(shell, beforeResume)) {
          throw new Error('The pane shell changed before Conversation activation');
        }
        throwIfAborted(signal);
        await commands.runPaneCommand(paneId, resume);
      });
    },
  };
}
