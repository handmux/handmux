import { useEffect, useRef, useState } from 'react';
import { clearCodexGoal, getCodexGoal, UnauthorizedError, updateCodexGoal } from '../api.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { TargetIcon, XIcon } from './icons.jsx';

const TERMINAL_GOAL_STATUSES = new Set(['blocked', 'usageLimited', 'budgetLimited', 'complete']);

export function isCodexGoalTerminal(goal) {
  return TERMINAL_GOAL_STATUSES.has(goal?.status);
}

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
  if (!goal?.objective || isCodexGoalTerminal(goal)) return null;
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

function goalEventLabel(goal, event) {
  if (event === 'set') return t('chat.goal.eventSet');
  if (event === 'restarted') return t('chat.goal.eventRestarted');
  if (goal?.status === 'complete' || event === 'complete') return t('chat.goal.eventComplete');
  if (goal?.status === 'blocked' || event === 'blocked') return t('chat.goal.eventBlocked');
  if (goal?.status === 'usageLimited' || event === 'usageLimited') return t('chat.goal.eventUsageLimited');
  if (goal?.status === 'budgetLimited' || event === 'budgetLimited') return t('chat.goal.eventBudgetLimited');
  return codexGoalStatusLabel(goal?.status) || t('chat.goal.title');
}

export function CodexGoalCard({ goal, event, onOpen }) {
  if (!goal?.objective) return null;
  const label = goalEventLabel(goal, event);
  const userInitiated = event === 'set' || event === 'restarted';
  return (
    <button type="button" className={`chat-goal-card is-${event || goal.status || 'set'}${userInitiated ? ' is-user' : ''}`}
      aria-label={`${label} ${goal.objective}`} onClick={() => onOpen(goal)}>
      <span className="codex-goal-icon" aria-hidden="true"><TargetIcon /></span>
      <span className="chat-goal-copy">
        <strong>{label}</strong>
        <span>{goal.objective}</span>
      </span>
      <span className="codex-goal-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function sameGoal(left, right) {
  if (!left || !right) return false;
  if (left.createdAt != null && right.createdAt != null) return left.createdAt === right.createdAt;
  return left.objective === right.objective;
}

function GoalMeta({ goal }) {
  const tokens = Number(goal?.tokensUsed);
  const budget = goal?.tokenBudget == null ? Number.NaN : Number(goal.tokenBudget);
  const elapsed = Number(goal?.timeUsedSeconds);
  if (!Number.isFinite(tokens) && !Number.isFinite(elapsed)) return null;
  return (
    <div className="codex-goal-meta">
      {Number.isFinite(tokens) && <span>{t('chat.goal.tokens', {
        value: Number.isFinite(budget) ? `${tokens.toLocaleString()} / ${budget.toLocaleString()}` : tokens.toLocaleString(),
      })}</span>}
      {Number.isFinite(elapsed) && elapsed > 0
        && <span>{t('chat.goal.elapsed', { value: Math.round(elapsed).toLocaleString() })}</span>}
    </div>
  );
}

export default function CodexGoalMenu({
  open, pane, editOnOpen, goalSnapshot = null, onClose, onAuthFail, onNotice = () => {}, onGoalChange,
  portal = false, chatTone = 'dusk', keyboardInset = 0,
}) {
  const [goal, setGoal] = useState(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [historical, setHistorical] = useState(false);
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
    setRestarting(false);
    if (goalSnapshot) {
      setGoal(goalSnapshot);
      setDraft(goalSnapshot.objective || '');
      setEditing(false);
      setHistorical(true);
    }
    void getCodexGoal(pane).then((result) => {
      if (requestSeq !== requestSeqRef.current) return;
      const current = result?.goal || null;
      const matches = goalSnapshot ? sameGoal(goalSnapshot, current) : true;
      const next = goalSnapshot && !matches ? goalSnapshot : current;
      setGoal(next);
      if (!goalSnapshot || matches) onGoalChange?.(current);
      setDraft(next?.objective || '');
      setHistorical(!!goalSnapshot && !matches);
      setEditing(!goalSnapshot && (editOnOpen || !next));
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
  }, [open, pane, editOnOpen, goalSnapshot]);

  if (!open) return null;

  const save = async () => {
    const objective = draft.trim();
    if (!objective || objective.length > 4_000 || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await updateCodexGoal(pane, {
        objective,
        ...(restarting ? { status: 'active' } : {}),
      });
      setGoal(result?.goal || null);
      onGoalChange?.(result?.goal || null);
      setDraft(result?.goal?.objective || objective);
      setEditing(false);
      setRestarting(false);
      onNotice(t(restarting ? 'chat.goal.restarted' : goal ? 'chat.goal.updated' : 'chat.goal.created'));
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

  const terminal = isCodexGoalTerminal(goal);
  const content = (
    <>
      <div className="codex-goal-backdrop" onClick={onClose} />
      <section className="codex-goal-menu" role="dialog" aria-modal="true"
        aria-label={t('chat.goal.title')}>
        <div className="tool-sheet-grip" />
        <header className="codex-goal-head">
          <span className="codex-goal-icon" aria-hidden="true"><TargetIcon /></span>
          <strong>{t('chat.goal.title')}</strong>
          {goal && !editing && <span className={`codex-goal-status ${goal.status || ''}`}>
            {codexGoalStatusLabel(goal.status)}
          </span>}
        </header>
        <button type="button" className="cmd-close codex-goal-sheet-x"
          aria-label={t('common.close')} onClick={onClose}><XIcon /></button>
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
          {!loading && goal && !editing && (
            <>
              <p className="codex-goal-objective">{goal.objective}</p>
              <GoalMeta goal={goal} />
            </>
          )}
          {error && <div className="codex-goal-error" role="status">{error}</div>}
        </div>
        {!loading && (goal || editing) && !historical && (
          <footer className="codex-goal-actions">
            {editing ? (
              <>
                {goal && <button type="button" disabled={saving} onClick={() => {
                  setDraft(goal.objective);
                  setEditing(false);
                  setRestarting(false);
                  setError('');
                }}>{t('common.cancel')}</button>}
                <button type="button" className="primary" disabled={saving || !draft.trim()}
                  onClick={() => void save()}>{t(restarting ? 'chat.goal.restart' : 'common.save')}</button>
              </>
            ) : terminal ? (
              <>
                <button type="button" className="primary" disabled={saving} onClick={() => {
                  setDraft(goal.objective);
                  setRestarting(true);
                  setEditing(true);
                  setError('');
                }}>{t('chat.goal.restart')}</button>
                <button type="button" className="destructive" disabled={saving}
                  onClick={() => setConfirmClear(true)}>{t('chat.goal.clear')}</button>
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
  if (!portal) return content;
  return <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>{content}</OverlayPortal>;
}
