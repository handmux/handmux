const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESTORE_REQUEST_FIELDS = new Set(['checkpointId', 'sessions']);

const PROTECTION_STATUSES = ['protected', 'unprotected', 'degraded'] as const;
const PLAN_ACTIONS = ['create', 'create-renamed', 'already-present', 'unsupported'] as const;
const OPERATION_STATUSES = ['pending', 'running', 'succeeded', 'partial', 'failed', 'interrupted'] as const;
const RESULT_STATUSES = ['restored', 'already-present', 'failed'] as const;
const RESULT_STAGES = ['plan', 'topology', 'agent', 'restore', 'reconcile'] as const;

export type WorkspaceProtectionStatusName = (typeof PROTECTION_STATUSES)[number];
export type WorkspacePlanAction = (typeof PLAN_ACTIONS)[number];
export type WorkspaceOperationStatus = (typeof OPERATION_STATUSES)[number];
export type WorkspaceResultStatus = (typeof RESULT_STATUSES)[number];
export type WorkspaceResultStage = (typeof RESULT_STAGES)[number];

export interface WorkspaceRestoreRequest {
  checkpointId: string;
  sessions?: string[];
}

export interface WorkspaceProtectionStatus {
  [key: string]: unknown;
  status?: WorkspaceProtectionStatusName;
  lastSuccessfulCaptureAt?: string | null;
  errorCode?: string | null;
}

export interface WorkspaceRestoreStart {
  [key: string]: unknown;
  operationId?: string;
  status?: WorkspaceOperationStatus;
  reused?: boolean;
}

export interface WorkspaceCounts {
  sessions?: number;
  windows?: number;
  panes?: number;
  agents?: number;
}

export interface WorkspacePlanSummary extends WorkspaceCounts {
  create?: number;
  renamed?: number;
  alreadyPresent?: number;
  unsupported?: number;
}

export interface WorkspacePlanSession {
  logicalId?: string | null;
  sourceName?: string | null;
  targetName?: string | null;
  action?: WorkspacePlanAction | null;
}

export interface WorkspaceRecoveryPlan {
  [key: string]: unknown;
  checkpointId?: string | null;
  capturedAt?: string | null;
  changeReason?: string | null;
  serverNow?: string | null;
  expiresAt?: string | null;
  promptEligible?: boolean;
  resolved?: boolean;
  pendingCount?: number | null;
  summary?: WorkspaceCounts;
  planSummary?: WorkspacePlanSummary;
  sessions?: WorkspacePlanSession[];
  warningCodes?: string[];
  mapping?: unknown;
}

export interface WorkspaceRestoreResult extends WorkspacePlanSession {
  [key: string]: unknown;
  status?: WorkspaceResultStatus | null;
  stage?: WorkspaceResultStage | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  warningCodes?: string[];
}

export interface WorkspaceRestoreOperation {
  [key: string]: unknown;
  id?: string;
  status?: WorkspaceOperationStatus | null;
  request?: WorkspaceRestoreRequest & { historical?: boolean };
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  progress?: { completed?: number; total?: number };
  summary?: WorkspaceCounts;
  results?: WorkspaceRestoreResult[];
  errorCode?: string | null;
  errorMessage?: string | null;
  warningCodes?: string[];
  mapping?: unknown;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const memberOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => (
  typeof value === 'string' && values.includes(value as T) ? value as T : undefined
);

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const optionalString = (value: unknown): string | null | undefined => (
  typeof value === 'string' ? value : value === null ? null : undefined
);

const stringArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

const optionalField = <K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } => (
  value === undefined ? {} : { [key]: value } as { [P in K]: V }
);

export function isWorkspaceSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && value !== '.' && value !== '..';
}

export function parseWorkspaceRestoreRequest(
  value: unknown,
  defaultCheckpointId = 'latest',
): WorkspaceRestoreRequest | null {
  const request = recordOf(value);
  if (!request || Object.keys(request).some((key) => !RESTORE_REQUEST_FIELDS.has(key))) return null;
  const checkpointId = request.checkpointId === undefined
    ? defaultCheckpointId
    : request.checkpointId;
  if (!isWorkspaceSafeId(checkpointId)) return null;
  const parsed: WorkspaceRestoreRequest = { checkpointId };
  if (request.sessions !== undefined) {
    if (!Array.isArray(request.sessions)
      || request.sessions.some((name) => typeof name !== 'string' || !name || name.length > 256
        || /[\x00-\x1f\x7f]/.test(name))) return null;
    parsed.sessions = [...request.sessions] as string[];
  }
  return parsed;
}

export function parseWorkspaceProtectionStatus(value: unknown): WorkspaceProtectionStatus | null {
  const status = recordOf(value);
  if (!status) return null;
  return {
    ...optionalField('status', memberOf(PROTECTION_STATUSES, status.status)),
    ...optionalField('lastSuccessfulCaptureAt', optionalString(status.lastSuccessfulCaptureAt)),
    ...optionalField('errorCode', optionalString(status.errorCode)),
  };
}

export function parseWorkspaceRestoreStart(value: unknown): WorkspaceRestoreStart | null {
  const start = recordOf(value);
  if (!start) return null;
  return {
    ...optionalField('operationId', typeof start.operationId === 'string' ? start.operationId : undefined),
    ...optionalField('status', memberOf(OPERATION_STATUSES, start.status)),
    ...optionalField('reused', typeof start.reused === 'boolean' ? start.reused : undefined),
  };
}

