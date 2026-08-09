import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { AGENTS } from '../agents/index.js';
import { resolveCodexRollout, sessionsDir as codexSessionsDir } from '../agents/codex.js';
import { canonicalizeSnapshot, WORKSPACE_SCHEMA_VERSION } from './schema.js';
import type {
  WorkspaceActive,
  WorkspaceEnvironment,
  WorkspacePane,
  WorkspaceSession,
  WorkspaceSnapshot,
  WorkspaceWindow,
} from './schema.js';

interface AgentDriver {
  id: string;
  sessions?: { isId(value: unknown): boolean };
}
export interface AgentBinding {
  id: string;
  sessionId: string;
  transcriptPath: string;
  [key: string]: unknown;
}
type BindingMap = Map<string, AgentBinding>;
type ReadFile = (path: string, encoding: 'utf8') => Promise<string | Buffer>;
type Access = (path: string, mode: number) => Promise<unknown>;
type Stat = (path: string) => Promise<{ isFile(): boolean }>;

export interface CapturedTopology {
  status: 'ok' | 'empty';
  tmuxVersion: string;
  active: WorkspaceActive | null;
  sessions: WorkspaceSession[];
  windows: WorkspaceWindow[];
}
interface TmuxCaptureAdapter {
  topologyFingerprint(): Promise<unknown>;
  captureTopology(): Promise<CapturedTopology | { status: 'unknown'; error?: unknown }>;
}
interface CodexDiscovery {
  discover(paneId: string): Promise<{ managed?: boolean; threadId?: unknown } | null | undefined>;
}

function agentMap(agents: readonly AgentDriver[]): Map<string, AgentDriver> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

export async function readAgentBindings(
  stateFile: string,
  agents: readonly AgentDriver[] = AGENTS,
  readFile: ReadFile = fsp.readFile as ReadFile,
  access: Access = fsp.access,
  stat: Stat = fsp.stat,
): Promise<BindingMap> {
  let state: unknown;
  try {
    state = JSON.parse(String(await readFile(stateFile, 'utf8')));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return new Map();
  } catch {
    return new Map();
  }

  const known = agentMap(agents);
  const bindings: BindingMap = new Map();
  for (const [paneRuntimeId, record] of Object.entries(state)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    // This is the Claude Hook state file. Legacy Codex-tagged rows are deliberately ignored; managed
    // Codex identity belongs to App Server and must not be reconstructed from the removed Hook path.
    if (record.agent !== undefined && record.agent !== 'claude') continue;
    const id = 'claude';
    if (!known.has(id)) continue;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const sessionId = (payload as Record<string, unknown>).session_id;
    const transcriptPath = (payload as Record<string, unknown>).transcript_path;
    const driver = known.get(id);
    if (typeof sessionId !== 'string' || !driver?.sessions?.isId(sessionId)
      || typeof transcriptPath !== 'string' || !transcriptPath) continue;
    try {
      await access(transcriptPath, constants.R_OK);
      if (!(await stat(transcriptPath)).isFile()) continue;
    } catch { continue; }
    bindings.set(paneRuntimeId, { id, sessionId, transcriptPath });
  }
  return bindings;
}

function topologyPanes(topology: CapturedTopology): WorkspacePane[] {
  return topology.windows.flatMap((window) => window.panes);
}

