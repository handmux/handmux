import { useEffect, useRef, useState } from 'react';
import { gitWorktree } from '../api.js';
import { ApiError } from '../apiErrors.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import type { AgentConversationControlsController } from '../hooks/useAgentConversationControls.js';
import type { AgentConversationController } from '../hooks/useAgentConversation.js';
import type {
  ConversationActivity,
  ConversationGoal,
  ConversationPermissionMode,
  ConversationPlanSnapshot,
  ConversationQueueItem,
  ConversationSubmissionActionResult,
} from '../agentConversationControlsApi.js';
import { queueSubmissionId } from '../conversationSubmissionProjection.js';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ListChecksIcon,
  TargetIcon,
  XIcon,
} from './icons.jsx';
import { ConversationPlanSheet } from './ConversationMilestones.js';

const TERMINAL_GOALS = new Set(['blocked', 'usageLimited', 'budgetLimited', 'complete']);
const EDIT_RENEW_RETRY_MS = 1_000;

function queueEditLeaseInactive(error: unknown): boolean {
  return error instanceof ApiError
    && error.serverError === 'Queue edit is no longer active';
}

function queueEditConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.serverError === 'Queue item changed'
    || error.serverError === 'Queued message is no longer pending');
}

function goalStatus(status: string): string {
  if (status === 'active') return t('chat.goal.statusActive');
  if (status === 'paused') return t('chat.goal.statusPaused');
  if (status === 'blocked') return t('chat.goal.statusBlocked');
  if (status === 'complete') return t('chat.goal.statusComplete');
  if (status === 'usageLimited') return t('chat.goal.statusUsageLimited');
  if (status === 'budgetLimited') return t('chat.goal.statusBudgetLimited');
  return status;
}

