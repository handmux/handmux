import { getLangCode, t } from '../i18n';
import { recoveryReasonKey } from '../workspaceRecovery.js';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';

export interface WorkspaceRecoveryCardProps {
  plan?: WorkspaceRecoveryPlan | null;
  operation?: WorkspaceRestoreOperation | null;
  onOpen: () => void;
}

export function formatCheckpointTime(value: unknown): string {
  if (typeof value !== 'string') return t('workspace.unknownTime');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return t('workspace.unknownTime');
  try {
    return new Intl.DateTimeFormat(getLangCode(), {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(time));
  } catch {
    return new Date(time).toLocaleString();
  }
}

export default function WorkspaceRecoveryCard({
  plan,
  operation = null,
  onOpen,
}: WorkspaceRecoveryCardProps) {
  if (!plan) return null;
  const failures = operation?.status === 'partial'
    ? (operation.results || []).filter((row) => row.status === 'failed').length
    : 0;
  return (
    <button type="button" className="workspace-recovery-card" onClick={onOpen}>
      <strong>{t(recoveryReasonKey(plan))}</strong>
      <span>{t('workspace.summary', {
        sessions: plan.summary?.sessions ?? 0,
        time: formatCheckpointTime(plan.capturedAt),
      })}</span>
      {failures > 0 && <span className="workspace-recovery-partial">{t('workspace.partialCard', { failures })}</span>}
      <span className="workspace-recovery-action">{t('workspace.restoreLast')}</span>
    </button>
  );
}
