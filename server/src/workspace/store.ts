import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir, writeJsonAtomic } from './atomicJson.js';
import { workspacePaths } from './paths.js';
import {
  canonicalizeSnapshot,
  fingerprintSnapshot,
  sealPayload,
  validateCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceSnapshot,
} from './schema.js';
import { validateRecoveryMapping, type RecoveryMapping } from './mapping.js';
import type { RestoreOperation } from './operations.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type WorkspaceFs = typeof fsp;
type JsonRead =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };
type LiveSnapshot = WorkspaceSnapshot & { revision: number; payloadHash: string };
type LiveCopyRead =
  | { status: 'ok'; value: LiveSnapshot }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };
type CheckpointRead =
  | { status: 'ok'; value: WorkspaceCheckpoint }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };
type CheckpointRow =
  | { status: 'ok'; id: string; value: WorkspaceCheckpoint }
  | { status: 'corrupt'; id: string; error: string };
type RetentionRow =
  | { status: 'ok'; id: string; value: { archivedAt: string } }
  | { status: 'corrupt'; id: string; error: string };
export interface WorkspaceRecovery {
  checkpointId: string;
  detectedAt: string;
  expiresAt: string;
  initialSessionIds: string[];
  pendingSessionIds: string[];
  resolvedAt: string | null;
  mapping: RecoveryMapping | null;
}
type RecoveryRead =
  | { status: 'ok'; value: WorkspaceRecovery }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };
type OperationRead =
  | { status: 'ok'; value: RestoreOperation }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };
type LiveRead =
  | { status: 'ok'; value: LiveSnapshot; repaired: boolean }
  | { status: 'empty' }
  | { status: 'corrupt'; errors: string[] };
type LatestCheckpointRead = CheckpointRead | { status: 'ok'; value: WorkspaceCheckpoint; warning: string };
type OperationRow =
  | { status: 'ok'; id: string; value: RestoreOperation }
  | { status: 'missing'; id: string }
  | { status: 'corrupt'; id: string; error: string };
