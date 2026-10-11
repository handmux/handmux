import crypto from 'node:crypto';
import type { AgentRunLease, AgentRunRef } from '../agent-runtime/run.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
  ReadonlyPaneSource,
} from '../agent-runtime/adapter.js';
import {
  ConversationRestartError,
  type AgentConversationRestartControllerV1,
  type ConversationRestartReceipt,
} from '../agent-runtime/conversationRestart.js';
import { serializePaneInput } from '../paneInput.js';
import { codexAppSocketPath } from '../cli/codexManaged.js';
import { isSessionUuid, normTty } from './scanUtils.js';
import { CodexRestartReceiptStore } from './codexRestartReceipt.js';
import type {
  CodexRestartProcessIdentity,
  CodexRestartReceipt,
  CodexRestartReceiptInput,
} from './codexRestartReceipt.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh']);
const CODEX_EXE_RE = /^codex(?:\.exe)?$/i;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CodexRestartApp {
  discover(pane: string): Promise<{
    managed: boolean | null;
    threadId?: string | null;
  } | null | undefined>;
}

export interface CodexRestartCommands {
  paneEpoch(pane: string): Promise<string | null>;
  runPaneCommand(pane: string, command: string): Promise<unknown>;
  terminate(pid: number, signal: NodeJS.Signals): void | boolean | Promise<void | boolean>;
}

export interface CodexRestartDeliveryFence {
  pauseSessionDelivery(session: { agentId: string; sessionId: string }): Promise<() => void>;
}

export interface CodexConversationRestartControllerOptions {
  app: CodexRestartApp;
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  commands: CodexRestartCommands;
  receipts: CodexRestartReceiptStore;
  pauseSessionDelivery(session: { agentId: string; sessionId: string }): Promise<() => void>;
  resolveRun(ref: AgentRunRef): AgentRunLease | null;
  isRuntimeRunReady(paneId: string, sessionId: string, previousRunId: string): boolean | Promise<boolean>;
  home?: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

interface RestartEvidence {
  pane: LivePane;
  epoch: string;
  tui: ForegroundProcessIdentity;
  wrapper: ForegroundProcessIdentity;
  appServer: ForegroundProcessIdentity;
}

interface RecoveryView extends ConversationRestartReceipt {
  // Keep the public receipt intentionally small; all target identities stay in the private store.
}

class RestartFault extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'stale_run') {
    super(message);
    this.name = 'RestartFault';
  }
}

