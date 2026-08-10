export type RecoveryPromptMode = 'none' | 'auto-dialog' | 'card';

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
  action?: string | null;
}

export interface WorkspaceRecoveryPlan {
  checkpointId?: string | null;
  capturedAt?: string | null;
  changeReason?: string | null;
  promptEligible?: boolean;
  resolved?: boolean;
  pendingCount?: number | null;
  summary?: WorkspaceCounts;
  planSummary?: WorkspacePlanSummary;
  sessions?: WorkspacePlanSession[];
  mapping?: unknown;
}

export interface WorkspaceRestoreResult extends WorkspacePlanSession {
  status?: string | null;
  errorCode?: string | null;
  warningCodes?: string[];
}

export interface WorkspaceRestoreOperation {
  status?: string | null;
  progress?: { completed?: number; total?: number };
  summary?: WorkspaceCounts;
  results?: WorkspaceRestoreResult[];
  errorCode?: string | null;
  warningCodes?: string[];
  mapping?: unknown;
}

export interface RecoveryDeviceState {
  ignored?: unknown;
  autoShown?: unknown;
  liveSessionCount?: number;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
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
    ...optionalField('action', optionalString(session.action)),
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
    ...optionalField('promptEligible', typeof plan.promptEligible === 'boolean' ? plan.promptEligible : undefined),
    ...optionalField('resolved', typeof plan.resolved === 'boolean' ? plan.resolved : undefined),
    ...optionalField('pendingCount', pendingCount),
    ...optionalField('summary', summary),
    ...optionalField('planSummary', planSummary),
    ...(Array.isArray(plan.sessions) ? { sessions: plan.sessions.flatMap((session) => {
        const parsed = planSessionOf(session);
        return parsed ? [parsed] : [];
      }) } : {}),
    ...(plan.mapping !== undefined ? { mapping: plan.mapping } : {}),
  };
}

export function parseWorkspaceRestoreOperation(value: unknown): (WorkspaceRestoreOperation & { id?: string }) | null {
  const operation = recordOf(value);
  if (!operation) return null;
  const progress = recordOf(operation.progress);
  const results: WorkspaceRestoreResult[] = Array.isArray(operation.results)
    ? operation.results.flatMap((candidate): WorkspaceRestoreResult[] => {
      const result = recordOf(candidate);
      const session = planSessionOf(candidate);
      if (!result || !session) return [];
      return [{
        ...session,
        ...optionalField('status', optionalString(result.status)),
        ...optionalField('errorCode', optionalString(result.errorCode)),
        warningCodes: stringArray(result.warningCodes),
      }];
    }) : [];
  const parsedProgress = progress ? {
    ...optionalField('completed', finiteNumber(progress.completed)),
    ...optionalField('total', finiteNumber(progress.total)),
  } : undefined;
  return {
    ...(typeof operation.id === 'string' ? { id: operation.id } : {}),
    ...optionalField('status', optionalString(operation.status)),
    ...optionalField('progress', parsedProgress),
    ...optionalField('summary', countsOf(operation.summary)),
    ...(Array.isArray(operation.results) ? { results } : {}),
    ...optionalField('errorCode', optionalString(operation.errorCode)),
    ...(Array.isArray(operation.warningCodes) ? { warningCodes: stringArray(operation.warningCodes) } : {}),
    ...(operation.mapping !== undefined ? { mapping: operation.mapping } : {}),
  };
}

export function recoveryPromptMode(plan: WorkspaceRecoveryPlan | null | undefined, {
  ignored = false,
  autoShown = false,
  liveSessionCount = 0,
}: RecoveryDeviceState = {}): RecoveryPromptMode {
  if (!plan || !plan.promptEligible || ignored === true || plan.resolved || (plan.pendingCount ?? 0) < 1) return 'none';
  if (liveSessionCount === 0 && autoShown !== true) return 'auto-dialog';
  return 'card';
}

export function recoveryReasonKey(plan: Pick<WorkspaceRecoveryPlan, 'changeReason'> | null | undefined): string {
  return plan?.changeReason === 'boot-changed'
    ? 'workspace.bootDetected'
    : 'workspace.tmuxDetected';
}