interface WorkspaceStoreOptions {
  home: string;
  now?: () => number;
  fs?: WorkspaceFs;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function hasErrorCode(error: unknown, code: string): boolean {
  return recordOf(error)?.code === code;
}

function requireSafeId(id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id === '..') throw new Error('workspace id must be a safe filename');
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectObject(value: unknown, fields: readonly string[]): unknown {
  const record = recordOf(value);
  if (!record) return value;
  return Object.fromEntries(fields.map((field) => [field, record[field]]));
}

function projectSnapshot(input: unknown): unknown {
  const record = recordOf(input);
  if (!record) return input;
  const environment = projectObject(record.environment, ['id', 'bootIdentity', 'tmuxServerId']);
  const active = record.active === null ? null : projectObject(record.active, ['sessionId', 'windowId', 'paneId']);
  const sessions = Array.isArray(record.sessions) ? record.sessions.map((session) => {
    const projected = projectObject(session, ['id', 'runtimeId', 'name', 'windowLinks', 'activeWindowId']);
    const projectedRecord = recordOf(projected);
    if (!projectedRecord || !Array.isArray(projectedRecord.windowLinks)) return projected;
    projectedRecord.windowLinks = projectedRecord.windowLinks.map((link: unknown) => projectObject(link, ['windowId', 'index']));
    return projectedRecord;
  }) : record.sessions;
  const windows = Array.isArray(record.windows) ? record.windows.map((window) => {
    const projected = projectObject(window, ['id', 'runtimeId', 'name', 'index', 'layout', 'activePaneId', 'panes']);
    const projectedRecord = recordOf(projected);
    if (!projectedRecord || !Array.isArray(projectedRecord.panes)) return projected;
    projectedRecord.panes = projectedRecord.panes.map((pane: unknown) => {
      const projectedPane = projectObject(pane, ['id', 'runtimeId', 'index', 'cwd', 'agent']);
      const paneRecord = recordOf(projectedPane);
      if (!paneRecord) return projectedPane;
      if (paneRecord.agent !== null && paneRecord.agent !== undefined) {
        paneRecord.agent = projectObject(paneRecord.agent, ['id', 'sessionId', 'transcriptPath']);
      }
      return paneRecord;
    });
    return projectedRecord;
  }) : record.windows;
  return {
    schemaVersion: record.schemaVersion,
    capturedAt: record.capturedAt,
    environment,
    tmuxVersion: record.tmuxVersion,
    active,
    sessions,
    windows,
  };
}

function validateLive(value: unknown): { ok: true; value: LiveSnapshot } | { ok: false; error: string } {
  try {
    const record = recordOf(value);
    if (!record || !Number.isInteger(record.revision) || (record.revision as number) < 1) throw new Error('invalid live revision');
    if (typeof record.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.payloadHash)) throw new Error('invalid live payloadHash');
    if (fingerprintSnapshot(value) !== record.payloadHash) throw new Error('live hash mismatch');
    const canonical = canonicalizeSnapshot(value);
    return {
      ok: true,
      value: {
        ...canonical,
        revision: record.revision as number,
        payloadHash: record.payloadHash,
      },
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function readJson(file: string, fs: WorkspaceFs): Promise<JsonRead> {
  try {
    return { status: 'ok', value: JSON.parse(await fs.readFile(file, 'utf8')) as unknown };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { status: 'missing' };
    return { status: 'corrupt', error: errorMessage(error) };
  }
}

async function readValidated<T>(
  file: string,
  fs: WorkspaceFs,
  validate: (value: unknown) => T,
): Promise<{ status: 'ok'; value: T } | Exclude<JsonRead, { status: 'ok' }>> {
  const result = await readJson(file, fs);
  if (result.status !== 'ok') return result;
  try {
    const value = validate(result.value);
    return { status: 'ok', value };
  } catch (error) {
    return { status: 'corrupt', error: errorMessage(error) };
  }
}

function validateRecovery(value: unknown, checkpointId: string): WorkspaceRecovery {
  const record = recordOf(value);
  if (!record) throw new Error('invalid recovery state');
  if (record.checkpointId !== checkpointId) throw new Error('recovery checkpoint id mismatch');
  for (const field of ['detectedAt', 'expiresAt']) {
    const entry = record[field];
    if (typeof entry !== 'string' || Number.isNaN(Date.parse(entry))) throw new Error(`invalid recovery ${field}`);
  }
  for (const field of ['initialSessionIds', 'pendingSessionIds']) {
    const entry = record[field];
    if (!Array.isArray(entry) || entry.some((id) => typeof id !== 'string' || !id)) throw new Error(`invalid recovery ${field}`);
    if (new Set(entry).size !== entry.length) throw new Error(`duplicate recovery ${field}`);
  }
  const initialSessionIds = record.initialSessionIds as string[];
  const pendingSessionIds = record.pendingSessionIds as string[];
  const initial = new Set(initialSessionIds);
  if (pendingSessionIds.some((id) => !initial.has(id))) throw new Error('recovery pending ids must be initial ids');
  if (record.resolvedAt !== null && (typeof record.resolvedAt !== 'string' || Number.isNaN(Date.parse(record.resolvedAt)))) throw new Error('invalid recovery resolvedAt');
  if (record.resolvedAt !== null && pendingSessionIds.length > 0) throw new Error('resolved recovery cannot contain pending session ids');
  let mapping: RecoveryMapping | null = null;
  if (record.mapping !== null) {
    mapping = validateRecoveryMapping(record.mapping, checkpointId);
  }
  return {
    checkpointId,
    detectedAt: record.detectedAt as string,
    expiresAt: record.expiresAt as string,
    initialSessionIds,
    pendingSessionIds,
    resolvedAt: record.resolvedAt as string | null,
    mapping,
  };
}

export function selectRetainedCheckpoints(
  rows: RetentionRow[],
  now: number,
  latestId?: string,
): RetentionRow[] {
  const valid = rows
    .filter((row): row is Extract<RetentionRow, { status: 'ok' }> => (
      row.status === 'ok' && Number.isFinite(Date.parse(row.value.archivedAt))
    ))
    .sort((a, b) => Date.parse(b.value.archivedAt) - Date.parse(a.value.archivedAt));
  const retained: RetentionRow[] = [];
  const retainedIds = new Set<string>();
  const keep = (row: RetentionRow | undefined): void => {
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

export function createWorkspaceStore({ home, now = Date.now, fs = fsp }: WorkspaceStoreOptions) {
  const paths = workspacePaths(home);

  async function ensureDirectories(): Promise<void> {
    for (const dir of [path.dirname(paths.root), paths.root, paths.liveDir, paths.checkpointsDir, paths.recoveryDir, paths.operationsDir]) {
      await ensurePrivateDir(dir, { fs });
    }
  }

  async function readLiveCopy(file: string): Promise<LiveCopyRead> {
    const result = await readJson(file, fs);
    if (result.status !== 'ok') return result;
    const validated = validateLive(result.value);
    return validated.ok ? { status: 'ok', value: validated.value } : { status: 'corrupt', error: validated.error };
  }

  async function readLive(): Promise<LiveRead> {
    const copies = await Promise.all([paths.liveCurrent, paths.liveMirror].map(readLiveCopy));
    const valid = copies
      .map((result, index) => ({ ...result, index }))
      .filter((result): result is { status: 'ok'; value: LiveSnapshot; index: number } => result.status === 'ok')
      .sort((a, b) => b.value.revision - a.value.revision || a.index - b.index);
    if (valid.length === 0) {
      if (copies.every((copy) => copy.status === 'missing')) return { status: 'empty' };
      return { status: 'corrupt', errors: copies.map((copy) => copy.status === 'corrupt' ? copy.error : copy.status) };
    }

    const chosenCopy = valid[0];
    if (!chosenCopy) return { status: 'corrupt', errors: ['missing valid live copy'] };
    const chosen = chosenCopy.value;
    let repaired = false;
    await ensureDirectories();
    for (let index = 0; index < copies.length; index += 1) {
      const copy = copies[index];
      if (copy?.status === 'ok' && copy.value.revision === chosen.revision && copy.value.payloadHash === chosen.payloadHash) continue;
      await writeJsonAtomic(index === 0 ? paths.liveCurrent : paths.liveMirror, chosen, { fs });
      repaired = true;
    }
    return { status: 'ok', value: chosen, repaired };
  }

  async function writeLive(snapshot: unknown): Promise<LiveSnapshot> {
    const payload = canonicalizeSnapshot(projectSnapshot(snapshot));
    await ensureDirectories();
    const copies = await Promise.all([paths.liveCurrent, paths.liveMirror].map(readLiveCopy));
    const revision = Math.max(0, ...copies
      .filter((copy): copy is Extract<LiveCopyRead, { status: 'ok' }> => copy.status === 'ok')
      .map((copy) => copy.value.revision)) + 1;
    const value = { ...sealPayload({ ...payload, revision }), revision };
    await writeJsonAtomic(paths.liveCurrent, value, { fs });
    await writeJsonAtomic(paths.liveMirror, value, { fs });
    return value;
  }

  async function readCheckpoint(id: string): Promise<CheckpointRead> {
    requireSafeId(id);
    const result = await readJson(path.join(paths.checkpointsDir, `${id}.json`), fs);
    if (result.status !== 'ok') return result;
    const validation = validateCheckpoint(result.value);
    if (!validation.ok) return { status: 'corrupt', error: validation.error };
    if (validation.value.id !== id) return { status: 'corrupt', error: 'checkpoint id does not match filename' };
    if (validation.value.environment.id !== id) return { status: 'corrupt', error: 'checkpoint environment id does not match filename' };
    return { status: 'ok', value: validation.value };
  }

  async function listCheckpoints(): Promise<CheckpointRow[]> {
    let names: string[];
    try {
      names = await fs.readdir(paths.checkpointsDir);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw error;
    }
    const rows = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id) || id === '.' || id === '..') {
        return { status: 'corrupt' as const, id, error: 'checkpoint filename is not a safe id' };
      }
      const result = await readCheckpoint(id);
      if (result.status === 'ok') return { status: 'ok' as const, id, value: result.value };
      return { status: 'corrupt' as const, id, error: result.status === 'corrupt' ? result.error : result.status };
    }));
    return rows.sort((a, b) => {
      if (a.status === 'ok' && b.status === 'ok') return Date.parse(b.value.archivedAt) - Date.parse(a.value.archivedAt);
      if (a.status === 'ok') return -1;
      if (b.status === 'ok') return 1;
      return a.id.localeCompare(b.id);
    });
  }

