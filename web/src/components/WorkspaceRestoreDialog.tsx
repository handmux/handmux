import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { t } from '../i18n';
import { recoveryReasonKey } from '../workspaceRecovery.js';
import { formatCheckpointTime } from './WorkspaceRecoveryCard.jsx';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'interrupted']);
const SAFE_ERROR_CODES = new Set([
  'restore-interrupted', 'checkpoint-not-found', 'storage-full', 'permission-denied',
  'plan-failed', 'agent-unavailable', 'tmux-unavailable', 'restore-failed',
  'operation-not-found',
]);
const SAFE_WARNING_CODES = new Set([
  'cwd-fallback', 'layout-fallback', 'agent-warning', 'live-reconcile-failed',
  'workspace-unavailable', 'restore-warning',
]);

function errorCopy(code: string | null | undefined): string {
  return t(`workspace.error.${code && SAFE_ERROR_CODES.has(code) ? code : 'restore-failed'}`);
}

function warningCopy(code: string | null | undefined): string {
  return t(`workspace.warning.${code && SAFE_WARNING_CODES.has(code) ? code : 'restore-warning'}`);
}

export interface WorkspaceRestoreDialogProps {
  open: boolean;
  plan?: WorkspaceRecoveryPlan | null;
  operation?: WorkspaceRestoreOperation | null;
  submitting?: boolean;
  returnFocusRef?: RefObject<HTMLElement> | null;
  onRestore?: () => void | Promise<void>;
  onIgnore: () => void;
  onClose: () => void;
  onRebind?: () => void;
}

export default function WorkspaceRestoreDialog({
  open, plan, operation = null, submitting = false, returnFocusRef = null,
  onRestore, onIgnore, onClose, onRebind,
}: WorkspaceRestoreDialogProps) {
  const submitted = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const busy = submitting || operation?.status === 'pending' || operation?.status === 'running';
  const terminal = Boolean(operation?.status && TERMINAL.has(operation.status));
  const completed = operation?.status === 'succeeded' || operation?.status === 'partial';
  useEffect(() => {
    if (!busy || terminal) submitted.current = false;
  }, [busy, terminal, plan?.checkpointId]);
  useEffect(() => {
    if (!open) return undefined;
    triggerRef.current = returnFocusRef?.current
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeRef.current?.focus();
    return () => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
      triggerRef.current = null;
    };
  }, [open, returnFocusRef]);
  if (!open || !plan) return null;

  const restoreCount = (plan.planSummary?.create || 0) + (plan.planSummary?.renamed || 0);
  const alreadyCount = plan.planSummary?.alreadyPresent || 0;
  const renamed = (plan.sessions || []).filter((row) => row.action === 'create-renamed');
  const progress = operation?.progress || { completed: 0, total: restoreCount };
  const restoredCount = (operation?.results || []).filter((row) => row.status === 'restored').length;
  const restoredSummary = {
    sessions: operation?.summary?.sessions ?? restoredCount,
    windows: operation?.summary?.windows ?? 0,
    panes: operation?.summary?.panes ?? 0,
  };
  const failures = (operation?.results || []).filter((row) => row.status === 'failed');
  const topWarnings = (operation?.warningCodes || []).filter((code) => SAFE_WARNING_CODES.has(code));
  const sessionWarnings = (operation?.results || []).flatMap((row) =>
    (row.warningCodes || []).filter((code) => SAFE_WARNING_CODES.has(code)).map((code) => ({ row, code })));
  const restore = (): void => {
    if (busy || submitted.current) return;
    submitted.current = true;
    void onRestore?.();
  };
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="settings-backdrop workspace-restore-backdrop" onClick={onClose} />
      <div ref={dialogRef} className="settings-card workspace-restore-dialog" role="dialog" aria-modal="true"
        aria-labelledby="workspace-restore-title" tabIndex={-1} onKeyDown={trapFocus}>
        <div className="settings-head">
          <span id="workspace-restore-title" className="settings-title">{t('workspace.restoreLast')}</span>
          <button ref={closeRef} type="button" className="settings-close workspace-restore-close" onClick={onClose}
            aria-label={t('common.close')}>✕</button>
        </div>
        <div className="workspace-restore-body">
          <div className="workspace-restore-reason">{t(recoveryReasonKey(plan))}</div>
          <div className="workspace-restore-time">
            {t('workspace.savedAt', { time: formatCheckpointTime(plan.capturedAt) })}
          </div>
          <div className="workspace-restore-summary">
            {t('workspace.topologySummary', {
              sessions: plan.summary?.sessions ?? 0,
              windows: plan.summary?.windows ?? 0,
              panes: plan.summary?.panes ?? 0,
            })}
          </div>
          <div className="workspace-restore-plan">
            {t('workspace.planSummary', { restore: restoreCount, already: alreadyCount })}
          </div>
          <div className="workspace-restore-note">{t('workspace.renameRule')}</div>
          {renamed.length > 0 && (
            <ul className="workspace-restore-renames">
              {renamed.map((row) => <li key={row.logicalId || row.sourceName}>{row.sourceName} → {row.targetName}</li>)}
            </ul>
          )}
          <div className="workspace-restore-note">{t('workspace.nonDestructive')}</div>

          {operation?.status === 'partial' && (
            <div className="workspace-restore-progress partial" role="status">
              {t('workspace.progressDone', { completed: restoredCount, total: progress.total || restoreCount })}
            </div>
          )}
          {operation?.status === 'succeeded' && <div className="workspace-restore-success">{t('workspace.complete')}</div>}
          {completed && (
            <div className="workspace-restore-summary workspace-restore-completed-summary">
              {t('workspace.completedSummary', restoredSummary)}
            </div>
          )}
          {completed && restoredSummary.sessions > 0 && (
            <div className="workspace-restore-note">{t('workspace.rebindHint')}</div>
          )}
          {operation?.errorCode && failures.length === 0 && (
            <div className="workspace-restore-errors" role="alert">{errorCopy(operation.errorCode)}</div>
          )}
          {failures.length > 0 && (
            <ul className="workspace-restore-errors" role="alert">
              {failures.map((row, index) => (
                <li key={row.logicalId || `${row.sourceName}-${index}`}>
                  {t('workspace.sessionFailure', {
                    session: row.sourceName || t('workspace.unknownSession'),
                    reason: errorCopy(row.errorCode),
                  })}
                </li>
              ))}
            </ul>
          )}
          {(topWarnings.length > 0 || sessionWarnings.length > 0) && (
            <ul className="workspace-restore-warnings" role="status">
              {topWarnings.map((code) => <li key={`operation-${code}`}>{warningCopy(code)}</li>)}
              {sessionWarnings.map(({ row, code }, index) => (
                <li key={`${row.logicalId || row.sourceName || index}-${code}`}>
                  {t('workspace.sessionWarning', {
                    session: row.sourceName || t('workspace.unknownSession'),
                    reason: warningCopy(code),
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="workspace-restore-actions">
          {completed ? (
            <>
              {restoredSummary.sessions > 0 && (
                <button type="button" className="workspace-restore-primary" onClick={onRebind}>
                  {t('workspace.rebind')}
                </button>
              )}
              <button type="button" className="workspace-restore-ignore" onClick={onClose}>
                {t('common.done')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="workspace-restore-primary" disabled={busy} onClick={restore}>
                {busy
                  ? t('workspace.progress', { completed: progress.completed || 0, total: progress.total || restoreCount })
                  : t('workspace.restore')}
              </button>
              <button type="button" className="workspace-restore-ignore" disabled={busy} onClick={onIgnore}>
                {t('workspace.ignore')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