const countsOf = (value: unknown): WorkspaceCounts | undefined => {
  const counts = recordOf(value);
  if (!counts) return undefined;
  return {
    ...optionalField('sessions', finiteNumber(counts.sessions)),
    ...optionalField('windows', finiteNumber(counts.windows)),
    ...optionalField('panes', finiteNumber(counts.panes)),
    ...optionalField('agents', finiteNumber(counts.agents)),
  };
};

const planSessionOf = (value: unknown): WorkspacePlanSession | null => {
  const session = recordOf(value);
  return session ? {
    ...optionalField('logicalId', optionalString(session.logicalId)),
    ...optionalField('sourceName', optionalString(session.sourceName)),
    ...optionalField('targetName', optionalString(session.targetName)),
    ...optionalField('action', session.action === null ? null : memberOf(PLAN_ACTIONS, session.action)),
  } : null;
};

export function parseWorkspaceRecoveryPlan(value: unknown): WorkspaceRecoveryPlan | null {
  const plan = recordOf(value);
  if (!plan) return null;
  const rawPlanSummary = recordOf(plan.planSummary);
  const summary = countsOf(plan.summary);
  const planSummary: WorkspacePlanSummary | undefined = rawPlanSummary ? {
    ...countsOf(rawPlanSummary),
    ...optionalField('create', finiteNumber(rawPlanSummary.create)),
    ...optionalField('renamed', finiteNumber(rawPlanSummary.renamed)),
    ...optionalField('alreadyPresent', finiteNumber(rawPlanSummary.alreadyPresent)),
    ...optionalField('unsupported', finiteNumber(rawPlanSummary.unsupported)),
  } : undefined;
  const pendingCount = finiteNumber(plan.pendingCount)
    ?? (plan.pendingCount === null ? null : undefined);
  return {
    ...optionalField('checkpointId', optionalString(plan.checkpointId)),
    ...optionalField('capturedAt', optionalString(plan.capturedAt)),
    ...optionalField('changeReason', optionalString(plan.changeReason)),
    ...optionalField('serverNow', optionalString(plan.serverNow)),
    ...optionalField('expiresAt', optionalString(plan.expiresAt)),
    ...optionalField('promptEligible', typeof plan.promptEligible === 'boolean' ? plan.promptEligible : undefined),
    ...optionalField('resolved', typeof plan.resolved === 'boolean' ? plan.resolved : undefined),
    ...optionalField('pendingCount', pendingCount),
    ...optionalField('summary', summary),
    ...optionalField('planSummary', planSummary),
    ...(Array.isArray(plan.sessions) ? { sessions: plan.sessions.flatMap((session) => {
      const parsed = planSessionOf(session);
      return parsed ? [parsed] : [];
    }) } : {}),
    ...(Array.isArray(plan.warningCodes) ? { warningCodes: stringArray(plan.warningCodes) } : {}),
    ...(plan.mapping !== undefined ? { mapping: plan.mapping } : {}),
  };
}

export function parseWorkspaceRestoreOperation(value: unknown): WorkspaceRestoreOperation | null {
  const operation = recordOf(value);
  if (!operation) return null;
  const progress = recordOf(operation.progress);
  const request = recordOf(operation.request);
  const results: WorkspaceRestoreResult[] = Array.isArray(operation.results)
    ? operation.results.flatMap((candidate): WorkspaceRestoreResult[] => {
      const result = recordOf(candidate);
      const session = planSessionOf(candidate);
      if (!result || !session) return [];
      return [{
        ...session,
        ...optionalField('status', result.status === null ? null : memberOf(RESULT_STATUSES, result.status)),
        ...optionalField('stage', result.stage === null ? null : memberOf(RESULT_STAGES, result.stage)),
        ...optionalField('errorCode', optionalString(result.errorCode)),
        ...optionalField('errorMessage', optionalString(result.errorMessage)),
        warningCodes: stringArray(result.warningCodes),
      }];
    }) : [];
  const parsedProgress = progress ? {
    ...optionalField('completed', finiteNumber(progress.completed)),
    ...optionalField('total', finiteNumber(progress.total)),
  } : undefined;
  const checkpointId = typeof request?.checkpointId === 'string' ? request.checkpointId : undefined;
  const parsedRequest = request && checkpointId ? {
    checkpointId,
    ...(Array.isArray(request.sessions) ? { sessions: stringArray(request.sessions) } : {}),
    ...(typeof request.historical === 'boolean' ? { historical: request.historical } : {}),
  } : undefined;
  return {
    ...(typeof operation.id === 'string' ? { id: operation.id } : {}),
    ...optionalField('status', operation.status === null ? null : memberOf(OPERATION_STATUSES, operation.status)),
    ...optionalField('request', parsedRequest),
    ...optionalField('createdAt', optionalString(operation.createdAt)),
    ...optionalField('updatedAt', optionalString(operation.updatedAt)),
    ...optionalField('startedAt', optionalString(operation.startedAt)),
    ...optionalField('completedAt', optionalString(operation.completedAt)),
    ...optionalField('progress', parsedProgress),
    ...optionalField('summary', countsOf(operation.summary)),
    ...(Array.isArray(operation.results) ? { results } : {}),
    ...optionalField('errorCode', optionalString(operation.errorCode)),
    ...optionalField('errorMessage', optionalString(operation.errorMessage)),
    ...(Array.isArray(operation.warningCodes) ? { warningCodes: stringArray(operation.warningCodes) } : {}),
    ...(operation.mapping !== undefined ? { mapping: operation.mapping } : {}),
  };
}
