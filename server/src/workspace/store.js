import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, writeJsonAtomic } from './atomicJson.js';
import { workspacePaths } from './paths.js';
import { canonicalizeSnapshot, fingerprintSnapshot, sealPayload, validateCheckpoint } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireSafeId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id === '..') throw new Error('workspace id must be a safe filename');
  return id;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function projectObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function projectSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const environment = projectObject(input.environment, ['id', 'bootIdentity', 'tmuxServerId']);
  const active = input.active === null ? null : projectObject(input.active, ['sessionId', 'windowId', 'paneId']);
  const sessions = Array.isArray(input.sessions)
    ? input.sessions.map((session) => projectObject(session, ['id', 'runtimeId', 'name', 'windowIds', 'activeWindowId']))
    : input.sessions;
  const windows = Array.isArray(input.windows) ? input.windows.map((window) => {
    const projected = projectObject(window, ['id', 'runtimeId', 'name', 'index', 'layout', 'activePaneId', 'panes']);
    if (!projected || typeof projected !== 'object' || Array.isArray(projected) || !Array.isArray(projected.panes)) return projected;
    projected.panes = projected.panes.map((pane) => {
      const projectedPane = projectObject(pane, ['id', 'runtimeId', 'index', 'cwd', 'agent']);
      if (!projectedPane || typeof projectedPane !== 'object' || Array.isArray(projectedPane)) return projectedPane;
      if (projectedPane.agent !== null && projectedPane.agent !== undefined) {
        projectedPane.agent = projectObject(projectedPane.agent, ['id', 'sessionId', 'transcriptPath']);
      }
      return projectedPane;
    });
    return projected;
  }) : input.windows;
  return {
    schemaVersion: input.schemaVersion,
    capturedAt: input.capturedAt,
    environment,
    tmuxVersion: input.tmuxVersion,
    active,
    sessions,
    windows,
  };
}

function validateLive(value) {
  try {
    if (!Number.isInteger(value?.revision) || value.revision < 1) throw new Error('invalid live revision');
    if (typeof value.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadHash)) throw new Error('invalid live payloadHash');
    if (fingerprintSnapshot(value) !== value.payloadHash) throw new Error('live hash mismatch');
    return { ok: true, value: canonicalizeSnapshot(value) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function readJson(file, fs) {
  try {
    return { status: 'ok', value: JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'corrupt', error: errorMessage(error) };
  }
}

async function readValidated(file, fs, validate) {
  const result = await readJson(file, fs);
  if (result.status !== 'ok') return result;
  try {
    const value = validate(result.value);
    return { status: 'ok', value };
  } catch (error) {
    return { status: 'corrupt', error: errorMessage(error) };
  }
}

function validateRecovery(value, checkpointId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid recovery state');
  if (value.checkpointId !== checkpointId) throw new Error('recovery checkpoint id mismatch');
  for (const field of ['detectedAt', 'expiresAt']) {
    if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field]))) throw new Error(`invalid recovery ${field}`);
  }
  for (const field of ['initialSessionIds', 'pendingSessionIds']) {
    if (!Array.isArray(value[field]) || value[field].some((id) => typeof id !== 'string' || !id)) throw new Error(`invalid recovery ${field}`);
    if (new Set(value[field]).size !== value[field].length) throw new Error(`duplicate recovery ${field}`);
  }
  const initial = new Set(value.initialSessionIds);
  if (value.pendingSessionIds.some((id) => !initial.has(id))) throw new Error('recovery pending ids must be initial ids');
  if (value.resolvedAt !== null && (typeof value.resolvedAt !== 'string' || Number.isNaN(Date.parse(value.resolvedAt)))) throw new Error('invalid recovery resolvedAt');
  if (value.resolvedAt !== null && value.pendingSessionIds.length > 0) throw new Error('resolved recovery cannot contain pending session ids');
  if (value.mapping !== null && (!value.mapping || typeof value.mapping !== 'object' || Array.isArray(value.mapping))) throw new Error('invalid recovery mapping');
  return value;
}

export function selectRetainedCheckpoints(rows, now, latestId) {
  const valid = rows
    .filter((row) => row.status === 'ok' && Number.isFinite(Date.parse(row.value.archivedAt)))
    .sort((a, b) => Date.parse(b.value.archivedAt) - Date.parse(a.value.archivedAt));
  const retained = [];
  const retainedIds = new Set();
  const keep = (row) => {
    if (!row || retainedIds.has(row.id)) return;
    retained.push(row);
    retainedIds.add(row.id);
  };
  for (const row of valid) {
    if (Date.parse(row.value.archivedAt) >= now - DAY_MS) keep(row);
  }
  for (const row of valid) {
    if (retained.length >= 10) break;
    keep(row);
  }
  keep(rows.find((row) => row.id === latestId));
  return retained;
}

