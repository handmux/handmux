import express from 'express';
import { validateRecoveryMapping } from '../workspace/mapping.js';

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
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) && value !== '.' && value !== '..';
}

function isCheckpointMissing(error) {
  if (error?.code === 'WORKSPACE_CHECKPOINT_NOT_FOUND' || error?.status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:checkpoint.*(?:missing|not found)|no valid checkpoint)/i.test(message);
}

function sendFailure(res, error, { checkpoint = false } = {}) {
  if (checkpoint && isCheckpointMissing(error)) {
    return res.status(404).json({ error: 'checkpoint not found' });
  }
  return res.status(500).json({ error: 'workspace unavailable' });
}

function asyncHandler(handler, options) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendFailure(res, error, options);
    }
  };
}

function checkpointId(value, fallback) {
  const id = value === undefined ? fallback : value;
  return isSafeId(id) ? id : null;
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function displayName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\x00-\x1f\x7f/\\]/.test(value) ? value : null;
}

function projectCheckpoint(row) {
  const id = isSafeId(row?.id) ? row.id : null;
  if (row?.status !== 'ok' || !row.value || typeof row.value !== 'object' || Array.isArray(row.value)) {
    const corrupt = row?.status === 'corrupt';
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
  const sessions = Array.isArray(row.value.sessions) ? row.value.sessions : [];
  const windows = Array.isArray(row.value.windows) ? row.value.windows : [];
  const panes = windows.flatMap((window) => Array.isArray(window?.panes) ? window.panes : []);
  return {
    status: 'ok',
    id,
    capturedAt: timestamp(row.value.capturedAt),
    archivedAt: timestamp(row.value.archivedAt),
    sessionCount: sessions.length,
    windowCount: windows.length,
    paneCount: panes.length,
    agentCount: panes.filter((pane) => pane?.agent && typeof pane.agent === 'object' && !Array.isArray(pane.agent)).length,
    endedReason: CHANGE_REASONS.has(row.value.environment?.endedReason) ? row.value.environment.endedReason : null,
    errorCode: null,
  };
}

function errorText(error) {
  if (typeof error === 'string') return error.toLowerCase();
  if (error instanceof Error) return error.message.toLowerCase();
  return '';
}

function errorCode(error, { stage = null, status = null } = {}) {
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

function warningCode(warning) {
  const text = errorText(warning);
  if (/live reconcile|reconcile.*(?:fail|unavailable)/.test(text)) return 'live-reconcile-failed';
  if (/\blayout\b/.test(text)) return 'layout-fallback';
  if (/\b(?:agent|claude|codex)\b|command not found|cli unavailable/.test(text)) return 'agent-warning';
  if (/\bcwd\b|\bdirectory\b|fallback.*home|missing.*path/.test(text)) return 'cwd-fallback';
  if (/enospc|disk full|no space|eacces|eperm|permission|not writable/.test(text)) return 'workspace-unavailable';
  return 'restore-warning';
}

function projectWarningCodes(value, existing) {
  const codes = [];
  if (Array.isArray(existing)) {
    for (const code of existing) if (WARNING_CODES.has(code)) codes.push(code);
  }
  if (Array.isArray(value)) for (const warning of value) codes.push(warningCode(warning));
  return [...new Set(codes)];
}

function projectMapping(value, id) {
  if (!value || !id) return null;
  try {
    const mapping = validateRecoveryMapping(value, id);
    const record = (entries) => Object.fromEntries(Object.entries(entries));
    return {
      id: mapping.id,
      checkpointId: mapping.checkpointId,
      restoredAt: mapping.restoredAt,
      names: record(mapping.names),
      runtime: {
        sessions: record(mapping.runtime.sessions),
        windows: record(mapping.runtime.windows),
        panes: record(mapping.runtime.panes),
      },
      logical: {
        sessions: record(mapping.logical.sessions),
        windows: record(mapping.logical.windows),
        panes: record(mapping.logical.panes),
      },
    };
  } catch {
    return null;
  }
}

function projectResult(result) {
  const status = RESULT_STATUSES.has(result?.status) ? result.status : 'failed';
  const stage = RESULT_STAGES.has(result?.stage) ? result.stage : null;
  const code = errorCode(result?.error, { stage, status });
  return {
    logicalId: typeof result?.logicalId === 'string' && UUID.test(result.logicalId) ? result.logicalId : null,
    sourceName: displayName(result?.sourceName),
    targetName: displayName(result?.targetName),
    status,
    stage,
    errorCode: code,
    errorMessage: code ? ERROR_MESSAGES[code] : null,
    warningCodes: projectWarningCodes(result?.warnings, result?.warningCodes),
  };
}

function projectOperation(operation) {
  const request = operation?.request && typeof operation.request === 'object' && !Array.isArray(operation.request)
    ? operation.request : {};
  const id = checkpointId(request.checkpointId, null);
  const status = OPERATION_STATUSES.has(operation?.status) ? operation.status : 'failed';
  const code = errorCode(operation?.error, { status });
  return {
    id: isSafeId(operation?.id) ? operation.id : null,
    status,
    request: {
      checkpointId: id,
      sessions: Array.isArray(request.sessions) ? request.sessions.map(displayName).filter(Boolean) : [],
      historical: request.historical === true,
    },
    createdAt: timestamp(operation?.createdAt),
    updatedAt: timestamp(operation?.updatedAt),
    startedAt: timestamp(operation?.startedAt),
    completedAt: timestamp(operation?.completedAt),
    progress: {
      completed: count(operation?.progress?.completed),
      total: count(operation?.progress?.total),
    },
    results: Array.isArray(operation?.results) ? operation.results.map(projectResult) : [],
    errorCode: code,
    errorMessage: code ? ERROR_MESSAGES[code] : null,
    warningCodes: projectWarningCodes(operation?.warnings, operation?.warningCodes),
    mapping: projectMapping(operation?.mapping, id),
  };
}

function parseRestoreRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !RESTORE_FIELDS.has(key))) return null;
  const id = checkpointId(body.checkpointId, 'latest');
  if (!id) return null;
  const request = { checkpointId: id };
  if (body.sessions !== undefined) {
    if (!Array.isArray(body.sessions)
      || body.sessions.some((name) => typeof name !== 'string' || !name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) {
      return null;
    }
    request.sessions = body.sessions;
  }
  return request;
}

