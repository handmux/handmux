import fsp from 'node:fs/promises';
import os from 'node:os';
import { AGENTS } from '../agents/index.js';
import type { RecoveryMappingAddition } from './mapping.js';
import type { PlanSession, WindowDisposition } from './planner.js';
import type { WorkspacePane, WorkspaceSession, WorkspaceWindow } from './schema.js';
import type { AgentReadiness } from './agentRunner.js';

const KINDS = ['sessions', 'windows', 'panes'] as const;
type MappingKind = typeof KINDS[number];
interface RestoreCheckpoint { sessions: WorkspaceSession[]; windows: WorkspaceWindow[] }
interface RestorePlan { sessions: PlanSession[]; windows?: WindowDisposition[] }
type RestorableItem = PlanSession & {
  logicalId: string;
  sourceName: string;
  targetName: string;
  activeWindowId: string;
  windowLinks: Array<{ windowId: string; index: number }>;
};
interface AgentDriver {
  id: string;
  sessions: {
    isId(value: unknown): boolean;
    resumeArgs(sessionId: string): string[];
  };
}
interface TemporarySession { sessionId: string; windowId: string; paneId: string }
interface RestoreTmux {
  createTemporarySession(input: Record<string, unknown>): Promise<TemporarySession>;
  createWindow(sessionId: string, input: Record<string, unknown>): Promise<{ windowId: string; paneId: string }>;
  splitPane(target: string | undefined, input: Record<string, unknown>): Promise<string>;
  linkWindow(source: string, sessionId: string, index: number, options: { existing: boolean }): Promise<unknown>;
  applyLayout(target: string, layout: string): Promise<unknown>;
  selectPane(target: string): Promise<unknown>;
  selectWindow(target: string): Promise<unknown>;
  selectWindowInSession?(sessionId: string, index: number): Promise<unknown>;
  killCreatedWindow(target: string): Promise<unknown>;
  renameCreatedSession(target: string, name: string): Promise<unknown>;
  startAgent(target: string, command: string, args: string[]): Promise<unknown>;
  waitForAgents?(commands: string[]): ReadonlyMap<string, Promise<AgentReadiness>>;
  killCreatedSession(target: string): Promise<unknown>;
  revokeCreatedTargets?(): void;
}
export interface RestoreResult {
  logicalId: string | null;
  sourceName: string | null;
  targetName?: string;
  status: 'restored' | 'already-present' | 'failed';
  stage?: string;
  error?: string;
  warnings?: string[];
  mapping?: RecoveryMappingAddition;
}
type Access = (path: string) => Promise<unknown>;
const errorStage = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'stage' in error && typeof error.stage === 'string'
    ? error.stage : undefined
);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function windowMap(checkpoint: RestoreCheckpoint): Map<string, WorkspaceWindow> {
  return new Map(checkpoint.windows.map((window) => [window.id, window]));
}

function sessionMap(checkpoint: RestoreCheckpoint): Map<string, WorkspaceSession> {
  return new Map(checkpoint.sessions.map((session) => [session.id, session]));
}

function emptyMapping(): RecoveryMappingAddition {
  return {
    names: {},
    runtime: { sessions: {}, windows: {}, panes: {} },
    logical: { sessions: {}, windows: {}, panes: {} },
  };
}

function mergeMapping(target: RecoveryMappingAddition, source: RecoveryMappingAddition): RecoveryMappingAddition {
  Object.assign(target.names, source.names);
  for (const kind of KINDS) {
    Object.assign(target.runtime[kind], source.runtime[kind]);
    Object.assign(target.logical[kind], source.logical[kind]);
  }
  return target;
}

function mapRuntime(
  mapping: RecoveryMappingAddition,
  kind: MappingKind,
  source: unknown,
  logical: unknown,
  actual: string,
): void {
  if (typeof source === 'string' && source) mapping.runtime[kind][source] = actual;
  if (typeof logical === 'string' && logical) mapping.logical[kind][logical] = actual;
}

async function usableCwd(cwd: unknown, {
  access, home, warnings,
}: { access: Access; home: string; warnings: string[] }): Promise<string> {
  if (typeof cwd === 'string' && cwd) {
    try {
      await access(cwd);
      return cwd;
    } catch { /* fall through */ }
  }
  warnings.push(`cwd ${typeof cwd === 'string' && cwd ? cwd : '(missing)'} is unavailable; restored in ${home}`);
  return home;
}

function sortedPanes(window: WorkspaceWindow): WorkspacePane[] {
  return [...window.panes].sort((a, b) => a.index - b.index);
}