export function createWorkspaceStore({ home, now = Date.now, fs = fsp }) {
  const paths = workspacePaths(home);

  async function ensureDirectories() {
    for (const dir of [path.dirname(paths.root), paths.root, paths.liveDir, paths.checkpointsDir, paths.recoveryDir, paths.operationsDir]) {
      await ensurePrivateDir(dir, { fs });
    }
  }

  async function readLiveCopy(file) {
    const result = await readJson(file, fs);
    if (result.status !== 'ok') return result;
    const validated = validateLive(result.value);
    return validated.ok ? { status: 'ok', value: validated.value } : { status: 'corrupt', error: validated.error };
  }

  async function readLive() {
    const copies = await Promise.all([paths.liveCurrent, paths.liveMirror].map(readLiveCopy));
    const valid = copies
      .map((result, index) => ({ ...result, index }))
      .filter((result) => result.status === 'ok')
      .sort((a, b) => b.value.revision - a.value.revision || a.index - b.index);
    if (valid.length === 0) {
      if (copies.every((copy) => copy.status === 'missing')) return { status: 'empty' };
      return { status: 'corrupt', errors: copies.map((copy) => copy.error ?? copy.status) };
    }

    const chosen = valid[0].value;
    let repaired = false;
    await ensureDirectories();
    for (let index = 0; index < copies.length; index += 1) {
      const copy = copies[index];
      if (copy.status === 'ok' && copy.value.revision === chosen.revision && copy.value.payloadHash === chosen.payloadHash) continue;
      await writeJsonAtomic(index === 0 ? paths.liveCurrent : paths.liveMirror, chosen, { fs });
      repaired = true;
    }
    return { status: 'ok', value: chosen, repaired };
  }

  async function writeLive(snapshot) {
    const payload = projectSnapshot(snapshot);
    canonicalizeSnapshot(payload);
    await ensureDirectories();
    const copies = await Promise.all([paths.liveCurrent, paths.liveMirror].map(readLiveCopy));
    const revision = Math.max(0, ...copies.filter((copy) => copy.status === 'ok').map((copy) => copy.value.revision)) + 1;
    const value = sealPayload({ ...payload, revision });
    await writeJsonAtomic(paths.liveCurrent, value, { fs });
    await writeJsonAtomic(paths.liveMirror, value, { fs });
    return value;
  }

  async function readCheckpoint(id) {
    requireSafeId(id);
    const result = await readJson(path.join(paths.checkpointsDir, `${id}.json`), fs);
    if (result.status !== 'ok') return result;
    const validation = validateCheckpoint(result.value);
    if (!validation.ok) return { status: 'corrupt', error: validation.error };
    if (validation.value.id !== id) return { status: 'corrupt', error: 'checkpoint id does not match filename' };
    if (validation.value.environment.id !== id) return { status: 'corrupt', error: 'checkpoint environment id does not match filename' };
    return { status: 'ok', value: validation.value };
  }

  async function listCheckpoints() {
    let names;
    try {
      names = await fs.readdir(paths.checkpointsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const rows = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id) || id === '.' || id === '..') return { status: 'corrupt', id, error: 'checkpoint filename is not a safe id' };
      const result = await readCheckpoint(id);
      return result.status === 'ok' ? { status: 'ok', id, value: result.value } : { status: 'corrupt', id, error: result.error };
    }));
    return rows.sort((a, b) => {
      if (a.status === 'ok' && b.status === 'ok') return Date.parse(b.value.archivedAt) - Date.parse(a.value.archivedAt);
      if (a.status === 'ok') return -1;
      if (b.status === 'ok') return 1;
      return a.id.localeCompare(b.id);
    });
  }

  async function readLatestCheckpoint() {
    const pointer = await readJson(paths.latest, fs);
    let warning;
    if (pointer.status === 'ok') {
      try {
        requireSafeId(pointer.value?.checkpointId);
        if (typeof pointer.value.payloadHash !== 'string') throw new Error('invalid latest payloadHash');
        const pointed = await readCheckpoint(pointer.value.checkpointId);
        if (pointed.status === 'ok' && pointed.value.payloadHash === pointer.value.payloadHash) return pointed;
        warning = `latest checkpoint is ${pointed.status === 'ok' ? 'hash-mismatched' : pointed.status}`;
      } catch (error) {
        warning = `latest pointer is corrupt: ${errorMessage(error)}`;
      }
    } else if (pointer.status === 'corrupt') {
      warning = `latest pointer is corrupt: ${pointer.error}`;
    }

    const rows = await listCheckpoints();
    const fallback = rows.find((row) => row.status === 'ok');
    if (fallback) return { status: 'ok', value: fallback.value, ...(warning ? { warning } : {}) };
    if (pointer.status === 'missing' && rows.length === 0) return { status: 'missing' };
    return { status: 'corrupt', error: warning ?? 'no valid checkpoint' };
  }

  async function readRecovery(checkpointId) {
    requireSafeId(checkpointId);
    return readValidated(path.join(paths.recoveryDir, `${checkpointId}.json`), fs, (value) => validateRecovery(value, checkpointId));
  }

  async function createRecovery(checkpointId, detectedAt) {
    requireSafeId(checkpointId);
    const existing = await readRecovery(checkpointId);
    if (existing.status === 'ok') return existing;
    if (existing.status === 'corrupt') throw new Error(existing.error);
    const checkpoint = await readCheckpoint(checkpointId);
    if (checkpoint.status !== 'ok') return checkpoint;
    if (typeof detectedAt !== 'string' || Number.isNaN(Date.parse(detectedAt))) throw new Error('detectedAt must be an ISO timestamp');
    const initialSessionIds = checkpoint.value.sessions.map((session) => session.id);
    const value = {
      checkpointId,
      detectedAt,
      expiresAt: new Date(Date.parse(detectedAt) + RECOVERY_WINDOW_MS).toISOString(),
      initialSessionIds,
      pendingSessionIds: [...initialSessionIds],
      resolvedAt: null,
      mapping: null,
    };
    await ensureDirectories();
    await writeJsonAtomic(path.join(paths.recoveryDir, `${checkpointId}.json`), value, { fs });
    return { status: 'ok', value };
  }

  async function resolveSessions(checkpointId, ids) {
    if (!Array.isArray(ids)) throw new Error('resolved session ids must be an array');
    const recovery = await readRecovery(checkpointId);
    if (recovery.status !== 'ok') return recovery;
    if (recovery.value.resolvedAt !== null) return recovery;
    const resolved = new Set(ids);
    const pendingSessionIds = recovery.value.pendingSessionIds.filter((id) => !resolved.has(id));
    if (pendingSessionIds.length === recovery.value.pendingSessionIds.length && pendingSessionIds.length > 0) return recovery;
    const value = {
      ...recovery.value,
      pendingSessionIds,
      resolvedAt: pendingSessionIds.length === 0 ? new Date(now()).toISOString() : null,
    };
    await writeJsonAtomic(path.join(paths.recoveryDir, `${checkpointId}.json`), value, { fs });
    return { status: 'ok', value };
  }

  async function writeOperation(operation) {
    requireSafeId(operation?.id);
    await ensureDirectories();
    await writeJsonAtomic(path.join(paths.operationsDir, `${operation.id}.json`), operation, { fs });
    return operation;
  }

  async function readOperation(id) {
    requireSafeId(id);
    return readJson(path.join(paths.operationsDir, `${id}.json`), fs);
  }

  async function prune() {
    const pointer = await readJson(paths.latest, fs);
    const latestId = pointer.status === 'ok' && typeof pointer.value?.checkpointId === 'string' ? pointer.value.checkpointId : undefined;
    const rows = await listCheckpoints();
    const retained = new Set(selectRetainedCheckpoints(rows, now(), latestId).map((row) => row.id));
    const canDeleteCorrupt = pointer.status === 'ok' && SAFE_ID.test(latestId ?? '');
    await Promise.all(rows.map(async (row) => {
      if (retained.has(row.id) || (row.status === 'corrupt' && !canDeleteCorrupt)) return;
      await fs.unlink(path.join(paths.checkpointsDir, `${row.id}.json`));
    }));
    return rows.filter((row) => retained.has(row.id));
  }

  async function archiveEnvironment({ endedReason, detectedAt }) {
    if (typeof endedReason !== 'string' || !endedReason) throw new Error('endedReason must be a non-empty string');
    if (typeof detectedAt !== 'string' || Number.isNaN(Date.parse(detectedAt))) throw new Error('detectedAt must be an ISO timestamp');
    const live = await readLive();
    if (live.status !== 'ok') return live;
    if (live.value.sessions.length === 0) return { status: 'empty' };
    const id = requireSafeId(live.value.environment.id);
    await ensureDirectories();
    let checkpoint = await readCheckpoint(id);
    if (checkpoint.status !== 'ok') {
      const { payloadHash: ignoredHash, revision: ignoredRevision, ...unsealed } = live.value;
      const value = sealPayload({
        ...unsealed,
        id,
        archivedAt: new Date(now()).toISOString(),
        environment: { ...unsealed.environment, endedReason },
      });
      await writeJsonAtomic(path.join(paths.checkpointsDir, `${id}.json`), value, { fs });
      checkpoint = { status: 'ok', value };
    }
    await writeJsonAtomic(paths.latest, { checkpointId: id, payloadHash: checkpoint.value.payloadHash }, { fs });
    await createRecovery(id, detectedAt);
    await prune().catch(() => {});
    return checkpoint;
  }

  return {
    paths,
    readLive,
    writeLive,
    archiveEnvironment,
    listCheckpoints,
    readCheckpoint,
    readLatestCheckpoint,
    readRecovery,
    createRecovery,
    resolveSessions,
    writeOperation,
    readOperation,
    prune,
  };
}