export async function readManagedCodexBindings(topology: CapturedTopology, {
  codexApp,
  codexSessions = codexSessionsDir(),
  agents = AGENTS,
  findRollout = resolveCodexRollout,
  access = fsp.access,
  stat = fsp.stat,
}: {
  codexApp?: CodexDiscovery;
  codexSessions?: string;
  agents?: readonly AgentDriver[];
  findRollout?: (sessionsDir: string, sessionId: string) => Promise<string | null>;
  access?: Access;
  stat?: Stat;
} = {}): Promise<BindingMap> {
  if (typeof codexApp?.discover !== 'function') return new Map();
  const panes = topologyPanes(topology);
  const discovered = new Map<string, string | null>(await Promise.all(panes.map(async (pane): Promise<[string, string | null]> => {
    try {
      const state = await codexApp.discover(pane.runtimeId);
      return [pane.runtimeId, state?.managed && typeof state.threadId === 'string' ? state.threadId : null];
    } catch {
      return [pane.runtimeId, null];
    }
  })));

  const driver = agents.find((agent) => agent.id === 'codex');
  if (!driver) return new Map();
  const bindings: BindingMap = new Map();
  for (const pane of panes) {
    const sessionId = discovered.get(pane.runtimeId);
    if (typeof sessionId !== 'string' || !driver.sessions?.isId(sessionId)) continue;
    let transcriptPath;
    try {
      transcriptPath = await findRollout(codexSessions, sessionId);
      if (typeof transcriptPath !== 'string' || !transcriptPath) continue;
      await access(transcriptPath, constants.R_OK);
      if (!(await stat(transcriptPath)).isFile()) continue;
    } catch { continue; }
    bindings.set(pane.runtimeId, { id: 'codex', sessionId, transcriptPath });
  }
  return bindings;
}

export function attachBindings<T extends { windows: WorkspaceWindow[] }>(
  topology: T,
  bindings: ReadonlyMap<string, AgentBinding>,
): T {
  return {
    ...topology,
    windows: topology.windows.map((window) => ({
      ...window,
      panes: window.panes.map((pane) => ({ ...pane, agent: bindings.get(pane.runtimeId) || null })),
    })),
  } as T;
}

function isUnknownFingerprint(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === 'object' && 'status' in value && value.status === 'unknown');
}

export type WorkspaceCaptureResult =
  | { status: 'unknown' | 'changed-during-capture' }
  | { status: 'ok' | 'empty'; snapshot: WorkspaceSnapshot };

export async function captureWorkspace({
  tmux,
  stateFile,
  environment,
  agents = AGENTS,
  readFile = fsp.readFile,
  access = fsp.access,
  stat = fsp.stat,
  codexApp,
  codexSessions = codexSessionsDir(),
  findCodexRollout = resolveCodexRollout,
  now = Date.now,
}: {
  tmux: TmuxCaptureAdapter;
  stateFile: string;
  environment: WorkspaceEnvironment;
  agents?: readonly AgentDriver[];
  readFile?: ReadFile;
  access?: Access;
  stat?: Stat;
  codexApp?: CodexDiscovery;
  codexSessions?: string;
  findCodexRollout?: (sessionsDir: string, sessionId: string) => Promise<string | null>;
  now?: () => number;
}): Promise<WorkspaceCaptureResult> {
  try {
    const before = await tmux.topologyFingerprint();
    if (isUnknownFingerprint(before)) return { status: 'unknown' };
    const topology = await tmux.captureTopology();
    if (!topology || topology.status === 'unknown') return { status: 'unknown' };
    const bindings = await readAgentBindings(stateFile, agents, readFile, access, stat);
    const managedCodex = await readManagedCodexBindings(topology, {
      codexApp, codexSessions, agents, findRollout: findCodexRollout, access, stat,
    });
    for (const [pane, binding] of managedCodex) bindings.set(pane, binding);
    const after = await tmux.topologyFingerprint();
    if (isUnknownFingerprint(after)) return { status: 'unknown' };
    if (before !== after) return { status: 'changed-during-capture' };

    const snapshot = canonicalizeSnapshot(attachBindings({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      capturedAt: new Date(now()).toISOString(),
      environment: { ...environment },
      tmuxVersion: topology.tmuxVersion,
      active: topology.active,
      sessions: topology.sessions,
      windows: topology.windows,
    }, bindings));
    return { status: topology.status === 'empty' ? 'empty' : 'ok', snapshot };
  } catch {
    return { status: 'unknown' };
  }
}