function requiredWindow(windows: ReadonlyMap<string, WorkspaceWindow>, id: string): WorkspaceWindow {
  const window = windows.get(id);
  if (!window) throw new Error(`checkpoint window ${id} is missing`);
  return window;
}

function firstPane(window: WorkspaceWindow): WorkspacePane {
  const pane = sortedPanes(window)[0];
  if (!pane) throw new Error(`checkpoint window ${window.id} has no panes`);
  return pane;
}

function dispositionMap(plan: RestorePlan): Map<string | null, WindowDisposition> {
  return new Map((plan.windows || []).map((window) => [window.logicalId, window]));
}

async function notify(
  onProgress: ((progress: { completed: number; total: number; result: RestoreResult }) => unknown | Promise<unknown>) | undefined,
  results: RestoreResult[],
  result: RestoreResult,
  total: number,
): Promise<void> {
  if (typeof onProgress !== 'function') return;
  await onProgress({ completed: results.length, total, result });
}

async function restoreOneSession({
  item, checkpoint, tmux, agents, access, home, dispositions, restoredWindows, agentReadiness,
}: {
  item: RestorableItem;
  checkpoint: RestoreCheckpoint;
  tmux: RestoreTmux;
  agents: readonly AgentDriver[];
  access: Access;
  home: string;
  dispositions: ReadonlyMap<string | null, WindowDisposition>;
  restoredWindows: Map<string, string>;
  agentReadiness: ReadonlyMap<string, Promise<AgentReadiness>>;
}): Promise<RestoreResult> {
  const sessions = sessionMap(checkpoint);
  const windows = windowMap(checkpoint);
  const source = sessions.get(item.logicalId);
  if (!source) throw Object.assign(new Error('checkpoint session is missing'), { stage: 'plan' });

  const warnings: string[] = [];
  const mapping = emptyMapping();
  const localWindows = new Map<string, string>();
  const localPanes = new Map<string, string>();
  const links = [...item.windowLinks].sort((a, b) => a.index - b.index);
  const seedLink = links.find((link) => {
    if (restoredWindows.has(link.windowId)) return false;
    return dispositions.get(link.windowId)?.action !== 'reuse';
  });
  let temp: TemporarySession | null = null;
  let topologyComplete = false;

  try {
    if (seedLink) {
      const seedWindow = requiredWindow(windows, seedLink.windowId);
      const seedPane = firstPane(seedWindow);
      const cwd = await usableCwd(seedPane.cwd, { access, home, warnings });
      temp = await tmux.createTemporarySession({
        cwd,
        sessionLogicalId: item.logicalId,
        windowLogicalId: seedWindow.id,
        paneLogicalId: seedPane.id,
        windowName: seedWindow.name,
        windowIndex: seedLink.index,
      });
      localWindows.set(seedWindow.id, temp.windowId);
      localPanes.set(seedPane.id, temp.paneId);
      mapRuntime(mapping, 'windows', seedWindow.runtimeId, seedWindow.id, temp.windowId);
      mapRuntime(mapping, 'panes', seedPane.runtimeId, seedPane.id, temp.paneId);
    } else {
      const fallbackId = links[0]?.windowId;
      if (!fallbackId) throw new Error('checkpoint session has no windows');
      const fallbackWindow = requiredWindow(windows, fallbackId);
      const cwd = await usableCwd(firstPane(fallbackWindow).cwd, { access, home, warnings });
      temp = await tmux.createTemporarySession({ cwd, sessionLogicalId: item.logicalId });
    }
    mapRuntime(mapping, 'sessions', source.runtimeId, source.id, temp.sessionId);

    for (const link of links) {
      const window = windows.get(link.windowId);
      if (!window) throw new Error(`checkpoint window ${link.windowId} is missing`);
      if (localWindows.has(window.id)) continue;

      const sharedRuntime = restoredWindows.get(window.id);
      const disposition = dispositions.get(window.id);
      const dispositionRuntime = disposition?.action === 'reuse' ? disposition.runtimeId : undefined;
      if (sharedRuntime || dispositionRuntime) {
        const windowId = sharedRuntime || dispositionRuntime;
        if (!windowId) throw new Error(`reused window ${window.id} has no runtime id`);
        await tmux.linkWindow(windowId, temp.sessionId, link.index, { existing: !sharedRuntime });
        if (!sharedRuntime) mapRuntime(mapping, 'windows', window.runtimeId, window.id, windowId);
        continue;
      }

      const initialPane = firstPane(window);
      const cwd = await usableCwd(initialPane.cwd, { access, home, warnings });
      const created = await tmux.createWindow(temp.sessionId, {
        name: window.name,
        index: link.index,
        cwd,
        windowLogicalId: window.id,
        paneLogicalId: initialPane.id,
      });
      localWindows.set(window.id, created.windowId);
      localPanes.set(initialPane.id, created.paneId);
      mapRuntime(mapping, 'windows', window.runtimeId, window.id, created.windowId);
      mapRuntime(mapping, 'panes', initialPane.runtimeId, initialPane.id, created.paneId);
    }

    for (const [logicalId, runtimeId] of localWindows) {
      const window = requiredWindow(windows, logicalId);
      const panes = sortedPanes(window);
      const firstPane = panes[0];
      if (!firstPane) throw new Error(`window ${logicalId} has no panes`);
      const seedPaneId = localPanes.get(firstPane.id);
      for (const pane of panes.slice(1)) {
        const cwd = await usableCwd(pane.cwd, { access, home, warnings });
        const paneId = await tmux.splitPane(seedPaneId, { cwd, paneLogicalId: pane.id });
        localPanes.set(pane.id, paneId);
        mapRuntime(mapping, 'panes', pane.runtimeId, pane.id, paneId);
      }
      try {
        await tmux.applyLayout(runtimeId, window.layout);
      } catch (error) {
        warnings.push(`layout for ${window.name} was unavailable; kept the default layout (${message(error)})`);
      }
      const activePane = localPanes.get(window.activePaneId);
      if (activePane) await tmux.selectPane(activePane);
    }

    const activeLink = links.find((link) => link.windowId === item.activeWindowId);
    if (activeLink) {
      if (typeof tmux.selectWindowInSession === 'function') await tmux.selectWindowInSession(temp.sessionId, activeLink.index);
      else {
        const activeWindow = localWindows.get(activeLink.windowId) || restoredWindows.get(activeLink.windowId);
        if (activeWindow) await tmux.selectWindow(activeWindow);
      }
    }

    if (!seedLink && temp.windowId) await tmux.killCreatedWindow(temp.windowId);
    await tmux.renameCreatedSession(temp.sessionId, item.targetName);
    topologyComplete = true;
    mapping.names[item.sourceName] = item.targetName;
    for (const [logicalId, runtimeId] of localWindows) restoredWindows.set(logicalId, runtimeId);

    for (const [logicalId, paneId] of localPanes) {
      const pane = [...windows.values()].flatMap((window) => window.panes).find((candidate) => candidate.id === logicalId);
      if (!pane?.agent) continue;
      const binding = pane.agent;
      const agentId = typeof binding.id === 'string' ? binding.id : '';
      const sessionId = typeof binding.sessionId === 'string' ? binding.sessionId : '';
      const transcriptPath = typeof binding.transcriptPath === 'string' ? binding.transcriptPath : '';
      const driver = agents.find((candidate) => candidate.id === agentId);
      if (!driver) {
        warnings.push(`agent ${agentId || '(missing)'} is unsupported; shell was restored`);
        continue;
      }
      if (!driver.sessions.isId(sessionId)) {
        warnings.push(`agent ${driver.id} session id is invalid; shell was restored`);
        continue;
      }
      try {
        await access(transcriptPath);
      } catch {
        warnings.push(`agent ${driver.id} context is unavailable; shell was restored`);
        continue;
      }
      const [cmd, ...args] = driver.sessions.resumeArgs(sessionId);
      if (!cmd) {
        warnings.push(`agent ${driver.id} resume command is unavailable; shell was restored`);
        continue;
      }
      const executable = agentReadiness.get(cmd);
      if (executable) {
        let readiness: AgentReadiness;
        try {
          readiness = await executable;
        } catch (error) {
          readiness = { status: 'failed', error: message(error) };
        }
        if (readiness.status !== 'ready') {
          warnings.push(`agent ${driver.id} executable is unavailable; shell was restored (${readiness.error})`);
          continue;
        }
      }
      try {
        await tmux.startAgent(paneId, cmd, args);
      } catch (error) {
        warnings.push(`agent ${driver.id} resume failed; shell was restored (${message(error)})`);
      }
    }

    return {
      logicalId: item.logicalId,
      sourceName: item.sourceName,
      targetName: item.targetName,
      status: 'restored',
      warnings,
      mapping,
    };
  } catch (error) {
    let cleanupError: unknown;
    if (temp && !topologyComplete) {
      try { await tmux.killCreatedSession(temp.sessionId); } catch (failure) { cleanupError = failure; }
    }
    const failure: Error & { stage?: string } = cleanupError
      ? new Error(`${message(error)}; cleanup failed: ${message(cleanupError)}`)
      : error instanceof Error ? error : new Error(message(error));
    failure.stage ||= errorStage(error) || 'topology';
    throw failure;
  }
}

