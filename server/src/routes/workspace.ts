import express from 'express';
import { validateRecoveryMapping } from '../workspace/mapping.js';
import type { Request, RequestHandler, Response, Router } from 'express';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESTORE_FIELDS = new Set(['checkpointId', 'sessions']);
const CHANGE_REASONS = new Set(['boot-changed', 'tmux-changed']);
const OPERATION_STATUSES = new Set(['pending', 'running', 'succeeded', 'partial', 'failed', 'interrupted']);
const RESULT_STATUSES = new Set(['restored', 'already-present', 'failed']);
const RESULT_STAGES = new Set(['plan', 'topology', 'agent', 'restore', 'reconcile']);
const WARNING_CODES = new Set(['cwd-fallback', 'layout-fallback', 'agent-warning', 'live-reconcile-failed', 'workspace-unavailable', 'restore-warning']);
const ERROR_MESSAGES = {
  'restore-interrupted': 'restore was interrupted; retry the restore',
  'checkpoint-not-found': 'checkpoint is unavailable; choose another checkpoint',
  'storage-full': 'workspace storage is full; free disk space and retry',
  'permission-denied': 'workspace storage is not writable; check permissions and retry',
  'plan-failed': 'restore plan is no longer usable; refresh and retry',
  'agent-unavailable': 'agent resume failed; open the restored shell and retry manually',
  'tmux-unavailable': 'tmux is unavailable; retry the restore',
  'restore-failed': 'workspace restore failed; retry the restore',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorCode = keyof typeof ERROR_MESSAGES;
type WarningCode = 'cwd-fallback' | 'layout-fallback' | 'agent-warning' | 'live-reconcile-failed' | 'workspace-unavailable' | 'restore-warning';
type ResultStatus = 'restored' | 'already-present' | 'failed';
type ResultStage = 'plan' | 'topology' | 'agent' | 'restore' | 'reconcile';
type OperationStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
interface RestoreRequest { checkpointId: string; sessions?: string[] }
interface WorkspaceService {
  getProtectionStatus(): Promise<unknown>;
  listCheckpoints(): Promise<unknown>;
  getRestorePlan(request: RestoreRequest): Promise<unknown>;
  startRestore(request: RestoreRequest): Promise<unknown>;
  getOperation(operationId: string): Promise<unknown>;
}
interface WorkspaceRouteOptions { workspace: WorkspaceService }
interface AsyncHandlerOptions { checkpoint?: boolean }

const record = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && value !== '.' && value !== '..';
}

function isCheckpointMissing(error: unknown): boolean {
  const details = record(error);
  if (details?.code === 'WORKSPACE_CHECKPOINT_NOT_FOUND' || details?.status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:checkpoint.*(?:missing|not found)|no valid checkpoint)/i.test(message);
}

function sendFailure(res: Response, error: unknown, { checkpoint = false }: AsyncHandlerOptions = {}): Response {
  if (checkpoint && isCheckpointMissing(error)) {
    return res.status(404).json({ error: 'checkpoint not found' });
  }
  return res.status(500).json({ error: 'workspace unavailable' });
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<unknown> | unknown,
  options: AsyncHandlerOptions = {},
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendFailure(res, error, options);
    }
  };
}