export function AgentConversationMilestoneControls({
  controller,
  goalOpenRequest = 0,
  goalEditRequest = 0,
  chatTone = 'dusk',
  keyboardInset = 0,
}: {
  controller: AgentConversationControlsController;
  goalOpenRequest?: number;
  goalEditRequest?: number;
  chatTone?: string;
  keyboardInset?: number;
}) {
  const snapshot = controller.snapshot;
  const plan = snapshot?.plan ?? null;
  const goal = snapshot?.goal ?? null;
  const goalActions = new Set(snapshot?.goalActions ?? []);
  const [planOpen, setPlanOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  useBackButton(goalOpen && confirmClear, () => setConfirmClear(false));
  useBackButton(goalOpen, () => setGoalOpen(false));
  useEffect(() => {
    if (!goalOpenRequest) return;
    setDraft(goal?.objective ?? '');
    setEditing(!goal || goalEditRequest === goalOpenRequest);
    setGoalOpen(true);
  }, [goalEditRequest, goalOpenRequest]); // goal is intentionally sampled when the command arrives
  useEffect(() => {
    if (!goalOpen) return;
    setDraft(goal?.objective ?? '');
  }, [goal?.objective, goalOpen]);

  const saveGoal = async (): Promise<void> => {
    const objective = draft.trim();
    if (!objective) return;
    setError('');
    try {
      await controller.goalAction(goal ? 'update' : 'start', { objective });
      setEditing(false);
      if (!goal) setGoalOpen(false);
    } catch {
      setError(t('chat.goal.saveFailed'));
    }
  };
  const updateStatus = async (): Promise<void> => {
    if (!goal) return;
    setError('');
    try {
      await controller.goalAction('update', { status: goal.status === 'active' ? 'paused' : 'active' });
    } catch {
      setError(t('chat.goal.saveFailed'));
    }
  };
  const clearGoal = async (): Promise<void> => {
    setError('');
    try {
      await controller.goalAction('clear');
      setConfirmClear(false);
      setGoalOpen(false);
    } catch {
      setError(t('chat.goal.clearFailed'));
    }
  };

  const planPosition = plan?.steps.findIndex((step) => step.status !== 'completed') ?? -1;
  const currentStep = planPosition >= 0 ? plan?.steps[planPosition] : null;
  const displayedPlanPosition = plan ? (planPosition >= 0 ? planPosition + 1 : plan.steps.length) : 0;
  return (
    <>
      {plan && plan.steps.length > 0 && (
        <button type="button" className="cc-plan-bar" onClick={() => setPlanOpen(true)}>
          <span className="conversation-plan-icon" aria-hidden="true"><ListChecksIcon /></span>
          <span className="cc-plan-copy">
            <span className="cc-plan-top"><strong>{t('chat.plan.currentTitle')}</strong>
              <span>{displayedPlanPosition}/{plan.steps.length}</span></span>
            <span className="cc-plan-current">
              {currentStep?.status === 'inProgress' && (
                <span className={`conversation-plan-spinner${plan.waiting ? ' is-static' : ''}`} aria-hidden="true" />
              )}
              {currentStep ? t(plan.waiting ? 'chat.plan.waiting' : 'chat.plan.working', {
                step: currentStep.step,
              }) : t('chat.plan.finalizing')}
            </span>
          </span>
          <span className="conversation-plan-chevron" aria-hidden="true">›</span>
        </button>
      )}
      {goal && !TERMINAL_GOALS.has(goal.status) && (
        <button type="button" className="cc-goal-bar" onClick={() => {
          setEditing(false); setGoalOpen(true);
        }}>
          <span className="conversation-goal-icon" aria-hidden="true"><TargetIcon /></span>
          <span className="cc-goal-copy">
            <span className="cc-goal-top"><strong>{t('chat.goal.title')}</strong>
              <span className={`conversation-goal-status ${goal.status}`}>{goalStatus(goal.status)}</span></span>
            <span className="cc-goal-objective">{goal.objective}</span>
          </span>
          <span className="conversation-goal-chevron" aria-hidden="true">›</span>
        </button>
      )}
      {planOpen && <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>
        <ConversationPlanSheet plan={plan as ConversationPlanSnapshot} onClose={() => setPlanOpen(false)} />
      </OverlayPortal>}
      {goalOpen && <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>
        <div className="conversation-goal-backdrop" onClick={() => setGoalOpen(false)} />
        <section className="conversation-goal-menu" role="dialog" aria-modal="true"
          aria-label={t('chat.goal.title')}>
          <div className="tool-sheet-grip" />
          <header className="conversation-goal-head">
            <span className="conversation-goal-icon" aria-hidden="true"><TargetIcon /></span>
            <strong>{t('chat.goal.title')}</strong>
            {goal && !editing && <span className={`conversation-goal-status ${goal.status}`}>
              {goalStatus(goal.status)}
            </span>}
          </header>
          <button type="button" className="cmd-close conversation-goal-sheet-x"
            aria-label={t('common.close')} onClick={() => setGoalOpen(false)}><XIcon /></button>
          <div className="conversation-goal-body">
            {editing || !goal ? <>
              <textarea value={draft} maxLength={4_000} disabled={controller.busy}
                aria-label={t('chat.goal.objective')} placeholder={t('chat.goal.placeholder')}
                onChange={(event) => setDraft(event.target.value)} />
              <div className="conversation-goal-count">{draft.length.toLocaleString()} / 4,000</div>
            </> : <>
              <p className="conversation-goal-objective">{goal.objective}</p>
              <GoalMeta goal={goal} />
            </>}
            {error && <div className="conversation-goal-error" role="status">{error}</div>}
          </div>
          <footer className={`conversation-goal-actions${editing || !goal ? '' : ' is-action-list'}`}>
            {editing || !goal ? <>
              {goal && <button type="button" disabled={controller.busy} onClick={() => {
                setEditing(false); setDraft(goal.objective); setError('');
              }}>{t('common.cancel')}</button>}
              <button type="button" className="primary" disabled={controller.busy || !draft.trim()
                || !(goal ? goalActions.has('update') : goalActions.has('start'))}
                onClick={() => { void saveGoal(); }}>{t('common.save')}</button>
            </> : <div className="conversation-goal-action-list is-three">
              <button type="button" disabled={controller.busy || !goalActions.has('update')}
                onClick={() => setEditing(true)}>{t('chat.goal.edit')}</button>
              <button type="button" disabled={controller.busy || !goalActions.has('update')}
                onClick={() => { void updateStatus(); }}>{t(goal.status === 'active'
                  ? 'chat.goal.pause' : 'chat.goal.resume')}</button>
              <button type="button" className="destructive"
                disabled={controller.busy || !goalActions.has('clear')}
                onClick={() => setConfirmClear(true)}>{t('chat.goal.clear')}</button>
            </div>}
          </footer>
        </section>
        {confirmClear && <div className="settings-confirm-backdrop conversation-goal-confirm-backdrop"
          onClick={() => setConfirmClear(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            onClick={(event) => event.stopPropagation()}>
            <h2>{t('chat.goal.clearConfirmTitle')}</h2><p>{t('chat.goal.clearConfirmBody')}</p>
            <div className="settings-confirm-actions">
              <button type="button" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" disabled={controller.busy}
                onClick={() => { void clearGoal(); }}>{t('chat.goal.clear')}</button>
            </div>
          </div>
        </div>}
      </OverlayPortal>}
    </>
  );
}

function GoalMeta({ goal }: { goal: ConversationGoal }) {
  const tokens = Number(goal.tokensUsed);
  const budget = goal.tokenBudget == null ? Number.NaN : Number(goal.tokenBudget);
  const elapsed = Number(goal.timeUsedSeconds);
  if (!Number.isFinite(tokens) && !Number.isFinite(elapsed)) return null;
  return <div className="conversation-goal-meta">
    {Number.isFinite(tokens) && <span>{t('chat.goal.tokens', {
      value: Number.isFinite(budget) ? `${tokens.toLocaleString()} / ${budget.toLocaleString()}`
        : tokens.toLocaleString(),
    })}</span>}
    {Number.isFinite(elapsed) && elapsed > 0 && <span>{t('chat.goal.elapsed', {
      value: Math.round(elapsed).toLocaleString(),
    })}</span>}
  </div>;
}

interface QueueEditorState {
  item: ConversationQueueItem;
  draft: string;
  baseText: string;
  token: string | null;
  expiresAt?: number;
  recovering?: boolean;
  error: string;
}

export function AgentConversationQueueControl({
  controller,
  conversation,
  items,
  activity,
  chatTone = 'dusk',
  keyboardInset = 0,
}: {
  controller: AgentConversationControlsController;
  conversation?: AgentConversationController;
  items?: readonly ConversationQueueItem[];
  activity?: ConversationActivity;
  chatTone?: string;
  keyboardInset?: number;
}) {
  const queue = controller.snapshot?.queue;
  const currentActivity = activity ?? controller.snapshot?.activity
    ?? controller.snapshot?.context?.activity ?? 'unknown';
  const displayItems = items ?? queue?.items ?? [];
  const localQueueStatuses = new Map((conversation?.localSubmissions ?? []).flatMap((entry) => (
    entry.owner === 'queue' ? [[entry.clientRequestId, entry.status] as const] : []
  )));
  const queueItems = queue?.items ?? [];
  const queueSnapshotKey = queueItems.map((item) => `${queueSubmissionId(item)}:${item.revision ?? ''}`)
    .join('\0');
  useEffect(() => {
    conversation?.observeQueueSnapshot?.(queueItems);
  }, [conversation, queueSnapshotKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const submissionSnapshot = controller.snapshot?.submissions ?? [];
  useEffect(() => {
    if (!controller.snapshot?.submissions) return;
    conversation?.observeSubmissionSnapshot?.(submissionSnapshot, {
      authoritative: true,
      queue: queueItems,
      settled: controller.snapshot.queue?.settled ?? [],
    });
  }, [conversation?.observeSubmissionSnapshot, controller.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editor, setEditor] = useState<QueueEditorState | null>(null);
  const [deleting, setDeleting] = useState<ConversationQueueItem | null>(null);
  const [actionError, setActionError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const editorRef = useRef(editor);
  const queueControllerRef = useRef(controller);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  editorRef.current = editor;
  queueControllerRef.current = controller;
  useBackButton(editor !== null, () => closeEditor());
  useBackButton(deleting !== null, () => setDeleting(null));
  const closeEditor = (): void => {
    const current = editorRef.current;
    setEditor(null);
    if (current?.token) void controller.queueAction('cancel_edit', current.item.id, {
      token: current.token,
    }).catch(() => {});
  };
  const openEditor = async (item: ConversationQueueItem): Promise<void> => {
    if (!queue?.canEdit || controller.busy || (item.state !== undefined && item.state !== 'queued')) return;
    setEditor({ item, draft: item.text, baseText: item.text, token: null, error: '' });
    try {
      const lease = await controller.queueAction('begin_edit', item.id);
      if (!lease || !('token' in lease) || editorRef.current?.item.id !== item.id) return;
      setEditor((current) => current ? {
        ...current, draft: current.draft === item.text ? lease.text : current.draft,
        baseText: lease.text, token: lease.token,
        ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }),
      } : null);
    } catch {
      setEditor((current) => current?.item.id === item.id ? {
        ...current, error: t('chat.queue.actionFailed'),
      } : current);
    }
  };
  useEffect(() => {
    if (!editor?.token || !editor.expiresAt) return undefined;
    let timer: number | undefined;
    let stopped = false;
    let renewing = false;
    let renew: () => Promise<void> = async () => {};
    let recover: () => Promise<void> = async () => {};
    const scheduleRetry = (): void => {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void recover(); }, EDIT_RENEW_RETRY_MS);
    };
    const schedule = (expiresAt: number, retry = false): void => {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        timer = window.setTimeout(() => { void recover(); }, 0);
        return;
      }
      const delay = retry ? Math.min(EDIT_RENEW_RETRY_MS, Math.max(250, remaining / 4))
        : Math.max(1_000, Math.floor(remaining / 3));
      timer = window.setTimeout(() => { void renew(); }, delay);
    };
    const conflict = (itemId: string): void => {
      setEditor((value) => {
        if (!value || value.item.id !== itemId) return value;
        const next: QueueEditorState = {
          ...value, token: null, recovering: false, error: t('chat.queue.editConflict'),
        };
        delete next.expiresAt;
        return next;
      });
    };
    recover = async (): Promise<void> => {
      const current = editorRef.current;
      if (!current || renewing || stopped) return;
      renewing = true;
      setEditor((value) => value?.item.id === current.item.id
        ? { ...value, recovering: true, error: '' } : value);
      try {
        const lease = await queueControllerRef.current.queueAction('begin_edit', current.item.id);
        if (!lease || !('token' in lease) || editorRef.current?.item.id !== current.item.id) {
          scheduleRetry();
          return;
        }
        if (lease.text !== current.baseText) {
          void queueControllerRef.current.queueAction('cancel_edit', current.item.id, {
            token: lease.token,
          }).catch(() => {});
          conflict(current.item.id);
          return;
        }
        const nextExpiry = lease.expiresAt ?? (Date.now() + 30_000);
        setEditor((value) => value?.item.id === current.item.id ? {
          ...value, token: lease.token, expiresAt: nextExpiry, recovering: false, error: '',
        } : value);
        schedule(nextExpiry);
      } catch (cause) {
        if (queueEditConflict(cause)) conflict(current.item.id);
        else scheduleRetry();
      } finally {
        renewing = false;
      }
    };
    renew = async (): Promise<void> => {
      const current = editorRef.current;
      if (!current?.token || !current.expiresAt || renewing || stopped) return;
      if (current.expiresAt <= Date.now()) { await recover(); return; }
      renewing = true;
      try {
        const lease = await queueControllerRef.current.queueAction('renew_edit', current.item.id, {
          token: current.token,
        });
        if (!lease || !('token' in lease) || editorRef.current?.token !== current.token) return;
        const nextExpiry = lease.expiresAt ?? current.expiresAt;
        setEditor((value) => value && value.token === current.token ? {
          ...value, token: lease.token, expiresAt: nextExpiry,
        } : value);
        schedule(nextExpiry);
      } catch (cause) {
        const active = editorRef.current;
        if (!active || active.token !== current.token) return;
        if (queueEditLeaseInactive(cause) || active.expiresAt === undefined
          || active.expiresAt <= Date.now()) {
          setEditor((value) => value?.item.id === current.item.id
            ? { ...value, recovering: true, error: '' } : value);
          scheduleRetry();
        } else schedule(active.expiresAt, true);
      } finally {
        renewing = false;
      }
    };
    const onVisibility = (): void => {
      if (!document.hidden) void renew();
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule(editor.expiresAt);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [editor?.expiresAt, editor?.token]);
  useEffect(() => {
    const textarea = editorTextareaRef.current;
    if (!textarea || !editor) return;
    textarea.style.height = 'auto';
    const maximum = Math.min(360, Math.max(160, window.innerHeight * 0.42));
    textarea.style.height = `${Math.max(120, Math.min(textarea.scrollHeight, maximum))}px`;
  }, [editor?.draft]);
  if (!displayItems.length) return null;
  const save = async (): Promise<void> => {
    if (!editor?.token || !editor.draft.trim()) return;
    try {
      await controller.queueAction('commit_edit', editor.item.id, {
        token: editor.token, text: editor.draft.trim(),
      });
      setEditor(null);
    } catch (cause) {
      setEditor((current) => {
        if (!current) return null;
        if (queueEditLeaseInactive(cause)) {
          return { ...current, recovering: true, expiresAt: Date.now() - 1, error: '' };
        }
        return {
          ...current,
          error: queueEditConflict(cause)
            ? t('chat.queue.editConflict') : t('chat.queue.actionFailed'),
        };
      });
    }
  };
  return <>
    <div className="cc-queue" aria-label={t('chat.queue.title')}>
      <div className="cc-queue-head"><span className="cc-queue-title">{t('chat.queue.title')}
        <span className="cc-queue-count">{displayItems.length}</span></span>
        <span>{t('chat.queue.hint')}</span></div>
      <div className="cc-queue-list">{displayItems.map((item, index) => {
        const submissionId = queueSubmissionId(item);
        const localStatus = localQueueStatuses.get(submissionId);
        const pending = localStatus === 'sending';
        const queued = item.state === undefined || item.state === 'queued';
        const autoDispatchBlocked = queued && item.autoDispatchBlockedReason === 'provider_rejected';
        const unknownQueue = item.state === 'unknown' && item.dispatchOrigin === 'queue';
        const statusLabel = autoDispatchBlocked ? t('chat.queue.providerRejected')
          : unknownQueue ? t('chat.queue.unknownDelivery') : '';
        const showSteer = queued && !autoDispatchBlocked
          && queue?.canSteer === true && currentActivity !== 'unknown';
        const steerDisabled = controller.busy || currentActivity === 'compacting' || pending;
        return (
        <div className={`cc-queue-item${pending ? ' is-pending' : ''}`} key={item.id} onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('.cc-queue-action')) return;
          if (pending) return;
          void openEditor(item);
        }}>
          <span className="cc-queue-index">{index + 1}</span>
          <span className="cc-queue-copy" role={queue?.canEdit && queued && !pending ? 'button' : undefined}
            tabIndex={queue?.canEdit && queued && !pending ? 0 : undefined}
            onKeyDown={(event) => {
              if (!queue?.canEdit || !queued || pending
                || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              void openEditor(item);
            }}><span className="cc-queue-text">{item.text}</span>
            {statusLabel && <span className="cc-queue-failure is-unknown">{statusLabel}
              {unknownQueue && conversation?.retryOutgoing && <button type="button"
                className="cc-queue-action" onClick={() => {
                  void conversation.retryOutgoing?.(submissionId).catch(() => {});
                }}>{t('common.retry')}</button>}
            </span>}
          </span>
          <span className="cc-queue-actions">
            {showSteer && <button type="button" className="cc-queue-action cc-queue-send"
              aria-label={t('chat.queue.steer')} disabled={steerDisabled}
              onClick={() => {
                setActionError('');
                const pending = conversation?.beginQueueSteer?.(item);
                const operation = pending ? controller.queueAction('steer', item.id, {
                  actionId: pending.actionId, baseRevision: pending.baseRevision,
                  anchor: pending.anchor,
                }) : controller.queueAction('steer', item.id);
                void operation.then((value) => {
                  const result = value && 'status' in value
                    ? value as ConversationSubmissionActionResult : { status: 'accepted' as const };
                  conversation?.settleQueueSteer?.(submissionId, result);
                  if (result.status === 'rejected' && result.nativeMutation === false) {
                    setActionError(t('chat.queue.actionFailed'));
                  }
                }).catch((cause) => {
                  conversation?.settleQueueSteer?.(submissionId, {
                    status: 'unknown',
                    ...(pending ? { actionId: pending.actionId } : {}),
                    nativeMutation: 'unknown',
                  }, cause instanceof Error ? cause.message : undefined);
                });
              }}><ArrowUpIcon /></button>}
            {queued && queue?.canRemove && <button type="button" className="cc-queue-action cc-queue-delete"
              aria-label={t('chat.queue.remove')} disabled={controller.busy || pending}
              onClick={() => { setDeleteError(''); setDeleting(item); }}><XIcon /></button>}
          </span>
        </div>
      );})}</div>
      {actionError && <div className="cc-queue-error" role="status">{actionError}</div>}
    </div>
    {editor && <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>
      <div className="settings-confirm-backdrop cc-queue-dialog-backdrop" onClick={closeEditor}>
        <div className="settings-confirm cc-queue-edit-dialog" role="dialog" aria-modal="true"
          onClick={(event) => event.stopPropagation()}>
          <h2>{t('chat.queue.editTitle')}</h2>
          <textarea ref={editorTextareaRef} autoFocus value={editor.draft} disabled={controller.busy}
            onChange={(event) => setEditor({ ...editor, draft: event.target.value, error: '' })} />
          {editor.error && <p className="cc-queue-dialog-error" role="status">{editor.error}</p>}
          <div className="settings-confirm-actions">
            <button type="button" onClick={closeEditor}>{t('common.cancel')}</button>
            <button type="button" disabled={!editor.token || editor.recovering
              || !editor.draft.trim() || controller.busy}
              onClick={() => { void save(); }}>{t('common.save')}</button>
          </div>
        </div>
      </div>
    </OverlayPortal>}
    {deleting && <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>
      <div className="settings-confirm-backdrop cc-queue-dialog-backdrop" onClick={() => {
        setDeleting(null); setDeleteError('');
      }}>
        <div className="settings-confirm cc-confirm-dialog" role="alertdialog" aria-modal="true"
          onClick={(event) => event.stopPropagation()}>
          <h2>{t('chat.queue.removeTitle')}</h2><p>{t('chat.queue.removeBody')}</p>
          {deleteError && <p className="cc-queue-dialog-error" role="status">{deleteError}</p>}
          <div className="settings-confirm-actions">
            <button type="button" onClick={() => { setDeleting(null); setDeleteError(''); }}>
              {t('common.cancel')}</button>
            <button type="button" className="danger" disabled={controller.busy} onClick={() => {
              setActionError('');
              const submissionId = queueSubmissionId(deleting);
              void controller.queueAction('remove', deleting.id).then(() => {
                conversation?.removeQueueSubmission?.(submissionId);
                setDeleting(null);
              })
                .catch(() => setDeleteError(t('chat.queue.actionFailed')));
            }}>{t('common.delete')}</button>
          </div>
        </div>
      </div>
    </OverlayPortal>}
  </>;
}

function ContextRing({ percent }: { percent: number | null }) {
  const bounded = percent === null ? null : Math.min(100, Math.max(0, percent));
  return <svg className={`cc-context-ring${bounded === null ? ' is-placeholder' : ''}`}
    viewBox="0 0 24 24" aria-hidden="true">
    <circle className="cc-context-track" cx="12" cy="12" r="9" pathLength="100" />
    {bounded !== null && <circle className="cc-context-value" cx="12" cy="12" r="9" pathLength="100"
      strokeDasharray={`${bounded} 100`} />}
  </svg>;
}

export function AgentConversationContextControl({
  controller,
  sessionId,
}: {
  controller: AgentConversationControlsController;
  sessionId: string;
}) {
  const context = controller.snapshot?.context;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [worktree, setWorktree] = useState<string | null>(null);
  useBackButton(open, () => setOpen(false));
  useEffect(() => {
    if (!context?.cwd) { setWorktree(null); return; }
    let current = true;
    void gitWorktree(context.cwd).then((value) => { if (current) setWorktree(value?.path ?? null); })
      .catch(() => { if (current) setWorktree(null); });
    return () => { current = false; };
  }, [context?.cwd]);
  if (!context) return null;
  const hasUsage = context.usedTokens !== undefined && context.totalTokens !== undefined;
  const percent = hasUsage ? (context.usedTokens! / context.totalTokens!) * 100 : null;
  const level = percent !== null && percent >= 75 ? 'high'
    : percent !== null && percent >= 40 ? 'medium' : 'low';
  const copy = async (value: string, name: string): Promise<void> => {
    try { await navigator.clipboard.writeText(value); setCopied(name); } catch { /* unavailable */ }
  };
  const activityLabel = context.activity === 'compacting' ? t('chat.status.compacting')
    : context.activity === 'waiting' ? t('chat.status.waitingInput')
      : context.activity === 'working' ? t('chat.status.working') : t('chat.status.idle');
  return <>
    <button type="button" className={`cc-context-trigger ${percent === null ? 'unknown' : level}`}
      aria-label={percent === null ? t('chat.context.unavailableAria')
        : t('chat.status.aria', { percent: Math.round(percent) })}
      onClick={() => setOpen((value) => !value)}><ContextRing percent={percent} /></button>
    {open && <>
      <div className="cc-context-backdrop" data-conversation-overlay
        onClick={() => setOpen(false)} />
      <section className="cc-context-popover" data-conversation-overlay role="dialog" aria-modal="true"
        aria-label={t('chat.status.title')}>
        <div className="cc-context-popover-title"><span>{t('chat.status.title')}</span>
          <span className={`cc-status-activity ${context.activity}`}><i />{activityLabel}</span></div>
        <div className="cc-context-list">
          {percent !== null && <div className={`cc-context-row cc-context-usage ${level}`}><span>{t('chat.context.percent')}</span>
            <strong className="cc-context-usage-value"><ContextRing percent={percent} />
              <b>{percent.toFixed(1)}%</b></strong></div>}
          {hasUsage && <div className="cc-context-row"><span>{t('chat.context.usedTotal')}</span>
            <strong>{context.usedTokens!.toLocaleString()} / {context.totalTokens!.toLocaleString()}</strong></div>}
          {context.cwd && <ContextCopyRow label={t('chat.status.directory')} value={context.cwd}
            copied={copied === 'cwd'} onCopy={() => copy(context.cwd!, 'cwd')} />}
          {worktree && <ContextCopyRow label={t('chat.status.worktree')} value={worktree}
            copied={copied === 'worktree'} onCopy={() => copy(worktree, 'worktree')} />}
          {context.branch && <div className="cc-context-row"><span>{t('chat.status.branch')}</span>
            <strong>{context.branch}</strong></div>}
          {context.access && <div className="cc-context-row"><span>{t('chat.status.access')}</span>
            <strong>{t(`chat.status.sandbox${context.access === 'read-only' ? 'ReadOnly'
              : context.access === 'workspace-write' ? 'Workspace' : 'Full'}`)}</strong></div>}
          <ContextCopyRow label={t('chat.status.sessionId')} value={sessionId}
            copied={copied === 'session'} onCopy={() => copy(sessionId, 'session')} />
        </div>
      </section>
    </>}
  </>;
}

const modeLabel = (mode: ConversationPermissionMode): string => t(`chat.permissionMode.${
  mode === 'auto-review' ? 'autoReview' : mode === 'full-access' ? 'fullAccess' : mode
}`);

export function AgentConversationPermissionControl({
  controller,
}: { controller: AgentConversationControlsController }) {
  const permission = controller.snapshot?.permission;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useBackButton(open, () => setOpen(false));
  if (!permission) return null;
  return <>
    <button type="button" className="cc-permission-trigger"
      aria-label={t('chat.status.permissionMode')} onClick={() => setOpen(true)}>
      {modeLabel(permission.mode)}<ChevronDownIcon />
    </button>
    {open && <>
      <div className="cc-context-backdrop" data-conversation-overlay
        onClick={() => setOpen(false)} />
      <section className="cc-context-popover cc-permission-popover" data-conversation-overlay
        role="dialog" aria-modal="true"
        aria-label={t('chat.status.permissionMode')}>
        <div className="cc-context-popover-title"><span>{t('chat.status.permissionMode')}</span></div>
        <div className="cc-context-permission-options" role="radiogroup">
          {permission.options.map((mode) => <button type="button" role="radio" key={mode}
            aria-checked={mode === permission.mode}
            disabled={controller.busy || !controller.snapshot?.permissionCanUpdate}
            className={mode === permission.mode ? 'selected' : ''}
            onClick={() => {
              setError('');
              void controller.setPermission(mode).then(() => setOpen(false))
                .catch(() => setError(t('chat.controls.actionFailed')));
            }}>
            <span><strong>{modeLabel(mode)}</strong>
              <small>{t(`chat.permissionMode.${mode === 'auto-review' ? 'autoReview'
                : mode === 'full-access' ? 'fullAccess' : 'default'}Hint`)}</small></span>
            {mode === permission.mode && <CheckIcon />}
          </button>)}
        </div>
        {error && <div className="cc-context-error" role="status">{error}</div>}
      </section>
    </>}
  </>;
}

export function AgentConversationActionControls({
  controller,
  sessionId,
  showPermission,
  showContext,
}: {
  controller: AgentConversationControlsController;
  sessionId: string;
  showPermission: boolean;
  showContext: boolean;
}) {
  return <>
    {showPermission && <AgentConversationPermissionControl controller={controller} />}
    {showContext && <AgentConversationContextControl controller={controller} sessionId={sessionId} />}
  </>;
}

function ContextCopyRow({
  label, value, copied, onCopy,
}: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return <button type="button" className="cc-context-row cc-context-copy-row" onClick={onCopy}>
    <span>{label}</span><code className="cc-context-copy-value">{value}</code>
    <i className={`cc-context-copy-icon${copied ? ' copied' : ''}`}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </i>
  </button>;
}