function requiredAgentCommands(
  plan: RestorePlan,
  checkpoint: RestoreCheckpoint,
  agents: readonly AgentDriver[],
): string[] {
  const sessions = sessionMap(checkpoint);
  const windows = windowMap(checkpoint);
  const dispositions = dispositionMap(plan);
  const commands = new Set<string>();
  for (const item of plan.sessions) {
    if (item.action === 'already-present' || item.action === 'unsupported') continue;
    if (typeof item.logicalId !== 'string') continue;
    const session = sessions.get(item.logicalId);
    if (!session) continue;
    for (const link of session.windowLinks) {
      if (dispositions.get(link.windowId)?.action === 'reuse') continue;
      for (const pane of windows.get(link.windowId)?.panes || []) {
        const binding = pane.agent;
        if (!binding) continue;
        const agentId = typeof binding.id === 'string' ? binding.id : '';
        const sessionId = typeof binding.sessionId === 'string' ? binding.sessionId : '';
        const driver = agents.find((candidate) => candidate.id === agentId);
        if (!driver || !driver.sessions.isId(sessionId)) continue;
        const [command] = driver.sessions.resumeArgs(sessionId);
        if (command) commands.add(command);
      }
    }
  }
  return [...commands];
}

function restoredTopologySummary(
  checkpoint: RestoreCheckpoint | null,
  results: RestoreResult[],
): { sessions: number; windows: number; panes: number } {
  const restoredSessions = new Set(results
    .filter((result) => result.status === 'restored')
    .map((result) => result.logicalId));
  const windowIds = new Set((checkpoint?.sessions || [])
    .filter((session) => restoredSessions.has(session.id))
    .flatMap((session) => (session.windowLinks || []).map((link) => link.windowId)));
  const paneIds = new Set((checkpoint?.windows || [])
    .filter((window) => windowIds.has(window.id))
    .flatMap((window) => (window.panes || []).map((pane) => pane.id)));
  return { sessions: restoredSessions.size, windows: windowIds.size, panes: paneIds.size };
}