  async function readLatestCheckpoint(): Promise<LatestCheckpointRead> {
    const pointer = await readJson(paths.latest, fs);
    let warning: string | undefined;
    if (pointer.status === 'ok') {
      try {
        const pointerRecord = recordOf(pointer.value);
        const checkpointId = requireSafeId(pointerRecord?.checkpointId);
        if (typeof pointerRecord?.payloadHash !== 'string') throw new Error('invalid latest payloadHash');
        const pointed = await readCheckpoint(checkpointId);
        if (pointed.status === 'ok' && pointed.value.payloadHash === pointerRecord.payloadHash) return pointed;
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

  async function readRecovery(checkpointId: string): Promise<RecoveryRead> {
    requireSafeId(checkpointId);
    return readValidated(path.join(paths.recoveryDir, `${checkpointId}.json`), fs, (value) => validateRecovery(value, checkpointId));
  }

  async function createRecovery(checkpointId: string, detectedAt: string): Promise<RecoveryRead | CheckpointRead> {
    requireSafeId(checkpointId);
    const existing = await readRecovery(checkpointId);
    if (existing.status === 'ok') return existing;
    if (existing.status === 'corrupt') throw new Error(existing.error);
    const checkpoint = await readCheckpoint(checkpointId);
    if (checkpoint.status !== 'ok') return checkpoint;
    if (typeof detectedAt !== 'string' || Number.isNaN(Date.parse(detectedAt))) throw new Error('detectedAt must be an ISO timestamp');
    const initialSessionIds = checkpoint.value.sessions.map((session) => session.id);
    const value: WorkspaceRecovery = {
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

  async function resolveSessions(checkpointId: string, ids: unknown): Promise<RecoveryRead> {
    if (!Array.isArray(ids)) throw new Error('resolved session ids must be an array');
    const recovery = await readRecovery(checkpointId);
    if (recovery.status !== 'ok') return recovery;
    if (recovery.value.resolvedAt !== null) return recovery;
    const resolved = new Set(ids.filter((id): id is string => typeof id === 'string'));
    const pendingSessionIds = recovery.value.pendingSessionIds.filter((id) => !resolved.has(id));
    if (pendingSessionIds.length === recovery.value.pendingSessionIds.length && pendingSessionIds.length > 0) return recovery;
    const value: WorkspaceRecovery = {
      ...recovery.value,
      pendingSessionIds,
      resolvedAt: pendingSessionIds.length === 0 ? new Date(now()).toISOString() : null,
    };
    await writeJsonAtomic(path.join(paths.recoveryDir, `${checkpointId}.json`), value, { fs });
    return { status: 'ok', value };
  }

  async function mergeRecoveryMapping(checkpointId: string, mapping: unknown): Promise<RecoveryRead> {
    const recovery = await readRecovery(checkpointId);
    if (recovery.status !== 'ok') return recovery;
    const validatedMapping = validateRecoveryMapping(mapping, checkpointId);
    const value = validateRecovery({ ...recovery.value, mapping: validatedMapping }, checkpointId);
    await writeJsonAtomic(path.join(paths.recoveryDir, `${checkpointId}.json`), value, { fs });
    return { status: 'ok', value };
  }

  async function writeOperation(operation: RestoreOperation): Promise<RestoreOperation> {
    requireSafeId(operation?.id);
    await ensureDirectories();
    await writeJsonAtomic(path.join(paths.operationsDir, `${operation.id}.json`), operation, { fs });
    return operation;
  }

  async function readOperation(id: string): Promise<OperationRead> {
    requireSafeId(id);
    const result = await readJson(path.join(paths.operationsDir, `${id}.json`), fs);
    return result.status === 'ok'
      ? { status: 'ok', value: result.value as RestoreOperation }
      : result;
  }

  async function listOperations(): Promise<OperationRow[]> {
    let names: string[];
    try {
      names = await fs.readdir(paths.operationsDir);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw error;
    }
    return Promise.all(names.filter((name) => name.endsWith('.json')).sort().map(async (name) => {
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id) || id === '.' || id === '..') return { status: 'corrupt', id, error: 'operation filename is not a safe id' };
      const result = await readOperation(id);
      if (result.status !== 'ok') return { ...result, id };
      const value = recordOf(result.value);
      if (value?.id !== id) return { status: 'corrupt', id, error: 'operation id does not match filename' };
      return { status: 'ok', id, value: value as unknown as RestoreOperation };
    }));
  }

  async function prune() {
    const pointer = await readJson(paths.latest, fs);
    const pointerRecord = pointer.status === 'ok' ? recordOf(pointer.value) : null;
    const latestId = typeof pointerRecord?.checkpointId === 'string' ? pointerRecord.checkpointId : undefined;
    const rows = await listCheckpoints();
    const retained = new Set(selectRetainedCheckpoints(rows, now(), latestId).map((row) => row.id));
    const canDeleteCorrupt = pointer.status === 'ok' && SAFE_ID.test(latestId ?? '');
    await Promise.all(rows.map(async (row) => {
      if (retained.has(row.id) || (row.status === 'corrupt' && !canDeleteCorrupt)) return;
      await fs.unlink(path.join(paths.checkpointsDir, `${row.id}.json`));
    }));
    return rows.filter((row) => retained.has(row.id));
  }

  async function archiveEnvironment({ endedReason, detectedAt }: {
    endedReason: string;
    detectedAt: string;
  }): Promise<CheckpointRead | LiveRead | { status: 'empty' }> {
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
      const sealed = sealPayload({
        ...unsealed,
        id,
        archivedAt: new Date(now()).toISOString(),
        environment: { ...unsealed.environment, endedReason },
      });
      const validation = validateCheckpoint(sealed);
      if (!validation.ok) throw new Error(validation.error);
      const value = validation.value;
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
    mergeRecoveryMapping,
    writeOperation,
    readOperation,
    listOperations,
    prune,
  };
}
