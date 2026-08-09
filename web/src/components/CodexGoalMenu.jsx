import { useEffect, useRef, useState } from 'react';
import { clearCodexGoal, getCodexGoal, UnauthorizedError, updateCodexGoal } from '../api.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { TargetIcon } from './icons.jsx';

export function codexGoalStatusLabel(status) {
  if (status === 'active') return t('chat.goal.statusActive');
  if (status === 'paused') return t('chat.goal.statusPaused');
  if (status === 'blocked') return t('chat.goal.statusBlocked');
  if (status === 'complete') return t('chat.goal.statusComplete');
  if (status === 'usageLimited') return t('chat.goal.statusUsageLimited');
  if (status === 'budgetLimited') return t('chat.goal.statusBudgetLimited');
  return status || '';
}

export function CodexGoalBar({ goal, onOpen }) {
  if (!goal?.objective) return null;
  const title = t('chat.goal.title');
  const status = codexGoalStatusLabel(goal.status);
  return (
    <button type="button" className="cc-goal-bar"
      aria-label={`${title} ${status} ${goal.objective}`} onClick={onOpen}>
      <span className="codex-goal-icon" aria-hidden="true"><TargetIcon /></span>
      <span className="cc-goal-copy">
        <span className="cc-goal-top">
          <strong>{title}</strong>
          {status && <span className={`codex-goal-status ${goal.status || ''}`}>{status}</span>}
        </span>
        <span className="cc-goal-objective">{goal.objective}</span>
      </span>
      <span className="codex-goal-chevron" aria-hidden="true">›</span>
    </button>
  );
}

export default function CodexGoalMenu({
  open, pane, editOnOpen, onClose, onAuthFail, onNotice, onGoalChange,
}) {
  const [goal, setGoal] = useState(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const requestSeqRef = useRef(0);
  useBackButton(open && confirmClear, () => setConfirmClear(false));
  useBackButton(open && !confirmClear, onClose);

  useEffect(() => {
    if (!open || !pane) return undefined;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError('');
    setConfirmClear(false);
    void getCodexGoal(pane).then((result) => {
      if (requestSeq !== requestSeqRef.current) return;
      const next = result?.goal || null;
      setGoal(next);
      onGoalChange?.(next);
      setDraft(next?.objective || '');
      setEditing(editOnOpen || !next);
    }).catch((err) => {
      if (requestSeq !== requestSeqRef.current) return;
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.goal.loadFailed'));
    }).finally(() => {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    });
    return () => { requestSeqRef.current++; };
    // Event callbacks are not goal identity; changing their function identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, editOnOpen]);

  if (!open) return null;

  const save = async () => {
    const objective = draft.trim();
    if (!objective || objective.length > 4_000 || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await updateCodexGoal(pane, { objective });
      setGoal(result?.goal || null);
      onGoalChange?.(result?.goal || null);
      setDraft(result?.goal?.objective || objective);
      setEditing(false);
      onNotice(t(goal ? 'chat.goal.updated' : 'chat.goal.created'));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.goal.saveFailed'));
    } finally { setSaving(false); }
  };

  const setStatus = async (status) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await updateCodexGoal(pane, { status });
      setGoal(result?.goal || null);
      onGoalChange?.(result?.goal || null);
      onNotice(t(status === 'paused' ? 'chat.goal.paused' : 'chat.goal.resumed'));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.goal.saveFailed'));
    } finally { setSaving(false); }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await clearCodexGoal(pane);
      setGoal(null);
      onGoalChange?.(null);
      setDraft('');
      setEditing(true);
      setConfirmClear(false);
      onNotice(t('chat.goal.cleared'));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.goal.clearFailed'));
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="codex-goal-backdrop" onClick={onClose} />
      <section className="codex-goal-menu" role="dialog" aria-modal="true"
        aria-label={t('chat.goal.title')}>
        <header className="codex-goal-head">
          <strong>{t('chat.goal.title')}</strong>
          {goal && !editing && <span className={`codex-goal-status ${goal.status || ''}`}>
            {codexGoalStatusLabel(goal.status)}
          </span>}
        </header>
        <div className="codex-goal-body">
          {loading && <div className="codex-goal-state">{t('chat.goal.loading')}</div>}
          {!loading && editing && (
            <>
              <textarea value={draft} maxLength={4_000} disabled={saving}
                aria-label={t('chat.goal.objective')} placeholder={t('chat.goal.placeholder')}
                onChange={(event) => setDraft(event.target.value)} />
              <div className="codex-goal-count">{draft.length.toLocaleString()} / 4,000</div>
            </>
          )}
          {!loading && goal && !editing && <p className="codex-goal-objective">{goal.objective}</p>}
          {error && <div className="codex-goal-error" role="status">{error}</div>}
        </div>
        {!loading && (goal || editing) && (
          <footer className="codex-goal-actions">
            {editing ? (
              <>
                {goal && <button type="button" disabled={saving} onClick={() => {
                  setDraft(goal.objective);
                  setEditing(false);
                  setError('');
                }}>{t('common.cancel')}</button>}
                <button type="button" className="primary" disabled={saving || !draft.trim()}
                  onClick={() => void save()}>{t('common.save')}</button>
              </>
            ) : (
              <>
                <button type="button" disabled={saving} onClick={() => setEditing(true)}>
                  {t('chat.goal.edit')}
                </button>
                <button type="button" disabled={saving}
                  onClick={() => void setStatus(goal.status === 'active' ? 'paused' : 'active')}>
                  {t(goal.status === 'active' ? 'chat.goal.pause' : 'chat.goal.resume')}
                </button>
                <button type="button" className="destructive" disabled={saving}
                  onClick={() => setConfirmClear(true)}>{t('chat.goal.clear')}</button>
              </>
            )}
          </footer>
        )}
      </section>
      {confirmClear && (
        <div className="settings-confirm-backdrop" onClick={() => setConfirmClear(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            aria-label={t('chat.goal.clearConfirmTitle')} onClick={(event) => event.stopPropagation()}>
            <h2>{t('chat.goal.clearConfirmTitle')}</h2>
            <p>{t('chat.goal.clearConfirmBody')}</p>
            <div className="settings-confirm-actions">
              <button type="button" autoFocus disabled={saving}
                onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" disabled={saving}
                onClick={() => void clear()}>{t('chat.goal.clear')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