export function summarizeRestore(results: RestoreResult[], checkpoint: RestoreCheckpoint | null = null) {
  const mapping = emptyMapping();
  for (const result of results) if (result.mapping) mergeMapping(mapping, result.mapping);
  const restored = results.filter((result) => result.status === 'restored').length;
  const alreadyPresent = results.filter((result) => result.status === 'already-present').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const status = failed === 0 ? 'succeeded' : restored + alreadyPresent > 0 ? 'partial' : 'failed';
  return { status, restored, alreadyPresent, failed, results, mapping, summary: restoredTopologySummary(checkpoint, results) };
}

export async function executeRestore({
  plan,
  checkpoint,
  tmux,
  agents = AGENTS,
  onProgress,
  access = fsp.access,
  home = os.homedir(),
}: {
  plan: RestorePlan;
  checkpoint: RestoreCheckpoint;
  tmux: RestoreTmux;
  agents?: readonly AgentDriver[];
  onProgress?: (progress: { completed: number; total: number; result: RestoreResult }) => unknown | Promise<unknown>;
  access?: Access;
  home?: string;
}): Promise<ReturnType<typeof summarizeRestore>> {
  const results: RestoreResult[] = [];
  const dispositions = dispositionMap(plan);
  const restoredWindows = new Map();
  try {
    const commands = requiredAgentCommands(plan, checkpoint, agents);
    const agentReadiness = tmux.waitForAgents?.(commands) ?? new Map();
    for (const item of plan.sessions) {
      let result: RestoreResult;
      if (item.action === 'already-present') {
        result = { logicalId: item.logicalId, sourceName: item.sourceName, status: 'already-present' };
      } else if (item.action === 'unsupported') {
        result = {
          logicalId: item.logicalId, sourceName: item.sourceName, status: 'failed', stage: 'plan',
          ...(item.reason ? { error: item.reason } : {}),
        };
      } else {
        try {
          result = await restoreOneSession({
            item: item as RestorableItem,
            checkpoint, tmux, agents, access, home, dispositions, restoredWindows, agentReadiness,
          });
        } catch (error) {
          result = {
            logicalId: item.logicalId,
            sourceName: item.sourceName,
            status: 'failed',
            stage: errorStage(error) || 'topology',
            error: message(error),
          };
        }
      }
      results.push(result);
      await notify(onProgress, results, result, plan.sessions.length);
    }
    return summarizeRestore(results, checkpoint);
  } finally {
    tmux.revokeCreatedTargets?.();
  }
}