function checkpointId(value: unknown, fallback: string | null): string | null {
  const id = value === undefined ? fallback : value;
  return isSafeId(id) ? id : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function displayName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function projectCheckpoint(row: unknown) {
  const source = record(row);
  const id = isSafeId(source?.id) ? source.id : null;
  const value = record(source?.value);
  if (source?.status !== 'ok' || !value) {
    const corrupt = source?.status === 'corrupt';
    return {
      status: corrupt ? 'corrupt' : 'unavailable',
      id,
      capturedAt: null,
      archivedAt: null,
      sessionCount: 0,
      windowCount: 0,
      paneCount: 0,
      agentCount: 0,
      endedReason: null,
      errorCode: corrupt ? 'checkpoint-corrupt' : 'checkpoint-unavailable',
    };
  }
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  const windows = Array.isArray(value.windows) ? value.windows : [];
  const panes = windows.flatMap((window) => {
    const item = record(window);
    return Array.isArray(item?.panes) ? item.panes : [];
  });
  const environment = record(value.environment);
  return {
    status: 'ok',
    id,
    capturedAt: timestamp(value.capturedAt),
    archivedAt: timestamp(value.archivedAt),
    sessionCount: sessions.length,
    windowCount: windows.length,
    paneCount: panes.length,
    agentCount: panes.filter((pane) => record(record(pane)?.agent) !== null).length,
    endedReason: typeof environment?.endedReason === 'string' && CHANGE_REASONS.has(environment.endedReason) ? environment.endedReason : null,
    errorCode: null,
  };
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase();
  if (error instanceof Error) return error.message.toLowerCase();
  return '';
}

function errorCode(
  error: unknown,
  { stage = null, status = null }: { stage?: ResultStage | null; status?: OperationStatus | ResultStatus | null } = {},
): ErrorCode | null {
  const text = errorText(error);
  if (status === 'interrupted' || /interrupt|process restart/.test(text)) return 'restore-interrupted';
  if (/enospc|disk full|no space/.test(text)) return 'storage-full';
  if (/eacces|eperm|permission|not writable/.test(text)) return 'permission-denied';
  if (/checkpoint.*(?:missing|not found|unavailable)/.test(text)) return 'checkpoint-not-found';
  if (stage === 'plan' || /restore plan|planning/.test(text)) return 'plan-failed';
  if (stage === 'agent' || /\b(?:agent|claude|codex)\b|command not found|cli unavailable/.test(text)) return 'agent-unavailable';
  if (stage === 'topology' || /\btmux\b|topology|server disappeared/.test(text)) return 'tmux-unavailable';
  if (text || status === 'failed') return 'restore-failed';
  return null;
}

function warningCode(warning: unknown): WarningCode {
  const text = errorText(warning);
  if (/live reconcile|reconcile.*(?:fail|unavailable)/.test(text)) return 'live-reconcile-failed';
  if (/\blayout\b/.test(text)) return 'layout-fallback';
  if (/\b(?:agent|claude|codex)\b|command not found|cli unavailable/.test(text)) return 'agent-warning';
  if (/\bcwd\b|\bdirectory\b|fallback.*home|missing.*path/.test(text)) return 'cwd-fallback';
  if (/enospc|disk full|no space|eacces|eperm|permission|not writable/.test(text)) return 'workspace-unavailable';
  return 'restore-warning';
}

function projectWarningCodes(value: unknown, existing: unknown): WarningCode[] {
  const codes: WarningCode[] = [];
  if (Array.isArray(existing)) {
    for (const code of existing) {
      if (typeof code === 'string' && WARNING_CODES.has(code)) codes.push(code as WarningCode);
    }
  }
  if (Array.isArray(value)) for (const warning of value) codes.push(warningCode(warning));
  return [...new Set(codes)];
}

function projectMapping(value: unknown, id: string | null) {
  if (!value || !id) return null;
  try {
    const mapping = validateRecoveryMapping(value, id);
    const copyEntries = (entries: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(entries));
    return {
      id: mapping.id,
      checkpointId: mapping.checkpointId,
      restoredAt: mapping.restoredAt,
      names: copyEntries(mapping.names),
      runtime: {
        sessions: copyEntries(mapping.runtime.sessions),
        windows: copyEntries(mapping.runtime.windows),
        panes: copyEntries(mapping.runtime.panes),
      },
      logical: {
        sessions: copyEntries(mapping.logical.sessions),
        windows: copyEntries(mapping.logical.windows),
        panes: copyEntries(mapping.logical.panes),
      },
    };
  } catch {
    return null;
  }
}

function projectResult(result: unknown) {
  const source = record(result);
  const status: ResultStatus = typeof source?.status === 'string' && RESULT_STATUSES.has(source.status)
    ? source.status as ResultStatus : 'failed';
  const stage: ResultStage | null = typeof source?.stage === 'string' && RESULT_STAGES.has(source.stage)
    ? source.stage as ResultStage : null;
  const code = errorCode(source?.error, { stage, status });
  return {
    logicalId: typeof source?.logicalId === 'string' && UUID.test(source.logicalId) ? source.logicalId : null,
    sourceName: displayName(source?.sourceName),
    targetName: displayName(source?.targetName),
    status,
    stage,
    errorCode: code,
    errorMessage: code ? ERROR_MESSAGES[code] : null,
    warningCodes: projectWarningCodes(source?.warnings, source?.warningCodes),
  };
}

function projectOperation(operation: unknown) {
  const source = record(operation);
  const request = record(source?.request) ?? {};
  const id = checkpointId(request.checkpointId, null);
  const status: OperationStatus = typeof source?.status === 'string' && OPERATION_STATUSES.has(source.status)
    ? source.status as OperationStatus : 'failed';
  const code = errorCode(source?.error, { status });
  const progress = record(source?.progress);
  const summary = record(source?.summary);
  return {
    id: isSafeId(source?.id) ? source.id : null,
    status,
    request: {
      checkpointId: id,
      sessions: Array.isArray(request.sessions) ? request.sessions.map(displayName).filter(Boolean) : [],
      historical: request.historical === true,
    },
    createdAt: timestamp(source?.createdAt),
    updatedAt: timestamp(source?.updatedAt),
    startedAt: timestamp(source?.startedAt),
    completedAt: timestamp(source?.completedAt),
    progress: {
      completed: count(progress?.completed),
      total: count(progress?.total),
    },
    summary: {
      sessions: count(summary?.sessions),
      windows: count(summary?.windows),
      panes: count(summary?.panes),
    },
    results: Array.isArray(source?.results) ? source.results.map(projectResult) : [],
    errorCode: code,
    errorMessage: code ? ERROR_MESSAGES[code] : null,
    warningCodes: projectWarningCodes(source?.warnings, source?.warningCodes),
    mapping: projectMapping(source?.mapping, id),
  };
}

function parseRestoreRequest(body: unknown): RestoreRequest | null {
  const source = record(body);
  if (!source || Object.keys(source).some((key) => !RESTORE_FIELDS.has(key))) return null;
  const id = checkpointId(source.checkpointId, 'latest');
  if (!id) return null;
  const request: RestoreRequest = { checkpointId: id };
  if (source.sessions !== undefined) {
    if (!Array.isArray(source.sessions)
      || source.sessions.some((name) => typeof name !== 'string' || !name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) {
      return null;
    }
    request.sessions = source.sessions as string[];
  }
  return request;
}

export function workspaceRoutes({ workspace }: WorkspaceRouteOptions): Router {
  const r = express.Router();

  r.get('/workspace/status', asyncHandler(async (_req, res) => {
    return res.json(await workspace.getProtectionStatus());
  }));

  r.get('/workspace/checkpoints', asyncHandler(async (_req, res) => {
    const checkpoints = await workspace.listCheckpoints();
    return res.json(Array.isArray(checkpoints) ? checkpoints.map(projectCheckpoint) : []);
  }));

  r.get('/workspace/restore-plan', asyncHandler(async (req, res) => {
    const id = checkpointId(req.query.checkpoint, 'latest');
    if (!id) return res.status(400).json({ error: 'bad checkpoint id' });
    // serverNow, promptEligible, pending recovery state, and mapping are runtime-authored. The route
    // deliberately passes them through without interpreting expiresAt using a client-supplied clock.
    return res.json(await workspace.getRestorePlan({ checkpointId: id }));
  }, { checkpoint: true }));

  r.post('/workspace/restore', asyncHandler(async (req, res) => {
    const restoreRequest = parseRestoreRequest(req.body);
    if (!restoreRequest) return res.status(400).json({ error: 'bad request' });
    return res.status(202).json(await workspace.startRestore(restoreRequest));
  }, { checkpoint: true }));

  r.get('/workspace/restore/:operationId', asyncHandler(async (req, res) => {
    if (!isSafeId(req.params.operationId)) return res.status(400).json({ error: 'bad operation id' });
    const operation = await workspace.getOperation(req.params.operationId);
    if (!operation) return res.status(404).json({ error: 'operation not found' });
    return res.json(projectOperation(operation));
  }));

  return r;
}
