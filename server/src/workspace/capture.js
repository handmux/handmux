import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { AGENTS } from '../agents/index.js';
import { canonicalizeSnapshot, WORKSPACE_SCHEMA_VERSION } from './schema.js';

function agentMap(agents) {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

export async function readAgentBindings(stateFile, agents = AGENTS, readFile = fsp.readFile, access = fsp.access, stat = fsp.stat) {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return new Map();
  } catch {
    return new Map();
  }

  const known = agentMap(agents);
  const bindings = new Map();
  for (const [paneRuntimeId, record] of Object.entries(state)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const id = record.agent === undefined ? 'claude' : record.agent;
    if (typeof id !== 'string' || !known.has(id)) continue;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const sessionId = payload.session_id;
    const transcriptPath = payload.transcript_path;
    const driver = known.get(id);
    if (driver.sessions?.bindingVersion && record.bindingVersion !== driver.sessions.bindingVersion) continue;
    if (!driver.sessions?.isId(sessionId) || typeof transcriptPath !== 'string' || !transcriptPath) continue;
    try {
      await access(transcriptPath, constants.R_OK);
      if (!(await stat(transcriptPath)).isFile()) continue;
    } catch { continue; }
    bindings.set(paneRuntimeId, { id, sessionId, transcriptPath });
  }
  return bindings;
}

export function attachBindings(topology, bindings) {
  return {
    ...topology,
    windows: topology.windows.map((window) => ({
      ...window,
      panes: window.panes.map((pane) => ({ ...pane, agent: bindings.get(pane.runtimeId) || null })),
    })),
  };
}

function isUnknownFingerprint(value) {
  return value === null || value === undefined || value?.status === 'unknown';
}

export async function captureWorkspace({
  tmux,
  stateFile,
  environment,
  agents = AGENTS,
  readFile = fsp.readFile,
  access = fsp.access,
  stat = fsp.stat,
  now = Date.now,
}) {
  try {
    const before = await tmux.topologyFingerprint();
    if (isUnknownFingerprint(before)) return { status: 'unknown' };
    const topology = await tmux.captureTopology();
    if (!topology || topology.status === 'unknown') return { status: 'unknown' };
    const bindings = await readAgentBindings(stateFile, agents, readFile, access, stat);
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