export function workspaceRoutes({ workspace }) {
  const r = express.Router();

  r.get('/workspace/status', asyncHandler(async (_req, res) => {
    res.json(await workspace.getProtectionStatus());
  }));

  r.get('/workspace/checkpoints', asyncHandler(async (_req, res) => {
    const checkpoints = await workspace.listCheckpoints();
    res.json(Array.isArray(checkpoints) ? checkpoints.map(projectCheckpoint) : []);
  }));

  r.get('/workspace/restore-plan', asyncHandler(async (req, res) => {
    const id = checkpointId(req.query.checkpoint, 'latest');
    if (!id) return res.status(400).json({ error: 'bad checkpoint id' });
    // serverNow, promptEligible, pending recovery state, and mapping are runtime-authored. The route
    // deliberately passes them through without interpreting expiresAt using a client-supplied clock.
    res.json(await workspace.getRestorePlan({ checkpointId: id }));
  }, { checkpoint: true }));

  r.post('/workspace/restore', asyncHandler(async (req, res) => {
    const restoreRequest = parseRestoreRequest(req.body);
    if (!restoreRequest) return res.status(400).json({ error: 'bad request' });
    res.status(202).json(await workspace.startRestore(restoreRequest));
  }, { checkpoint: true }));

  r.get('/workspace/restore/:operationId', asyncHandler(async (req, res) => {
    if (!isSafeId(req.params.operationId)) return res.status(400).json({ error: 'bad operation id' });
    const operation = await workspace.getOperation(req.params.operationId);
    if (!operation) return res.status(404).json({ error: 'operation not found' });
    res.json(projectOperation(operation));
  }));

  return r;
}
