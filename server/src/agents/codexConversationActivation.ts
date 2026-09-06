import type { ReadonlyPaneSource, ProcessContext } from '../agent-runtime/adapter.js';
import type { ForegroundProcessIdentity } from '../agent-runtime/adapter.js';
import type { AgentConversationActivationControllerV1 } from '../agent-runtime/conversationActivation.js';
import { ConversationActivationError } from '../agent-runtime/conversationActivation.js';
import { serializePaneInput } from '../paneInput.js';
import { codex, codexExitOutputFramesSessionId, codexExitOutputSessionId } from './codex.js';

export interface CodexActivationOutputCapture {
  sendKey(key: string): Promise<void>;
  output(): Buffer | null;
  outputFrames?(): readonly Buffer[] | null;
  close(): void;
}

export interface CodexActivationCommands {
  openOutputCapture(pane: string): Promise<CodexActivationOutputCapture>;
  paneCurrentPath(pane: string): Promise<string>;
  sessionCwd(sessionId: string): Promise<string | null>;
  runPaneCommand(pane: string, command: string): Promise<unknown>;
}

export interface CodexActivationApp {
  discover(pane: string): Promise<{
    managed: boolean | null;
    threadId?: string | null;
  } | null | undefined>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh']);
const REMOTE_ARG_RE = /(?:^|\s)--remote(?:=|\s|$)/;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Activation cancelled');
}

export function createCodexConversationActivationController({
  app,
  panes,
  process,
  commands,
  wait = pause,
}: {
  app: CodexActivationApp;
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  commands: CodexActivationCommands;
  wait?: (ms: number) => Promise<void>;
}): AgentConversationActivationControllerV1 {
  if (!app || typeof app.discover !== 'function' || !panes || !process || !commands
    || typeof commands.openOutputCapture !== 'function'
    || typeof commands.paneCurrentPath !== 'function' || typeof commands.sessionCwd !== 'function'
    || typeof commands.runPaneCommand !== 'function') {
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
  const processAfterInterrupt = async (paneId: string): Promise<{
    kind: 'codex' | 'shell' | 'other' | 'unknown';
    identity: ForegroundProcessIdentity | null;
  } | null> => {
    const current = await pane(paneId);
    if (!current) return null;
    const identity = await process.inspectForeground(current);
    if (!identity) return { kind: 'unknown', identity: null };
    // During Codex shutdown, tmux/ps can briefly expose the old pane command without an executable.
    // Only this bounded post-interrupt wait treats that incomplete snapshot as transient.
    if (!identity.executable) return { kind: 'unknown', identity };
    const executable = identity.executable.split('/').pop()?.toLowerCase();
    if (executable && SHELLS.has(executable)) return { kind: 'shell', identity };
    const isCodex = await codex.process.verify(current, { inspectForeground: async () => identity });
    return { kind: isCodex ? 'codex' : 'other', identity };
  };
  const sameProcess = (first: ForegroundProcessIdentity, second: ForegroundProcessIdentity): boolean => (
    first.pid === second.pid
    && (first.startedAt === undefined || second.startedAt === first.startedAt)
    && (first.tty === undefined || second.tty === first.tty)
  );
  return {
    apiVersion: 1,
    async describe(run) {
      if (run.ref.sessionId || run.signal.aborted) return null;
      const processIdentity = await codexIdentity(run.ref.paneId);
      if (!processIdentity) return null;
      if (processIdentity.commandLine && REMOTE_ARG_RE.test(processIdentity.commandLine)) return null;
      const ownership = await app.discover(run.ref.paneId);
      if (ownership?.managed !== false) {
        // A dead App Server can leave its socket file behind. A complete native Codex command line
        // without --remote is authoritative unmanaged evidence; a managed/unknown command line stays
        // fail-closed so a restarting Handmux App Server can never be replaced.
        if (ownership?.managed !== null || !processIdentity.commandLine) return null;
      }
      return { effect: 'replace-process-preserve-session' };
    },
    async activate(run, signal, progress) {
      return await serializePaneInput(run.ref.paneId, async () => {
        const paneId = run.ref.paneId;
        throwIfAborted(signal);
        const original = !run.ref.sessionId && !run.signal.aborted
          ? await codexIdentity(paneId) : null;
        throwIfAborted(signal);
        if (!original) throw new Error('The Agent run changed before Conversation activation');
        const originalCwd = await commands.paneCurrentPath(paneId);
        throwIfAborted(signal);
        if (!originalCwd) throw new Error('The Agent working directory is unavailable');
        const outputCapture = await commands.openOutputCapture(paneId);
        const abortCapture = (): void => outputCapture.close();
        signal.addEventListener('abort', abortCapture, { once: true });
        try {
          throwIfAborted(signal);
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
            // This exact control-mode connection sends C-c and arms collection synchronously at that
            // command's %end. Output rendered before the interrupt can never satisfy freshness.
            await outputCapture.sendKey('C-c');
            let originalStillVerified = true;
            for (let attempt = 0; attempt < 10; attempt += 1) {
              await wait(500);
              throwIfAborted(signal);
              const current = await processAfterInterrupt(paneId);
              if (!current) throw new Error('The pane closed during Conversation activation');
              if (current.kind === 'unknown') {
                originalStillVerified = false;
                continue;
              }
              if (current.kind === 'shell') {
                shell = current.identity;
                exited = true;
                break;
              }
              if (current.kind === 'other' || !current.identity
                || !sameProcess(original, current.identity)) {
                throw new Error('The Agent process changed during Conversation activation');
              }
              originalStillVerified = true;
            }
            // Never send another interrupt unless the last complete snapshot still proves the original Codex.
            if (!originalStillVerified) break;
          }
          if (!exited || !shell) throw new Error('Codex did not exit; close any open panel in the terminal and try again');
          let sessionId: string | null = null;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            throwIfAborted(signal);
            const beforeRead = await shellIdentity(paneId);
            if (!beforeRead || !sameProcess(shell, beforeRead)) {
              throw new Error('The pane shell changed during Conversation activation');
            }
            const frames = outputCapture.outputFrames?.();
            let candidate: string | null = null;
            if (frames === undefined) {
              const current = outputCapture.output();
              if (current !== null) candidate = codexExitOutputSessionId(current.toString('utf8'));
            } else if (frames !== null) {
              candidate = codexExitOutputFramesSessionId(frames);
            }
            if (codex.sessions.isId(candidate)) { sessionId = candidate; break; }
            await wait(100);
          }
          if (!sessionId) throw new Error('Codex did not expose a resumable session; continue in the terminal');
          if (await commands.sessionCwd(sessionId) !== originalCwd) {
            throw new Error('Codex did not expose the current pane session; continue in the terminal');
          }
          const resume = codex.sessions.managedResumeCmd?.(sessionId);
          if (!resume) throw new Error('Managed Conversation activation is unavailable');
          const recovery = { kind: 'codex_resume' as const, sessionId, command: resume };
          progress.recovery(recovery);
          try {
            throwIfAborted(signal);
            const beforeResume = await shellIdentity(paneId);
            if (!beforeResume || !sameProcess(shell, beforeResume)) {
              throw new Error('The pane shell changed before Conversation activation');
            }
            throwIfAborted(signal);
            await commands.runPaneCommand(paneId, resume);
          } catch (error) {
            if (error instanceof ConversationActivationError) throw error;
            throw new ConversationActivationError(
              'Conversation activation could not finish; use the recovery command or continue in the terminal',
              'unavailable',
              recovery,
            );
          }
          return { recovery };
        } finally {
          signal.removeEventListener('abort', abortCapture);
          outputCapture.close();
        }
      });
    },
  };
}
