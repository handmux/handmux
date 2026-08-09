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
}

export interface RecoveryDeviceState {
  ignored?: unknown;
  autoShown?: unknown;
  liveSessionCount?: number;
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
