import type {
  WorkspaceRecoveryPlan,
  WorkspaceRestoreOperation,
} from '../../server/src/workspaceProtocol.js';

export {
  parseWorkspaceProtectionStatus,
  parseWorkspaceRecoveryPlan,
  parseWorkspaceRestoreOperation,
  parseWorkspaceRestoreStart,
} from '../../server/src/workspaceProtocol.js';
export type {
  WorkspaceCounts,
  WorkspacePlanSession,
  WorkspacePlanSummary,
  WorkspaceRecoveryPlan,
  WorkspaceRestoreOperation,
  WorkspaceRestoreResult,
} from '../../server/src/workspaceProtocol.js';

export type RecoveryPromptMode = 'none' | 'auto-dialog' | 'card';

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