function commandTokens(identity: ForegroundProcessIdentity): string[] {
  return identity.commandLine?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function executableName(identity: ForegroundProcessIdentity): string {
  return identity.executable?.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

function samePane(first: LivePane, second: LivePane): boolean {
  return first.paneId === second.paneId
    && first.sessionName === second.sessionName
    && first.windowId === second.windowId
    && normTty(first.tty) !== ''
    && normTty(first.tty) === normTty(second.tty);
}

function sameRecordedPane(pane: LivePane, receipt: CodexRestartReceipt): boolean {
  return pane.paneId === receipt.pane.paneId
    && pane.sessionName === receipt.pane.sessionName
    && pane.windowId === receipt.pane.windowId
    && normTty(pane.tty) === normTty(receipt.pane.tty);
}

function sameIdentity(first: ForegroundProcessIdentity, second: ForegroundProcessIdentity): boolean {
  return first.pid === second.pid
    && first.startedAt !== undefined && second.startedAt === first.startedAt
    && first.tty !== undefined && normTty(first.tty) === normTty(second.tty)
    && first.executable !== undefined && second.executable === first.executable
    && first.ppid !== undefined && second.ppid === first.ppid
    && first.commandLine !== undefined && second.commandLine === first.commandLine;
}

function sameRunProcess(locked: AgentRunLease['process'], identity: ForegroundProcessIdentity): boolean {
  return !!locked && locked.pid === identity.pid
    && locked.startedAt !== undefined && locked.startedAt === identity.startedAt
    && !!locked.tty && normTty(locked.tty) === normTty(identity.tty);
}

function sameGeneration(first: CodexRestartProcessIdentity, second: ForegroundProcessIdentity): boolean {
  return first.pid === second.pid
    && first.startedAt === second.startedAt
    && normTty(first.tty) === normTty(second.tty)
    && first.executable === second.executable;
}

function toStoredIdentity(identity: ForegroundProcessIdentity): CodexRestartProcessIdentity | null {
  if (!identity.startedAt || !identity.tty || !identity.executable
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || !Number.isSafeInteger(identity.ppid) || (identity.ppid ?? -1) < 0) return null;
  return {
    pid: identity.pid,
    ppid: identity.ppid!,
    startedAt: identity.startedAt,
    tty: identity.tty,
    executable: identity.executable,
  };
}

function isHandmuxCodexWrapper(identity: ForegroundProcessIdentity): boolean {
  const tokens = commandTokens(identity);
  const scriptIndex = tokens.findIndex((token) => /(?:^|[\\/])handmux(?:\.js)?$/i.test(token));
  return scriptIndex >= 0
    && tokens.slice(scriptIndex + 1).some((token) => token === 'codex')
    && !!identity.startedAt && !!identity.tty && !!identity.executable && !!identity.commandLine;
}

function isCodexTui(identity: ForegroundProcessIdentity, socketPath: string): boolean {
  const tokens = commandTokens(identity);
  return CODEX_EXE_RE.test(executableName(identity))
    && tokens.includes('--remote')
    && tokens.includes(`unix://${socketPath}`)
    && !!identity.startedAt && !!identity.tty && !!identity.executable && !!identity.commandLine;
}

function isCodexAppServer(identity: ForegroundProcessIdentity, socketPath: string): boolean {
  const tokens = commandTokens(identity);
  const listenIndex = tokens.indexOf('--listen');
  return CODEX_EXE_RE.test(executableName(identity))
    && tokens.includes('app-server')
    && listenIndex >= 0 && tokens[listenIndex + 1] === `unix://${socketPath}`
    && !!identity.startedAt && !!identity.tty && !!identity.executable && !!identity.commandLine
    && Number.isSafeInteger(identity.ppid);
}

function recoveryOf(receipt: CodexRestartReceipt) {
  return {
    kind: 'codex_resume' as const,
    sessionId: receipt.sessionId,
    command: receipt.command,
  };
}

function stableRun(run: AgentRunLease, resolveRun: (ref: AgentRunRef) => AgentRunLease | null): boolean {
  return !run.signal.aborted && resolveRun(run.ref) === run;
}

export function createCodexConversationRestartController({
  app,
  panes,
  process,
  commands,
  receipts,
  pauseSessionDelivery,
  resolveRun,
  isRuntimeRunReady,
  home,
  now = Date.now,
  wait = pause,
  pollMs = 250,
  timeoutMs = 45_000,
}: CodexConversationRestartControllerOptions): AgentConversationRestartControllerV1 {
  if (!app || typeof app.discover !== 'function' || !panes || !process
    || typeof process.inspectForegroundFresh !== 'function'
    || typeof process.inspectForegroundGroupFresh !== 'function'
    || typeof process.inspectProcessGenerationFresh !== 'function'
    || !commands || typeof commands.paneEpoch !== 'function'
    || typeof commands.runPaneCommand !== 'function' || typeof commands.terminate !== 'function'
    || !receipts || typeof receipts.prepare !== 'function'
    || typeof pauseSessionDelivery !== 'function' || typeof resolveRun !== 'function'
    || typeof isRuntimeRunReady !== 'function'
    || !Number.isSafeInteger(pollMs) || pollMs < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < pollMs) {
    throw new TypeError('Codex Conversation restart requires fresh process, pane, and runtime controls');
  }

  const socketPath = (paneId: string): string => codexAppSocketPath(paneId, home);
  const deliveryFenceReleases = new Map<string, () => void>();
  const releaseDeliveryFence = (operationId: string): void => {
    const release = deliveryFenceReleases.get(operationId);
    if (!release) return;
    release();
    deliveryFenceReleases.delete(operationId);
  };
  const oldAppServerStatus = async (receipt: CodexRestartReceipt) => {
    if (!receipt.process.appServer) return 'unknown' as const;
    try { return await process.inspectProcessGenerationFresh!(receipt.process.appServer); }
    catch { return 'unknown' as const; }
  };
  const paneFor = async (paneId: string): Promise<LivePane | null> => (
    (await panes.list()).find((candidate) => candidate.paneId === paneId) ?? null
  );
  const freshForeground = async (pane: LivePane): Promise<ForegroundProcessIdentity | null> => (
    process.inspectForegroundFresh!(pane)
  );
  const freshGroup = async (pane: LivePane): Promise<readonly ForegroundProcessIdentity[]> => (
    process.inspectForegroundGroupFresh!(pane)
  );
  const paneAndEpochMatch = async (receipt: CodexRestartReceipt): Promise<LivePane | null> => {
    const current = await paneFor(receipt.pane.paneId);
    if (!current || !sameRecordedPane(current, receipt)) return null;
    const epoch = await commands.paneEpoch(current.paneId);
    return epoch === receipt.pane.tmuxEpoch ? current : null;
  };
  const recoveryShell = async (
    receipt: CodexRestartReceipt,
  ): Promise<{ pane: LivePane; identity: ForegroundProcessIdentity } | null> => {
    const serverStatus = await oldAppServerStatus(receipt);
    if (serverStatus !== 'exited' && serverStatus !== 'replaced') return null;
    const pane = await paneAndEpochMatch(receipt);
    if (!pane) return null;
    const ownership = await app.discover(pane.paneId);
    if (ownership?.managed !== false) return null;
    const [foreground, group] = await Promise.all([freshForeground(pane), freshGroup(pane)]);
    if (!foreground || !SHELLS.has(executableName(foreground))) return null;
    const originalPresent = group.some((identity) => (
      sameGeneration(receipt.process.tui, identity)
      || sameGeneration(receipt.process.wrapper, identity)
    ));
    return originalPresent ? null : { pane, identity: foreground };
  };
  const managedTui = async (pane: LivePane, forSocket: string) => {
    const [foreground, group] = await Promise.all([freshForeground(pane), freshGroup(pane)]);
    if (!foreground) return null;
    const tui = group.find((candidate) => candidate.pid === foreground.pid && isCodexTui(candidate, forSocket));
    if (!tui || !sameIdentity(foreground, tui)) return null;
    const wrapper = group.find((candidate) => candidate.pid === tui.ppid
      && normTty(candidate.tty) === normTty(tui.tty)
      && isHandmuxCodexWrapper(candidate));
    if (!wrapper || !Number.isSafeInteger(wrapper.ppid) || !wrapper.startedAt) return null;
    return { tui, wrapper };
  };
  const inspectEvidence = async (run: AgentRunLease): Promise<RestartEvidence> => {
    const pane = await paneFor(run.ref.paneId);
    if (!pane || pane.paneId !== run.ref.paneId || !normTty(pane.tty)) {
      throw new RestartFault('The original terminal pane is unavailable', 'stale_run');
    }
    const epoch = await commands.paneEpoch(pane.paneId);
    if (!epoch) throw new RestartFault('The terminal pane identity cannot be verified', 'unavailable');
    const ownership = await app.discover(pane.paneId);
    if (ownership?.managed !== true || ownership.threadId !== run.ref.sessionId) {
      throw new RestartFault('The managed Codex session no longer matches this conversation', 'unavailable');
    }
    const identity = await freshForeground(pane);
    const group = await freshGroup(pane);
    if (!identity || !sameRunProcess(run.process, identity)) {
      throw new RestartFault('The Codex process changed; no process was stopped', 'stale_run');
    }
    const target = group.find((candidate) => candidate.pid === identity.pid);
    if (!target || !sameIdentity(identity, target) || !isCodexTui(target, socketPath(pane.paneId))) {
      throw new RestartFault('The foreground Codex TUI cannot be verified as managed', 'unavailable');
    }
    const wrapper = group.find((candidate) => candidate.pid === target.ppid
      && normTty(candidate.tty) === normTty(target.tty)
      && isHandmuxCodexWrapper(candidate));
    if (!wrapper || !wrapper.startedAt || !wrapper.executable || !wrapper.commandLine
      || !Number.isSafeInteger(wrapper.ppid)) {
      throw new RestartFault('The Codex TUI is not a verified child of handmux codex', 'unavailable');
    }
    const server = group.find((candidate) => candidate.ppid === wrapper.pid
      && normTty(candidate.tty) === normTty(wrapper.tty)
      && isCodexAppServer(candidate, socketPath(pane.paneId)));
    if (!server) {
      throw new RestartFault('The managed Codex App Server process cannot be verified', 'unavailable');
    }
    return { pane, epoch, tui: target, wrapper, appServer: server };
  };
  const recordInput = (run: AgentRunLease, evidence: RestartEvidence): CodexRestartReceiptInput => {
    const tui = toStoredIdentity(evidence.tui);
    const wrapper = toStoredIdentity(evidence.wrapper);
    const appServer = toStoredIdentity(evidence.appServer);
    if (!tui || !wrapper || !appServer || !run.ref.sessionId) {
      throw new RestartFault('The Codex process generation is incomplete', 'unavailable');
    }
    return {
      pane: {
        paneId: evidence.pane.paneId,
        sessionName: evidence.pane.sessionName,
        windowId: evidence.pane.windowId,
        tty: evidence.pane.tty!,
        tmuxEpoch: evidence.epoch,
      },
      process: { tui, wrapper, appServer },
      sessionId: run.ref.sessionId,
      previousRunId: run.ref.runId,
    };
  };
  const receiptView = async (
    receipt: CodexRestartReceipt,
    { allowResume = true }: { allowResume?: boolean } = {},
  ): Promise<RecoveryView> => {
    const recovery = recoveryOf(receipt);
    let state: 'current' | 'stale' = 'stale';
    let canResume = false;
    try {
      const currentPane = await paneAndEpochMatch(receipt);
      if (currentPane) {
        state = 'current';
        if (allowResume && receipt.phase !== 'resuming' && receipt.phase !== 'ready') {
          canResume = await recoveryShell(receipt) !== null;
        }
      }
    } catch { state = 'stale'; canResume = false; }
    return {
      operationId: receipt.operationId,
      recovery,
      phase: receipt.phase,
      state,
      canResume,
    };
  };
  const errorWithReceipt = async (
    message: string,
    code: 'unavailable' | 'stale_run',
    receipt: CodexRestartReceipt,
    allowResume = true,
  ): Promise<ConversationRestartError> => new ConversationRestartError(
    message,
    code,
    await receiptView(receipt, { allowResume }),
  );
  const originalStillPresent = async (receipt: CodexRestartReceipt): Promise<boolean> => {
    try {
      const probePane: LivePane = {
        paneId: receipt.pane.paneId,
        sessionName: receipt.pane.sessionName,
        windowId: receipt.pane.windowId,
        windowName: receipt.pane.sessionName,
        currentCommand: 'codex',
        tty: receipt.pane.tty,
      };
      const [ownership, group] = await Promise.all([
        app.discover(receipt.pane.paneId), freshGroup(probePane),
      ]);
      return ownership?.managed === true && ownership.threadId === receipt.sessionId
        && group.some((identity) => sameGeneration(receipt.process.tui, identity));
    } catch { return false; }
  };
  const resumeReady = async (receipt: CodexRestartReceipt): Promise<boolean> => {
    const serverStatus = await oldAppServerStatus(receipt);
    if (serverStatus !== 'exited' && serverStatus !== 'replaced') return false;
    const pane = await paneAndEpochMatch(receipt);
    if (!pane) throw new RestartFault('The original pane was replaced during restart', 'unavailable');
    const ownership = await app.discover(pane.paneId);
    if (ownership?.managed === true && ownership.threadId !== receipt.sessionId) {
      throw new RestartFault('A different Codex session appeared in the original pane', 'unavailable');
    }
    if (ownership?.managed !== true) return false;
    const current = await managedTui(pane, socketPath(pane.paneId));
    if (!current || sameGeneration(receipt.process.tui, current.tui)
      || sameGeneration(receipt.process.wrapper, current.wrapper)) return false;
    return await isRuntimeRunReady(pane.paneId, receipt.sessionId, receipt.previousRunId);
  };
  const preflightRecovery = (
    run: AgentRunLease,
    code: 'unavailable' | 'stale_run',
    message: string,
  ): ConversationRestartError => {
    const sessionId = run.ref.sessionId;
    if (!sessionId || !isSessionUuid(sessionId)) return new ConversationRestartError(message, code);
    const operationId = crypto.createHash('sha256').update(JSON.stringify({
      agentId: run.ref.agentId,
      paneId: run.ref.paneId,
      runId: run.ref.runId,
      sessionId,
      preflight: true,
    })).digest('hex');
    return new ConversationRestartError(message, code, {
      operationId,
      recovery: { kind: 'codex_resume', sessionId, command: `handmux codex resume ${sessionId}` },
      phase: 'prepared',
      state: 'current',
      canResume: false,
    });
  };
  const waitForShell = async (
    receipt: CodexRestartReceipt,
    signal: AbortSignal,
  ): Promise<ForegroundProcessIdentity> => {
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      if (signal.aborted) throw new RestartFault('Conversation restart timed out after stopping Codex', 'unavailable');
      const pane = await paneAndEpochMatch(receipt);
      if (!pane) throw new RestartFault('The original pane was replaced during restart', 'unavailable');
      const [ownership, foreground, group, serverStatus] = await Promise.all([
        app.discover(pane.paneId), freshForeground(pane), freshGroup(pane), oldAppServerStatus(receipt),
      ]);
      if (ownership?.managed === true && ownership.threadId !== receipt.sessionId) {
        throw new RestartFault('A different Codex session appeared in the original pane', 'unavailable');
      }
      const originalPresent = group.some((identity) => (
        sameGeneration(receipt.process.tui, identity)
        || sameGeneration(receipt.process.wrapper, identity)
      ));
      if ((serverStatus === 'exited' || serverStatus === 'replaced')
        && ownership?.managed === false && !originalPresent && foreground
        && SHELLS.has(executableName(foreground))) return foreground;
      await wait(pollMs);
    }
    throw new RestartFault('Codex did not return to the original shell before the restart timed out', 'unavailable');
  };
  const waitForReady = async (receipt: CodexRestartReceipt, signal: AbortSignal): Promise<void> => {
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      if (signal.aborted) throw new RestartFault('Conversation restart timed out; copy the recovery command', 'unavailable');
      if (await resumeReady(receipt)) return;
      await wait(pollMs);
    }
    throw new RestartFault('The Codex session did not become ready before the restart timed out', 'unavailable');
  };
  const finalizeReady = (receipt: CodexRestartReceipt): CodexRestartReceipt => {
    const ready = receipts.transition(receipt.operationId, ['prepared', 'stopped', 'resuming', 'ready'], 'ready');
    releaseDeliveryFence(receipt.operationId);
    return ready;
  };
  const maybeReconcileReady = async (receipt: CodexRestartReceipt): Promise<CodexRestartReceipt> => {
    if (receipt.phase === 'ready') {
      releaseDeliveryFence(receipt.operationId);
      return receipt;
    }
    if (await resumeReady(receipt)) {
      return finalizeReady(receipt);
    }
    return receipt;
  };

  return {
    apiVersion: 1,
    async restart(run, signal): Promise<ConversationRestartReceipt> {
      if (run.ref.agentId !== 'codex') throw new ConversationRestartError(
        'Conversation restart is not supported for this Agent', 'unsupported',
      );
      if (!run.ref.sessionId || !isSessionUuid(run.ref.sessionId) || !stableRun(run, resolveRun)) {
        throw new ConversationRestartError('The Agent run is no longer active', 'stale_run');
      }
      const existing = receipts.latestForPane(run.ref.paneId);
      if (existing && existing.sessionId === run.ref.sessionId && existing.phase !== 'ready') {
        throw new ConversationRestartError(
          'Conversation restart is already in progress', 'in_progress', await receiptView(existing),
        );
      }

      let evidence: RestartEvidence;
      try { evidence = await inspectEvidence(run); }
      catch (error) {
        if (error instanceof RestartFault) throw preflightRecovery(run, error.code, error.message);
        throw preflightRecovery(run, 'unavailable', 'Codex restart identity could not be verified');
      }
      if (!stableRun(run, resolveRun)) throw new ConversationRestartError(
        'The Agent run changed before the restart could begin', 'stale_run',
      );

      let receipt: CodexRestartReceipt;
      try { receipt = receipts.prepare(recordInput(run, evidence)); }
      catch {
        throw new ConversationRestartError('Codex restart state could not be saved; no process was stopped', 'unavailable');
      }
      let release: (() => void) | undefined;
      let signalAttempted = false;
      let terminationFailed = false;
      const clearBeforeStop = async (message: string, code: 'unavailable' | 'stale_run'): Promise<never> => {
        if (await originalStillPresent(receipt)) {
          try {
            receipts.clear(receipt.operationId);
            releaseDeliveryFence(receipt.operationId);
          } catch { /* The durable pending marker still blocks delivery; fail closed. */ }
        }
        throw await errorWithReceipt(message, code, receipt, false);
      };

      try {
        release = await pauseSessionDelivery({ agentId: 'codex', sessionId: run.ref.sessionId });
        deliveryFenceReleases.set(receipt.operationId, release);
        if (signal.aborted) return await clearBeforeStop('Conversation restart timed out before stopping Codex', 'unavailable');
        const result = await serializePaneInput(run.ref.paneId, async () => {
          if (!stableRun(run, resolveRun)) {
            return await clearBeforeStop('The Agent run changed before Codex could be stopped', 'stale_run');
          }
          let current: RestartEvidence;
          try { current = await inspectEvidence(run); }
          catch (error) {
            const code = error instanceof RestartFault ? error.code : 'unavailable';
            return await clearBeforeStop(
              error instanceof Error ? error.message : 'Codex restart identity changed before the stop boundary',
              code,
            );
          }
          if (!samePane(evidence.pane, current.pane) || evidence.epoch !== current.epoch
            || !sameIdentity(evidence.tui, current.tui) || !sameIdentity(evidence.wrapper, current.wrapper)
            || !sameIdentity(evidence.appServer, current.appServer)) {
            return await clearBeforeStop('The original Codex process or pane changed before the stop boundary', 'stale_run');
          }
          if (!stableRun(run, resolveRun)) {
            return await clearBeforeStop('The Agent run changed during the final process identity probe', 'stale_run');
          }
          if (signal.aborted) return await clearBeforeStop('Conversation restart timed out before stopping Codex', 'unavailable');

          signalAttempted = true;
          let terminateError: unknown;
          try {
            const accepted = await commands.terminate(receipt.process.tui.pid, 'SIGTERM');
            if (accepted === false) {
              terminationFailed = true;
              terminateError = new Error('SIGTERM was not accepted');
            }
          } catch (error) {
            terminationFailed = true;
            terminateError = error;
          }

          let shell: ForegroundProcessIdentity;
          try { shell = await waitForShell(receipt, signal); }
          catch (error) {
            if (terminateError && await originalStillPresent(receipt)) {
              return await clearBeforeStop('Codex is still running; the restart signal could not be delivered', 'unavailable');
            }
            throw error;
          }
          receipt = receipts.transition(receipt.operationId, 'prepared', 'stopped');
          const beforeResume = await paneAndEpochMatch(receipt);
          const currentShell = beforeResume ? await freshForeground(beforeResume) : null;
          if (!beforeResume || !currentShell || !sameIdentity(shell, currentShell)
            || !SHELLS.has(executableName(currentShell))) {
            throw new RestartFault('The original shell changed before the recovery command could be sent', 'unavailable');
          }
          if (signal.aborted) throw new RestartFault('Conversation restart timed out; copy the recovery command', 'unavailable');
          receipt = receipts.transition(receipt.operationId, 'stopped', 'resuming');
          await commands.runPaneCommand(run.ref.paneId, receipt.command);
          await waitForReady(receipt, signal);
          receipt = finalizeReady(receipt);
          return await receiptView(receipt, { allowResume: false });
        });
        return result;
      } catch (error) {
        if (error instanceof ConversationRestartError) throw error;
        if (!signalAttempted) {
          await clearBeforeStop(
            error instanceof Error ? error.message : 'Codex restart was not completed',
            error instanceof RestartFault ? error.code : 'unavailable',
          );
        }
        if (terminationFailed && await originalStillPresent(receipt)) {
          try {
            receipts.clear(receipt.operationId);
            releaseDeliveryFence(receipt.operationId);
            throw await errorWithReceipt(
              error instanceof Error ? error.message : 'Codex restart was not completed',
              error instanceof RestartFault ? error.code : 'unavailable',
              receipt,
              false,
            );
          } catch (cleanupError) {
            if (cleanupError instanceof ConversationRestartError) throw cleanupError;
            // If the durable clear failed, preserve the on-disk marker and its delivery fence.
          }
        }
        throw await errorWithReceipt(
          error instanceof Error ? error.message : 'Codex restart was not completed',
          error instanceof RestartFault ? error.code : 'unavailable',
          receipt,
        );
      }
    },
    async recovery(paneId): Promise<ConversationRestartReceipt | null> {
      let receipt = receipts.latestForPane(paneId);
      if (!receipt) return null;
      try { receipt = await maybeReconcileReady(receipt); } catch { /* persisted recovery remains available */ }
      return await receiptView(receipt);
    },
    async recover(paneId, operationId, signal): Promise<ConversationRestartReceipt> {
      return await serializePaneInput(paneId, async () => {
        let receipt = receipts.get(operationId);
        if (!receipt || receipt.pane.paneId !== paneId || receipt.phase === 'ready') {
          throw new ConversationRestartError('Conversation restart recovery is no longer available', 'unavailable');
        }
        const existing = await maybeReconcileReady(receipt);
        if (existing.phase === 'ready') return await receiptView(existing, { allowResume: false });
        const view = await receiptView(existing);
        const beforeResume = await recoveryShell(existing);
        if (signal.aborted || view.state !== 'current' || !view.canResume
          || !beforeResume || existing.phase === 'resuming') {
          throw new ConversationRestartError(
            'The original pane is not safe to resume; copy the recovery command and continue in the terminal',
            view.state === 'stale' ? 'stale_run' : 'unavailable',
            view,
          );
        }
        receipt = receipts.transition(existing.operationId, ['prepared', 'stopped'], 'resuming');
        const afterResume = await recoveryShell(receipt);
        const rechecked = await receiptView(receipt, { allowResume: false });
        if (signal.aborted || !afterResume || !sameIdentity(beforeResume.identity, afterResume.identity)
          || rechecked.state !== 'current') {
          throw new ConversationRestartError('The original pane changed before recovery', 'stale_run', rechecked);
        }
        await commands.runPaneCommand(paneId, receipt.command);
        try {
          await waitForReady(receipt, signal);
          receipt = finalizeReady(receipt);
          return await receiptView(receipt, { allowResume: false });
        } catch (error) {
          throw await errorWithReceipt(
            error instanceof Error ? error.message : 'Codex recovery did not become ready',
            error instanceof RestartFault ? error.code : 'unavailable',
            receipt,
          );
        }
      });
    },
  };
}
