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
const defined = <T extends object>(value: T): T => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined),
) as T;
const countsOf = (value: unknown): WorkspaceCounts | undefined => {
  const counts = recordOf(value);
  if (!counts) return undefined;
  return defined({
    sessions: finiteNumber(counts.sessions),
    windows: finiteNumber(counts.windows),
    panes: finiteNumber(counts.panes),
    agents: finiteNumber(counts.agents),
  });
};
const planSessionOf = (value: unknown): WorkspacePlanSession | null => {
  const session = recordOf(value);
  return session ? defined({
    logicalId: optionalString(session.logicalId),
    sourceName: optionalString(session.sourceName),
    targetName: optionalString(session.targetName),
    action: optionalString(session.action),
  }) : null;
};

export function parseWorkspaceRecoveryPlan(value: unknown): WorkspaceRecoveryPlan | null {
  const plan = recordOf(value);
  if (!plan) return null;
  const rawPlanSummary = recordOf(plan.planSummary);
  const summary = countsOf(plan.summary);
  const planSummary: WorkspacePlanSummary | undefined = rawPlanSummary ? defined({
    ...countsOf(rawPlanSummary),
    create: finiteNumber(rawPlanSummary.create),
    renamed: finiteNumber(rawPlanSummary.renamed),
    alreadyPresent: finiteNumber(rawPlanSummary.alreadyPresent),
    unsupported: finiteNumber(rawPlanSummary.unsupported),
  }) : undefined;
  return defined({
    checkpointId: optionalString(plan.checkpointId),
    capturedAt: optionalString(plan.capturedAt),
    changeReason: optionalString(plan.changeReason),
    promptEligible: typeof plan.promptEligible === 'boolean' ? plan.promptEligible : undefined,
    resolved: typeof plan.resolved === 'boolean' ? plan.resolved : undefined,
    pendingCount: finiteNumber(plan.pendingCount) ?? (plan.pendingCount === null ? null : undefined),
    summary,
    planSummary,
    ...(Array.isArray(plan.sessions) ? { sessions: plan.sessions.flatMap((session) => {
        const parsed = planSessionOf(session);
        return parsed ? [parsed] : [];
      }) } : {}),
    ...(plan.mapping !== undefined ? { mapping: plan.mapping } : {}),
  });
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
      return [defined({
        ...session,
        status: optionalString(result.status),
        errorCode: optionalString(result.errorCode),
        warningCodes: stringArray(result.warningCodes),
      })];
    }) : [];
  return defined({
    ...(typeof operation.id === 'string' ? { id: operation.id } : {}),
    status: optionalString(operation.status),
    progress: progress ? defined({
      completed: finiteNumber(progress.completed),
      total: finiteNumber(progress.total),
    }) : undefined,
    summary: countsOf(operation.summary),
    ...(Array.isArray(operation.results) ? { results } : {}),
    errorCode: optionalString(operation.errorCode),
    ...(Array.isArray(operation.warningCodes) ? { warningCodes: stringArray(operation.warningCodes) } : {}),
    ...(operation.mapping !== undefined ? { mapping: operation.mapping } : {}),
  });
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
