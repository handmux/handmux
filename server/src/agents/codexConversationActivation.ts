import type { LivePane, ReadonlyPaneSource, ProcessContext } from '../agent-runtime/adapter.js';
import type { ForegroundProcessIdentity } from '../agent-runtime/adapter.js';
import type { AgentConversationActivationControllerV1 } from '../agent-runtime/conversationActivation.js';
import type { ConversationActivationRecoveryReceipt } from '../agent-runtime/conversationActivation.js';
import { ConversationActivationError } from '../agent-runtime/conversationActivation.js';
import { serializePaneInput } from '../paneInput.js';
import { codex } from './codex.js';
import { sameCodexOpenSession } from './codexOpenSession.js';
import type { CodexOpenSession } from './codexOpenSession.js';
import type {
  CodexActivationReceipt,
  CodexActivationReceiptStore,
} from './codexActivationReceipt.js';

export interface CodexActivationOutputCapture {
  sendKey(key: string): Promise<void>;
  output(): Buffer | null;
  outputFrames?(): readonly Buffer[] | null;
  close(): void;
}

export interface CodexActivationCommands {
  openOutputCapture(pane: string): Promise<CodexActivationOutputCapture>;
  paneEpoch?(pane: string): Promise<string | null>;
  inspectOpenSession(pid: number): Promise<CodexOpenSession | null>;
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
  receipts,
  wait = pause,
}: {
  app: CodexActivationApp;
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  commands: CodexActivationCommands;
  receipts?: Pick<
    CodexActivationReceiptStore,
    'prepare' | 'transition' | 'clearManaged' | 'latestForPane' | 'get'
  >;
  wait?: (ms: number) => Promise<void>;
}): AgentConversationActivationControllerV1 {
  if (!app || typeof app.discover !== 'function' || !panes || !process || !commands
    || typeof commands.openOutputCapture !== 'function'
    || typeof commands.inspectOpenSession !== 'function'
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
  const nativeCodexTakeoverIdentity = async (
    paneId: string,
  ): Promise<ForegroundProcessIdentity | null> => {
    const identity = await codexIdentity(paneId);
    if (!identity) return null;
    const ownership = await app.discover(paneId);
    if (ownership?.managed === true && ownership.threadId) {
      receipts?.clearManaged(paneId, ownership.threadId);
    }
    if (identity.commandLine && REMOTE_ARG_RE.test(identity.commandLine)) return null;
    if (ownership?.managed === false) return identity;
    // A dead App Server can leave its socket file behind. Only an explicit unknown ownership result
    // plus a complete native command line is authoritative enough to treat that process as native.
    return ownership?.managed === null && identity.commandLine ? identity : null;
  };
  const shellIdentity = async (paneId: string): Promise<ForegroundProcessIdentity | null> => {
    const current = await pane(paneId);
    if (!current) return null;
    const identity = await process.inspectForeground(current);
    if (!identity) return null;
    const executable = identity.executable?.split('/').pop()?.toLowerCase();
    return executable && SHELLS.has(executable) ? identity : null;
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
    && first.startedAt !== undefined && second.startedAt === first.startedAt
    && first.tty !== undefined && second.tty === first.tty
    && first.executable !== undefined && second.executable === first.executable
  );
  const sameRunProcess = (
    locked: { readonly pid: number; readonly startedAt?: number; readonly tty?: string },
    current: ForegroundProcessIdentity,
  ): boolean => (
    locked.pid === current.pid
    && locked.startedAt !== undefined && current.startedAt === locked.startedAt
    && locked.tty !== undefined && current.tty === locked.tty
  );
  const samePane = (first: LivePane, second: LivePane): boolean => (
    first.paneId === second.paneId && first.sessionName === second.sessionName
    && first.windowId === second.windowId && first.tty === second.tty
  );
  const receiptRecovery = (receipt: CodexActivationReceipt) => ({
    kind: 'codex_resume' as const,
    sessionId: receipt.sessionId,
    command: receipt.command,
  });
  const recoveryReceipt = async (
    paneId: string,
    expectedOperationId?: string,
  ): Promise<{ receipt: CodexActivationReceipt; view: ConversationActivationRecoveryReceipt } | null> => {
    const receipt = expectedOperationId
      ? receipts?.get(expectedOperationId) : receipts?.latestForPane(paneId);
    if (!receipt || receipt.pane.paneId !== paneId) return null;
    const ownership = await app.discover(paneId);
    if (ownership?.managed === true && ownership.threadId === receipt.sessionId) {
      receipts?.clearManaged(paneId, receipt.sessionId);
      return null;
    }
    const currentPane = await pane(paneId);
    const currentEpoch = await commands.paneEpoch?.(paneId);
    const current = !!currentPane
      && currentPane.paneId === receipt.pane.paneId
      && currentPane.sessionName === receipt.pane.sessionName
      && currentPane.windowId === receipt.pane.windowId
      && !!currentEpoch && currentEpoch === receipt.pane.tmuxEpoch;
    let canResume = false;
    if (current && receipt.phase !== 'resuming') {
      const identity = await shellIdentity(paneId);
      canResume = identity !== null;
    }
    return {
      receipt,
      view: {
        operationId: receipt.operationId,
        recovery: receiptRecovery(receipt),
        phase: receipt.phase,
        state: current ? 'current' : 'stale',
        canResume,
      },
    };
  };
  return {
    apiVersion: 1,
    async recovery(paneId) {
      return (await recoveryReceipt(paneId))?.view ?? null;
    },
    async recover(paneId, operationId, signal, progress) {
      return await serializePaneInput(paneId, async () => {
        throwIfAborted(signal);
        const resolved = await recoveryReceipt(paneId, operationId);
        if (!resolved) throw new ConversationActivationError(
          'Conversation recovery is no longer available',
          'unavailable',
        );
        const recovery = receiptRecovery(resolved.receipt);
        progress.recovery(recovery);
        if (resolved.view.state !== 'current' || !resolved.view.canResume) {
          if (resolved.receipt.phase === 'resuming') return { recovery };
          throw new ConversationActivationError(
            'The original pane is no longer safe to resume; copy the recovery command instead',
            'unavailable',
            recovery,
          );
        }
        const claimed = receipts?.transition(
          operationId,
          ['prepared', 'interrupted'],
          'resuming',
        );
        if (!claimed) throw new ConversationActivationError(
          'Conversation recovery is unavailable',
          'unavailable',
          recovery,
        );
        throwIfAborted(signal);
        const rechecked = await recoveryReceipt(paneId, operationId);
        if (!rechecked || rechecked.view.state !== 'current') {
          throw new ConversationActivationError(
            'The pane changed before Conversation recovery; copy the recovery command instead',
            'unavailable',
            recovery,
          );
        }
        const shell = await shellIdentity(paneId);
        if (!shell) throw new ConversationActivationError(
          'The pane shell changed before Conversation recovery; copy the recovery command instead',
          'unavailable',
          recovery,
        );
        // The service can time out while either asynchronous recheck above is still pending.
        // Revalidate cancellation at the side-effect boundary, not only before the rechecks.
        throwIfAborted(signal);
        await commands.runPaneCommand(paneId, recovery.command);
        return { recovery };
      });
    },
    async describe(run) {
      if (run.ref.sessionId || run.signal.aborted) return null;
      const lockedProcess = run.process;
      if (!lockedProcess || lockedProcess.startedAt === undefined || !lockedProcess.tty) return null;
      let processIdentity: ForegroundProcessIdentity | null;
      try {
        processIdentity = await nativeCodexTakeoverIdentity(run.ref.paneId);
      } catch {
        return null;
      }
      if (!processIdentity || !processIdentity.executable
        || !sameRunProcess(lockedProcess, processIdentity)) return null;
      if (!await commands.inspectOpenSession(processIdentity.pid)) return null;
      return { effect: 'replace-process-preserve-session' };
    },
    async activate(run, signal, progress) {
      return await serializePaneInput(run.ref.paneId, async () => {
        const paneId = run.ref.paneId;
        throwIfAborted(signal);
        const originalPane = await pane(paneId);
        if (!originalPane) throw new Error('The pane closed before Conversation activation');
        const lockedProcess = run.process;
        if (!lockedProcess || lockedProcess.startedAt === undefined || !lockedProcess.tty) {
          throw new Error('The Agent run identity is incomplete; continue in the terminal');
        }
        const original = !run.ref.sessionId && !run.signal.aborted
          ? await nativeCodexTakeoverIdentity(paneId) : null;
        throwIfAborted(signal);
        if (!original || !sameRunProcess(lockedProcess, original)) {
          throw new Error('The Agent run changed before Conversation activation');
        }
        if (original.startedAt === undefined || !original.tty || !original.executable) {
          throw new Error('The Agent process identity is incomplete; continue in the terminal');
        }
        const lockedSession = await commands.inspectOpenSession(original.pid);
        throwIfAborted(signal);
        if (!lockedSession) {
          throw new Error('Codex current session could not be identified safely; continue in the terminal');
        }
        const tmuxEpoch = receipts ? await commands.paneEpoch?.(paneId) : null;
        if (receipts && (!tmuxEpoch || original.startedAt === undefined || !original.tty
          || !original.executable)) {
          throw new Error('The pane identity is incomplete; continue in the terminal');
        }
        const sessionId = lockedSession.sessionId;
        const resume = codex.sessions.managedResumeCmd?.(sessionId);
        if (!resume) throw new Error('Managed Conversation activation is unavailable');
        const recovery = { kind: 'codex_resume' as const, sessionId, command: resume };
        let durable: CodexActivationReceipt | null = null;
        if (receipts && tmuxEpoch && original.startedAt !== undefined && original.tty && original.executable) {
          durable = receipts.prepare({
            pane: {
              paneId,
              sessionName: originalPane.sessionName,
              windowId: originalPane.windowId,
              tmuxEpoch,
            },
            process: {
              pid: original.pid,
              startedAt: original.startedAt,
              tty: original.tty,
              executable: original.executable,
            },
            sessionId,
            command: resume,
          });
        }
        progress.recovery(recovery);
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
            const beforePane = await pane(paneId);
            if (!beforePane || !samePane(originalPane, beforePane)) {
              throw new Error('The pane changed before Conversation activation');
            }
            if (tmuxEpoch && await commands.paneEpoch?.(paneId) !== tmuxEpoch) {
              throw new Error('The tmux server changed before Conversation activation');
            }
            // A previous activation may have returned before Runtime revoked this sessionless lease.
            // Re-read provider ownership at the irreversible boundary so a second client can never
            // interrupt the newly managed replacement through the still-resolvable old run.
            const beforePress = await nativeCodexTakeoverIdentity(paneId);
            if (!beforePress || !sameProcess(original, beforePress)) {
              throw new Error('The Agent process changed before Conversation activation');
            }
            const stillOpen = await commands.inspectOpenSession(original.pid);
            if (!stillOpen || !sameCodexOpenSession(lockedSession, stillOpen)) {
              throw new Error('The Codex session changed before Conversation activation');
            }
            throwIfAborted(signal);
            // This exact control-mode connection sends C-c and arms collection synchronously at that
            // command's %end. Output rendered before the interrupt can never satisfy freshness.
            await outputCapture.sendKey('C-c');
            if (durable) {
              durable = receipts?.transition(
                durable.operationId,
                ['prepared', 'interrupted'],
                'interrupted',
              ) ?? durable;
            }
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
          try {
            throwIfAborted(signal);
            const beforeResume = await shellIdentity(paneId);
            if (!beforeResume || !sameProcess(shell, beforeResume)) {
              throw new Error('The pane shell changed before Conversation activation');
            }
            throwIfAborted(signal);
            if (durable) {
              durable = receipts?.transition(
                durable.operationId,
                ['interrupted', 'resuming'],
                'resuming',
              ) ?? durable;
            }
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
