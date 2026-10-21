import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentRunRef } from '../agentCatalog.js';
import { scheduledRequest } from '../scheduledMessagesApi.js';
import type { ScheduledException, ScheduledRule, ScheduledTask, ScheduledScope } from '../scheduledMessagesApi.js';
import { scheduledDisplayLocal, scheduledLocalInput, scheduledOnceDefault, scheduledRuleComplete, scheduledSummary, scheduledRelativeTime, scheduledRuleSummary, scheduledTaskTimeHint } from '../scheduledMessagesPresentation.js';
import { useScheduledMessagesSnapshot } from '../hooks/useScheduledMessagesSnapshot.js';
import type { ScheduledMessagesSnapshotController } from '../hooks/useScheduledMessagesSnapshot.js';
import { useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { ClockIcon, XIcon, MoreHorizontalIcon, ChevronRightIcon, PlusIcon } from './icons.jsx';
import ActionSheet from './ActionSheet.js';
import Dropdown from './Dropdown.js';
import { getLangCode, t } from '../i18n';
import './scheduledMessages.css';

type Page = 'list' | 'editor' | 'detail';
type Picker = { kind: 'slot' | 'cutoff'; index: number; date: string; time: string; minute: number; local: string };
type SelectionKey = { kind: 'task' | 'exception'; id: string };
type PendingAction = { action: string; id?: string; kind: 'task' | 'exception'; navigation: number };
type Selection = { kind: 'task'; item: ScheduledTask } | { kind: 'exception'; item: ScheduledException };
interface Editor {
  task?: ScheduledTask;
  exception?: ScheduledException;
  text: string;
  frequency: ScheduledRule['frequency'];
  slots: ScheduledRule['slots'];
  endsAtLocal: string;
  restoreEnabled?: boolean;
}
interface Confirmation { message: string; action: () => void; label?: string }

function StatusBadge({ selection, showFrequency = false }: { selection: Selection; showFrequency?: boolean }) {
  const task = selection.kind === 'task' ? selection.item : null;
  const recurring = showFrequency && task?.state === 'active' && task.rule.frequency !== 'once';
  if (task?.state === 'active' && task.enabled && !task.blocked && !recurring) return null;
  const status = selection.kind === 'exception' || task?.state === 'exception' ? 'exception'
    : task?.state === 'ended' ? task.endedReason === 'terminated' ? 'terminated' : 'ended' : task?.blocked ? 'exception' : task?.enabled ? 'frequency' : 'paused';
  const label = status === 'exception' ? 'scheduled.exception' : `scheduled.${status}`;
  return <span className={`scheduled-status-badge scheduled-status-${status}${recurring ? ' scheduled-frequency-badge' : ''}`}>{recurring ? `${t(`scheduled.${task.rule.frequency}`)}${status === 'frequency' ? '' : ` · ${t(label)}`}` : t(label)}</span>;
}
function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="settings-page-row settings-page-value-row">
    <span className="settings-page-row-label">{label}</span>
    <span className="settings-page-row-value">{children}</span>
  </div>;
}

function scheduleDateTime(at: number | undefined | null, timeZone: string): string {
  return at == null ? '—' : scheduledDisplayLocal(scheduledLocalInput(at, timeZone), true);
}
function resultText(reason: string): string {
  const key = `scheduled.result.${reason}`;
  return t(key) === key ? t('scheduled.result.failed') : t(key);
}
// Snapshot objects are new on each poll. Compare concrete row/draft fields, never revision alone.
function sameRowSelection(left: Selection, right: Selection): boolean {
  if (left.kind !== right.kind) return false;
  const a = left.item; const b = right.item;
  if (a.id !== b.id || a.revision !== b.revision || a.text !== b.text || a.timeZone !== b.timeZone
    || a.target.agentId !== b.target.agentId || a.target.sessionId !== b.target.sessionId
    || a.target.tmuxSession !== b.target.tmuxSession || a.target.paneId !== b.target.paneId) return false;
  if (left.kind === 'task' && right.kind === 'task') {
    const a = left.item; const b = right.item;
    return a.state === b.state && a.enabled === b.enabled && a.blocked === b.blocked && a.claim?.at === b.claim?.at
      && a.nextAt === b.nextAt && a.expired === b.expired && a.endedAt === b.endedAt && a.endedReason === b.endedReason && a.lastAt === b.lastAt && a.lastResult === b.lastResult
      && a.rule.frequency === b.rule.frequency && a.rule.endsAt === b.rule.endsAt && a.rule.slots.length === b.rule.slots.length
      && a.rule.slots.every((slot, index) => { const other = b.rule.slots[index]!; return slot.date === other.date && slot.time === other.time && slot.minute === other.minute && slot.weekday === other.weekday; });
  }
  if (left.kind === 'exception' && right.kind === 'exception') {
    const a = left.item; const b = right.item;
    return a.taskId === b.taskId && a.scheduledAt === b.scheduledAt && a.reason === b.reason && a.unknown === b.unknown
      && a.count === b.count && a.missedThroughAt === b.missedThroughAt;
  }
  return false;
}
interface ScheduledRowProps {
  selection: Selection; timeHint: string; language: string; saving: boolean; pendingAction: string | undefined;
  onDetail(key: SelectionKey): void; onEdit(key: SelectionKey): void; onMenu(key: SelectionKey): void;
}
const ScheduledMessageRow = memo(function ScheduledMessageRow({ selection, timeHint, saving, pendingAction, onDetail, onEdit, onMenu }: ScheduledRowProps) {
  const { item } = selection;
  const key = { kind: selection.kind, id: item.id };
  const isException = selection.kind === 'exception';
  const task = selection.kind === 'task' ? selection.item : null;
  const exception = selection.kind === 'exception' ? selection.item : null;
  const at = task ? scheduleDateTime(task.state === 'ended' ? task.endedAt : task.nextAt, task.timeZone) : '';
  const next = `${at}${timeHint ? ` (${timeHint})` : ''}`;
  const recurring = task?.state === 'active' && task.rule.frequency !== 'once';
  const metadata = exception ? `${scheduleDateTime(exception.scheduledAt, exception.timeZone)} · ${resultText(exception.reason)}`
    : task!.state === 'ended' ? `${at}${task!.endedReason === 'terminated' ? '' : ` · ${resultText(task!.lastResult ?? 'submitted')}`}`
      : task!.rule.frequency === 'once' ? next : `${next} · ${scheduledRuleSummary(task!.rule)}`;
  const action = isException ? 'reschedule' : task!.state === 'ended' ? 'more' : 'edit';
  return <li aria-busy={!!pendingAction} className={`scheduled-list-row${task?.state === 'ended' ? ' scheduled-state-ended' : isException || task?.blocked ? ' scheduled-state-exception' : ''}`}>
    <button type="button" className="scheduled-list-main" onClick={() => onDetail(key)}>
      <span className="scheduled-list-copy">
        <span className={`scheduled-list-line scheduled-list-summary${recurring ? ' has-frequency' : ''}`}>{recurring ? <><span className="scheduled-list-summary-text">{scheduledSummary(item.text)}</span>{!pendingAction && <StatusBadge selection={selection} showFrequency />}</> : scheduledSummary(item.text)}</span>
        <span className="scheduled-list-line scheduled-list-meta">{!!pendingAction ? <span className="scheduled-inline-status" role="status">{t(pendingAction === 'trigger' ? 'scheduled.submitting' : 'scheduled.saving')}</span> : !recurring && <StatusBadge selection={selection} />}<span className="scheduled-list-meta-copy">{metadata}</span></span>
      </span>
    </button>
    {action !== 'more' && <button type="button" className="scheduled-row-action" disabled={saving || exception?.unknown || !!task?.claim}
      onClick={() => onEdit(key)}>{t(action === 'edit' ? 'scheduled.editAction' : `scheduled.${action}`)}</button>}
    <button type="button" className="scheduled-more" aria-label={t('scheduled.more')}
      disabled={saving} onClick={() => onMenu(key)}><MoreHorizontalIcon /></button>
  </li>;

}, (a, b) => a.language === b.language && a.timeHint === b.timeHint && a.saving === b.saving && a.pendingAction === b.pendingAction
  && a.onDetail === b.onDetail && a.onEdit === b.onEdit && a.onMenu === b.onMenu && sameRowSelection(a.selection, b.selection));

export interface ScheduledMessageInitialDraft { text: string; sendAt?: number }

export default function ScheduledMessagesSheet({ scope, run, onClose, controller, initialDraft }: {
  scope: ScheduledScope; run: AgentRunRef | null; onClose: () => void;
  controller?: ScheduledMessagesSnapshotController;
  initialDraft?: ScheduledMessageInitialDraft;
}) {
  const fallback = useScheduledMessagesSnapshot(scope, controller === undefined);
  const source = controller ?? fallback;
  const snapshot = source.snapshot;
  const [tab, setTab] = useState<'active' | 'ended' | 'exceptions'>('active');
  const [pages, setPages] = useState<Page[]>(['list']);
  const [picker, setPicker] = useState<Picker | null>(null);
  const frequencyDrafts = useRef<Partial<Record<ScheduledRule['frequency'], { slots: ScheduledRule['slots']; endsAtLocal: string }>>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detailKey, setDetailKey] = useState<SelectionKey | null>(null);
  const [menuKey, setMenuKey] = useState<SelectionKey | null>(null);
  const resolveSelection = (key: SelectionKey | null): Selection | null => {
    if (!key || !snapshot) return null;
    if (key.kind === 'task') { const item = snapshot.tasks.find(item => item.id === key.id); return item ? { kind: 'task', item } : null; }
    const item = snapshot.exceptions.find(item => item.id === key.id); return item ? { kind: 'exception', item } : null;
  };
  const detail = resolveSelection(detailKey);
  const menu = resolveSelection(menuKey);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const saving = pending !== null;
  const [feedback, setFeedback] = useState<string>('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshEpoch = useRef(0);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const failedRefreshSnapshot = useRef(snapshot);
  useEffect(() => {
    if (snapshot && !source.error && snapshot !== failedRefreshSnapshot.current) { setRefreshError(''); failedRefreshSnapshot.current = snapshot; }
  }, [snapshot, source.error]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 2500);
    return () => clearTimeout(timer);
  }, [feedback]);
  const openingEditor = useRef<{ leave?: () => void } | null>(null);
  const navigationEpoch = useRef(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const scrollBody = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [previewError, setPreviewError] = useState('');
  const [preview, setPreview] = useState<{ nextAt: number | null; timeZone: string } | null>(null);
  const mounted = useRef(true);
  const runRef = useRef(run);
  const pagesRef = useRef(pages);
  const historyDepth = useRef(0);
  const pendingHistoryDrop = useRef(0);
  runRef.current = run;
  pagesRef.current = pages;
  const page = pages.at(-1)!;
  const viewKey = page === 'list' ? `list:${tab}` : page === 'detail' ? `detail:${detailKey?.kind}:${detailKey?.id}` : 'editor';
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const rememberScroll = () => { if (viewKeyRef.current.startsWith('list:')) scrollPositions.current.set(viewKeyRef.current, scrollBody.current?.scrollTop ?? 0); };
  useLayoutEffect(() => { if (scrollBody.current) scrollBody.current.scrollTop = page === 'list' ? scrollPositions.current.get(viewKey) ?? 0 : 0; }, [viewKey]);
  const changeTab = (next: typeof tab) => {
    if (tab === next) return;
    if (openingEditor.current) { openingEditor.current.leave = () => changeTab(next); return; }
    rememberScroll(); navigationEpoch.current++; setError(''); setFeedback('');
    setDirection(['active', 'ended', 'exceptions'].indexOf(next) > ['active', 'ended', 'exceptions'].indexOf(tab) ? 'forward' : 'back');
    setTab(next);
  };
  const zone = editor?.task?.timeZone ?? editor?.exception?.timeZone ?? snapshot?.timeZone;

  const request = <T,>(action: string, fields: Record<string, unknown> = {}) =>
    scheduledRequest<T>(scope, runRef.current, action, fields);
  const reload = source.refresh;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // One browser-history owner for the drawer, its drilldown pages and temporary action/confirmation layers.
  const queueUnwind = (depth: number) => {
    if (depth <= 0) return;
    pendingHistoryDrop.current += depth;
    if (pendingHistoryDrop.current !== depth) return;
    queueMicrotask(() => {
      const count = pendingHistoryDrop.current;
      pendingHistoryDrop.current = 0;
      unwindHistory(count);
    });
  };
  const pushLevel = () => {
    window.history.pushState({ scheduledMessages: true, depth: historyDepth.current + 1 }, '');
    historyDepth.current++;
  };
  const dropLevel = () => {
    if (historyDepth.current > 0) { historyDepth.current--; queueUnwind(1); }
  };
  const replacePages = (next: Page[], motion: 'forward' | 'back' = 'forward') => { rememberScroll(); navigationEpoch.current++; setDirection(motion); setError(''); setFeedback(''); pagesRef.current = next; setPages(next); };
  const enter = (next: Page) => { pushLevel(); replacePages([...pagesRef.current, next]); };
  const popPage = (unwind = true) => {
    if (unwind) dropLevel();
    const previous = pagesRef.current.at(-1);
    replacePages(pagesRef.current.slice(0, -1), 'back');
    if (previous === 'editor') { setEditor(null); setDirty(false); setError(''); }
  };
  const returnToList = () => {
    const depth = Math.min(pagesRef.current.length - 1, historyDepth.current);
    historyDepth.current -= depth;
    queueUnwind(depth);
    replacePages(['list'], 'back');
    setEditor(null); setDetailKey(null); setDirty(false); setError('');
  };
  const showConfirm = (value: Confirmation) => { pushLevel(); setConfirm(value); };
  const dismissConfirm = () => { dropLevel(); setConfirm(null); };
  const closeMenu = () => { dropLevel(); setMenuKey(null); };
  const openMenu = (selection: Selection) => { pushLevel(); setMenuKey({ kind: selection.kind, id: selection.item.id }); };
  const leave = (action: () => void) => {
    if (openingEditor.current) { openingEditor.current.leave = action; return; }
    const exit = () => { void exitEditor(action); };
    if (dirty) showConfirm({ message: t('scheduled.discardChanges'), action: exit });
    else exit();
  };
  const back = () => page === 'editor' ? leave(() => popPage()) : popPage();
  const close = () => leave(onClose);
  useHistoryLayer(true, () => {
    historyDepth.current = Math.max(0, historyDepth.current - 1);
    if (picker) { setPicker(null); return; }
    if (confirm) { setConfirm(null); return; }
    if (menu) { setMenuKey(null); return; }
    if (pagesRef.current.length > 1) {
      if (pagesRef.current.at(-1) === 'editor') {
        pushLevel();
        leave(() => popPage());
      } else popPage(false);
    } else close();
  });
  useEffect(() => {
    pushLevel();
    return () => { queueUnwind(historyDepth.current); historyDepth.current = 0; };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    if (menuKey && !menu) closeMenu();
    if (detailKey && !detail && page === 'detail') returnToList();
  }, [snapshot, menuKey, detailKey, page]);

  const rule = useMemo(() => editor ? {
    frequency: editor.frequency, slots: editor.slots,
    ...(editor.frequency === 'once' ? {} : { endsAtLocal: editor.endsAtLocal }),
  } : null, [editor?.frequency, editor?.slots, editor?.endsAtLocal]);
  const cutoffMin = snapshot && zone ? scheduledLocalInput(snapshot.serverNow, zone) : '';
  const cutoffMax = snapshot && zone ? scheduledLocalInput(snapshot.serverNow + 365 * 86400000, zone) : '';
  const cutoffOutOfRange = !!editor && editor.frequency !== 'once' && !!editor.endsAtLocal &&
    (editor.endsAtLocal < cutoffMin || editor.endsAtLocal > cutoffMax);
  const complete = !!rule && scheduledRuleComplete(rule) && !cutoffOutOfRange;
  const previewNextAt = preview?.nextAt != null && snapshot && preview.nextAt > snapshot.serverNow ? preview.nextAt : null;
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (!rule || !complete) return;
    let valid = true;
    const timer = setTimeout(() => {
      void request<{ nextAt: number | null; timeZone: string }>('preview', {
        request: rule, ...(zone ? { timeZone: zone } : {}),
      }).then((result) => { if (valid) setPreview(result); })
        .catch((cause) => { if (valid) setPreviewError(cause instanceof Error ? cause.message : t('scheduled.chooseFuture')); });
    }, 200);
    return () => { valid = false; clearTimeout(timer); };
  }, [rule, zone, complete]);

  const dateTime = (at: number | undefined | null, timeZone = zone ?? snapshot?.timeZone, relative = false) => at == null ? '—'
    : `${scheduleDateTime(at, timeZone!)}${relative && snapshot ? ` (${scheduledRelativeTime(at, snapshot.serverNow)})` : ''}`;
  const change = (update: Partial<Editor>) => {
    setEditor((current) => current ? { ...current, ...update } : current);
    setDirty(true);
  };
  const edit = (task?: ScheduledTask, exception?: ScheduledException, copyText?: string, restoreEnabled?: boolean) => {
    if (!snapshot) return;
    const timeZone = task?.timeZone ?? exception?.timeZone ?? snapshot.timeZone;
    setEditor({
      ...(task ? { task, restoreEnabled: restoreEnabled ?? task.enabled } : {}), ...(exception ? { exception } : {}),
      text: task?.text ?? exception?.text ?? copyText ?? '', frequency: task?.rule.frequency ?? 'once',
      slots: task ? structuredClone(task.rule.slots) : scheduledOnceDefault(snapshot.serverNow, timeZone),
      endsAtLocal: task?.rule.endsAt ? scheduledLocalInput(Date.parse(task.rule.endsAt), timeZone) : '',
    });
    frequencyDrafts.current = {}; setPicker(null); setDirty(copyText !== undefined); setError('');
    if (copyText !== undefined && page === 'detail') replacePages(['list', 'editor']);
    else enter('editor');
  };
  const initialDraftApplied = useRef(false);
  useEffect(() => {
    if (!initialDraft || !snapshot || initialDraftApplied.current) return;
    initialDraftApplied.current = true;
    edit(undefined, undefined, initialDraft.text);
    if (initialDraft.sendAt !== undefined && initialDraft.sendAt > snapshot.serverNow) {
      const local = scheduledLocalInput(initialDraft.sendAt, snapshot.timeZone);
      setEditor(current => current ? { ...current, slots: [{ date: local.slice(0, 10), time: local.slice(11, 16) }] } : current);
    }
    setDirty(false);
  }, [initialDraft, snapshot]);
  const chooseFrequency = (frequency: ScheduledRule['frequency']) => {
    if (!editor || !snapshot || editor.frequency === frequency) return;
    const defaultSlot = scheduledOnceDefault(snapshot.serverNow, zone!)[0]!;
    const weekday = new Date(`${defaultSlot.date}T00:00:00Z`).getUTCDay() || 7;
    const slots = frequency === 'once' ? [defaultSlot]
      : frequency === 'hourly' ? [{ minute: Number(defaultSlot.time!.slice(3)) }]
        : frequency === 'weekly' ? [{ weekday, time: defaultSlot.time! }] : [{ time: defaultSlot.time! }];
    frequencyDrafts.current[editor.frequency] = { slots: structuredClone(editor.slots), endsAtLocal: editor.endsAtLocal };
    const cached = frequencyDrafts.current[frequency];
    change({ frequency, slots: cached?.slots ?? slots, endsAtLocal: cached?.endsAtLocal ?? (frequency === 'once' ? '' : editor.endsAtLocal) });
  };
  const refreshSnapshot = async () => {
    const epoch = ++refreshEpoch.current;
    setRefreshing(true); setRefreshError('');
    try { await reload(); }
    catch (cause) { if (mounted.current && epoch === refreshEpoch.current) { failedRefreshSnapshot.current = latestSnapshot.current; setRefreshError(cause instanceof Error ? cause.message : t('scheduled.loadFailed')); } }
    finally { if (mounted.current && epoch === refreshEpoch.current) setRefreshing(false); }
  };
  const mutate = async (action: string, fields: Record<string, unknown>, after?: () => void) => {
    if (pendingRef.current) return;
    const operation: PendingAction = { action, ...(typeof fields.id === 'string' ? { id: fields.id } : {}), kind: action === 'exception' ? 'exception' : 'task', navigation: navigationEpoch.current };
    pendingRef.current = operation; setPending(operation); setError(''); setFeedback('');
    try {
      await request(action, fields);
      if (!mounted.current) return;
      // Acknowledgement finishes this draft/action. A later read failure must never reopen it.
      if (operation.navigation === navigationEpoch.current) {
        after?.();
        setFeedback(t(action === 'trigger' ? 'scheduled.result.submitted' : action === 'delete' || (action === 'exception' && (fields.request as { action?: string } | undefined)?.action === 'discard') ? 'common.done' : 'scheduled.saved'));
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (operation.navigation === navigationEpoch.current) setError(cause instanceof Error ? cause.message : t('scheduled.loadFailed'));
    } finally {
      pendingRef.current = null;
      if (mounted.current) { setPending(null); void refreshSnapshot(); }
    }
  };
  const restoreTask = async (task: ScheduledTask, action: () => void) => {
    if (pendingRef.current) return;
    const operation: PendingAction = { action: 'restoreEdit', id: task.id, kind: 'task', navigation: navigationEpoch.current };
    pendingRef.current = operation; setPending(operation); setError('');
    try {
      await request('update', { id: task.id, revision: task.revision, request: { enabled: true } });
      if (mounted.current) action();
    } catch (cause) {
      if (mounted.current) { returnToList(); setError(`${t('scheduled.restoreFailed')} ${cause instanceof Error ? cause.message : ''}`.trim()); }
    } finally {
      pendingRef.current = null;
      if (mounted.current) { setPending(null); void refreshSnapshot(); }
    }
  };
  const exitEditor = async (action: () => void) => {
    if (editor?.task && editor.restoreEnabled) {
      if (pendingRef.current) { if (pendingRef.current.action === 'update') action(); return; }
      await restoreTask(editor.task, action);
    } else action();
  };
  const beginEdit = async (task: ScheduledTask) => {
    if (pendingRef.current || task.claim || task.state !== 'active') return;
    const intent: { leave?: () => void } = {};
    openingEditor.current = intent;
    const operation: PendingAction = { action: 'editPause', id: task.id, kind: 'task', navigation: navigationEpoch.current };
    pendingRef.current = operation; setPending(operation); setError('');
    try {
      const paused = await request<ScheduledTask>('update', { id: task.id, revision: task.revision, request: { enabled: false } });
      if (!mounted.current) return;
      if (paused.id !== task.id || paused.enabled !== false || paused.state !== 'active' || !Number.isSafeInteger(paused.revision)) throw new Error(t('scheduled.loadFailed'));
      openingEditor.current = null;
      pendingRef.current = null; setPending(null);
      if (intent.leave) { if (task.enabled) await restoreTask(paused, intent.leave); else intent.leave(); }
      else if (operation.navigation === navigationEpoch.current) edit(paused, undefined, undefined, task.enabled);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('scheduled.loadFailed'));
    } finally {
      openingEditor.current = null; pendingRef.current = null;
      if (mounted.current) { setPending(null); void refreshSnapshot(); }
    }
  };
  const savedToActive = () => { changeTab('active'); returnToList(); };
  const save = () => {
    if (!editor || !rule || !complete || !previewNextAt || !editor.text.trim()) return;
    if (editor.exception) void mutate('exception', {
      id: editor.exception.id, revision: editor.exception.revision, request: { action: 'reschedule', rule },
    }, savedToActive);
    else if (editor.task) void mutate('update', {
      id: editor.task.id, revision: editor.task.revision, request: { ...rule, text: editor.text, enabled: editor.restoreEnabled ?? editor.task.enabled },
    }, savedToActive);
    else void mutate('create', { request: { ...rule, text: editor.text } }, savedToActive);
  };

  const menuActions = menu?.kind === 'task' ? [
    ...(menu.item.state === 'active' ? [{
      key: 'trigger', label: t(menu.item.rule.frequency === 'once' ? 'scheduled.sendNow' : 'scheduled.triggerOnce'),
      disabled: saving || menu.item.blocked === true || !!menu.item.claim,
      onClick: () => { const task = menu.item; closeMenu(); void mutate('trigger', { id: task.id, revision: task.revision }, () => { changeTab(task.rule.frequency === 'once' ? 'ended' : 'active'); if (page === 'detail') returnToList(); }); },
    }, {
      key: 'enabled', label: t(menu.item.enabled ? 'scheduled.pause' : menu.item.expired ? 'scheduled.resumeExpired' : 'scheduled.resume'),
      disabled: saving || menu.item.blocked === true || menu.item.expired === true,
      onClick: () => { const task = menu.item; closeMenu(); void mutate('update', { id: task.id, revision: task.revision, request: { enabled: !task.enabled } }); },
    }, {
      key: 'terminate', label: t('scheduled.terminate'), danger: true, confirm: true, confirmLabel: t('scheduled.terminateConfirm'), disabled: saving || !!menu.item.claim,
      onClick: () => { const task = menu.item; closeMenu(); void mutate('terminate', { id: task.id, revision: task.revision }, () => { changeTab('ended'); if (page === 'detail') returnToList(); }); },
    }] : []),
    ...(menu.item.state === 'ended' ? [{
      key: 'copy', label: t('scheduled.copy'), disabled: saving || !run || !snapshot,
      onClick: () => { const text = menu.item.text; closeMenu(); edit(undefined, undefined, text); },
    }] : []),
    {
      key: 'delete', label: t('scheduled.delete'), danger: true, confirm: true,
      confirmLabel: t(menu.item.state === 'ended' ? 'scheduled.clearRecordConfirm' : 'scheduled.deleteConfirm'), disabled: saving,
      onClick: () => { const task = menu.item; closeMenu(); void mutate('delete', { id: task.id, revision: task.revision }, page === 'detail' ? returnToList : undefined); },
    },
  ] : menu ? [{
    key: 'discard', label: t('scheduled.discard'), danger: true, confirm: true,
    confirmLabel: t('scheduled.discardException'), disabled: saving,
    onClick: () => { const item = menu.item; closeMenu(); void mutate('exception', { id: item.id, revision: item.revision, request: { action: 'discard' } }, page === 'detail' ? returnToList : undefined); },
  }] : [];

  const title = page === 'list' ? t('scheduled.title') : page === 'detail' ? t('scheduled.detail')
    : t(editor?.task ? 'scheduled.edit' : editor?.exception ? 'scheduled.reschedule' : 'scheduled.add');
  const activeCount = snapshot?.tasks.filter(task => task.state === 'active' && task.enabled).length;
  const tasks = snapshot?.tasks.filter((task) => task.state === tab) ?? [];
  if (tab === 'ended') tasks.sort((a, b) => (b.endedAt ?? b.lastAt ?? 0) - (a.endedAt ?? a.lastAt ?? 0));
  const items: Selection[] = tab === 'exceptions'
    ? (snapshot?.exceptions ?? []).map((item) => ({ kind: 'exception', item }))
    : tasks.map((item) => ({ kind: 'task', item }));
  const showDetail = (selection: Selection) => { if (openingEditor.current) { openingEditor.current.leave = () => showDetail(selection); return; } setDetailKey({ kind: selection.kind, id: selection.item.id }); enter('detail'); };
  // Stable row callbacks dereference the current snapshot/clock/navigation rather than old render closures.
  const rowActions = useRef<{ detail(key: SelectionKey): void; edit(key: SelectionKey): void; menu(key: SelectionKey): void } | null>(null);
  rowActions.current = {
    detail: key => { const selection = resolveSelection(key); if (selection) showDetail(selection); },
    edit: key => { const selection = resolveSelection(key); if (selection?.kind === 'task') void beginEdit(selection.item); else if (selection) edit(undefined, selection.item); },
    menu: key => { const selection = resolveSelection(key); if (selection) openMenu(selection); },
  };
  const rowDetail = useCallback((key: SelectionKey) => rowActions.current?.detail(key), []);
  const rowEdit = useCallback((key: SelectionKey) => rowActions.current?.edit(key), []);
  const rowMenu = useCallback((key: SelectionKey) => rowActions.current?.menu(key), []);


  const renderTabs = () => <div className="file-seg scheduled-tabs" role="tablist">
      {(['active', 'ended', 'exceptions'] as const).map((value) => <button type="button" role="tab"
        aria-selected={tab === value} className={`file-seg-btn${tab === value ? ' on' : ''}${value === 'ended' ? ' scheduled-state-ended' : value === 'exceptions' && snapshot?.exceptions.length ? ' scheduled-state-exception' : ''}`}
        key={value} onClick={() => changeTab(value)}>{t(`scheduled.${value}`)}{snapshot && value !== 'ended' && <span className="scheduled-tab-count"> {value === 'active' ? activeCount : snapshot.exceptions.length}</span>}</button>)}
    </div>;
  const language = getLangCode();
  const renderList = () => <div className="scheduled-list-body">
      {items.length ? <ul className="scheduled-list">{items.map(selection => <ScheduledMessageRow key={`${selection.kind}:${selection.item.id}`} selection={selection}
        timeHint={selection.kind === 'task' && selection.item.state === 'active' && snapshot ? scheduledTaskTimeHint(selection.item, snapshot.serverNow) : ''} language={language} saving={saving} pendingAction={pending?.id === selection.item.id && pending.kind === selection.kind ? pending.action : undefined}
        onDetail={rowDetail} onEdit={rowEdit} onMenu={rowMenu} />)}</ul> : <p className="scheduled-empty">{t(snapshot ? 'scheduled.empty' : 'scheduled.loading')}</p>}
    </div>;

  const resizeMessage = () => {
    const input = messageInput.current;
    if (!input) return;
    const style = getComputedStyle(input);
    const rawLine = Number.parseFloat(style.lineHeight);
    const line = style.lineHeight.endsWith('px') ? rawLine : rawLine * (Number.parseFloat(style.fontSize) || 16) || 24;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    input.style.height = 'auto';
    const minimum = line * 3 + padding; const maximum = line * 8 + padding;
    input.style.height = `${Math.max(minimum, Math.min(maximum, input.scrollHeight))}px`;
    input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
  };
  useLayoutEffect(resizeMessage, [editor?.text, page]);
  useLayoutEffect(() => {
    const input = messageInput.current;
    if (!input) return;
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next !== width) { width = next; resizeMessage(); }
    });
    observer?.observe(input);
    window.addEventListener('resize', resizeMessage);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resizeMessage); };
  }, [page]);
  const renderEditor = () => editor && <fieldset disabled={saving} className="settings-page-content scheduled-page-content scheduled-editor-fields">
    <section className="settings-page-group">
      <h2><label htmlFor="scheduled-message">{t('scheduled.message')}</label></h2>
      <div className="settings-page-list scheduled-message-card">
        <textarea ref={messageInput} id="scheduled-message" aria-label={t('scheduled.message')} value={editor.text} disabled={!!editor.exception}
          placeholder={t('scheduled.messagePlaceholder')} onChange={(event) => change({ text: event.target.value })} rows={3} />
      </div>
    </section>
    <section className="settings-page-group"><div className="settings-page-list">
      {!editor.exception && <div className="settings-page-row scheduled-cycle-row">
        <span className="settings-page-row-label">{t('scheduled.cycle')}</span>
        <Dropdown value={editor.frequency} ariaLabel={t('scheduled.cycle')}
          options={(['once', 'hourly', 'daily', 'weekly'] as const).map(value => ({ value, label: t(value === 'once' ? 'scheduled.noRepeat' : `scheduled.${value}`) }))}
          onChange={value => chooseFrequency(value as ScheduledRule['frequency'])} />
      </div>}
      {editor.frequency === 'weekly' && <div className="scheduled-weekdays">{[1, 2, 3, 4, 5, 6, 7].map(weekday => {
        const selected = editor.slots.some(slot => slot.weekday === weekday);
        return <button type="button" key={weekday} aria-pressed={selected} onClick={() => change({ slots: selected
          ? editor.slots.filter(slot => slot.weekday !== weekday)
          : [...editor.slots, { weekday, time: scheduledOnceDefault(snapshot!.serverNow, zone!)[0]!.time! }] })}>{t(`scheduled.day.${weekday}`)}</button>;
      })}</div>}
      {editor.slots.map((slot, index) => ({ slot, index })).sort((a, b) => (a.slot.weekday ?? 0) - (b.slot.weekday ?? 0)).map(({ slot, index }) =>
        <div className="settings-page-row scheduled-inline-time" key={index}>
          <span className="settings-page-row-label">{editor.frequency === 'weekly' ? t(`scheduled.day.${slot.weekday}`) : t('scheduled.sendTime')}</span>
          {editor.frequency === 'hourly' && <span>{t('scheduled.hourly')}</span>}
          <button type="button" className="scheduled-value-button" aria-label={`${t('scheduled.sendTime')} ${index + 1}`} onClick={() => openPicker('slot', index)}>
            {editor.frequency === 'once' ? `${scheduledDisplayLocal(slot.date ?? '', true)} ${slot.time ?? ''}` : editor.frequency === 'hourly' ? String(slot.minute ?? 0).padStart(2, '0') : slot.time}
          </button>
          {editor.frequency === 'hourly' && <span>{t('scheduled.minuteUnit')}</span>}
        </div>)}
      {editor.frequency !== 'once' && <div className="settings-page-row">
        <span className="settings-page-row-label">{t('scheduled.cutoff')}</span>
        <button type="button" className="scheduled-value-button" aria-label={`${t('scheduled.cutoff')} ${scheduledDisplayLocal(editor.endsAtLocal, true) || t('scheduled.chooseCutoff')}`} onClick={() => openPicker('cutoff')}>
          {scheduledDisplayLocal(editor.endsAtLocal, true) || t('scheduled.chooseCutoff')}
        </button>
      </div>}
    </div>
      <div className="settings-page-footer" role="status">{cutoffOutOfRange ? t('scheduled.cutoffLimit') : previewNextAt
        ? `${t('scheduled.next')}: ${dateTime(previewNextAt, zone, true)}`
        : !complete ? t(editor.frequency !== 'once' && !editor.endsAtLocal ? 'scheduled.chooseCutoff' : 'scheduled.chooseFuture')
          : previewError || t(preview ? 'scheduled.chooseFuture' : 'scheduled.previewing')}</div>
    </section>

  </fieldset>;

  const openPicker = (kind: Picker['kind'], index = 0) => {
    if (!editor) return;
    const slot = editor.slots[index];
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.scheduled-editor-fields')) active.blur();
    pushLevel();
    setPicker({ kind, index, date: slot?.date ?? '', time: slot?.time ?? '', minute: slot?.minute ?? 0, local: editor.endsAtLocal });
  };
  useLayoutEffect(() => {
    if (picker?.kind !== 'slot' || editor?.frequency !== 'hourly') return;
    const selected = document.querySelector<HTMLElement>('.scheduled-minute-grid [aria-pressed="true"]');
    if (selected?.parentElement) selected.parentElement.scrollTop = Math.max(0, selected.offsetTop - selected.parentElement.offsetTop - selected.parentElement.clientHeight / 2);
  }, [picker?.kind, editor?.frequency]);
  const closePicker = () => { dropLevel(); setPicker(null); };
  const confirmPicker = () => {
    if (!picker || !editor) return;
    if (picker.kind === 'cutoff') change({ endsAtLocal: picker.local });
    else change({ slots: editor.slots.map((slot, index) => index !== picker.index ? slot : editor.frequency === 'once'
      ? { ...slot, date: picker.date, time: picker.time } : editor.frequency === 'hourly'
        ? { ...slot, minute: picker.minute } : { ...slot, time: picker.time }) });
    closePicker();
  };
  const pickerValid = !!picker && (picker.kind === 'cutoff' ? !!picker.local && picker.local >= cutoffMin && picker.local <= cutoffMax : editor?.frequency === 'hourly' ? true : /^\d{2}:\d{2}$/.test(picker.time) && (editor?.frequency !== 'once' || /^\d{4}-\d{2}-\d{2}$/.test(picker.date)));
  const pickerTitle = t(picker?.kind === 'cutoff' ? 'scheduled.cutoff' : editor?.frequency === 'hourly' ? 'scheduled.minute' : 'scheduled.sendTime');
  const renderPicker = () => picker && <div className="scheduled-overlay-layer scheduled-picker-layer"><ActionSheet open title={pickerTitle}
    {...(snapshot ? { subtitle: `${t('scheduled.serverTime')}: ${scheduledDisplayLocal(scheduledLocalInput(snapshot.serverNow, snapshot.timeZone))}` } : {})}
    onClose={closePicker} actions={[{ key: 'confirm', label: t('scheduled.confirm'), disabled: !pickerValid, onClick: confirmPicker }]}>
    <div className="scheduled-confirmed-picker">
      {picker.kind === 'cutoff' ? <>
        <label className="scheduled-cutoff-choice" onClick={event => {
          const input = event.currentTarget.querySelector('input');
          if (!input || event.target === input) return;
          input.focus();
          try { input.showPicker?.(); } catch { /* Keep native keyboard segments available. */ }
        }}>
          <input className="scheduled-picker-input" type="datetime-local" aria-label={t('scheduled.cutoff')} value={picker.local} min={cutoffMin} max={cutoffMax} onChange={event => setPicker({ ...picker, local: event.target.value })} />
        </label>
        <div className="scheduled-cutoff-shortcuts">
          <p className="scheduled-quick-label">{t('scheduled.quickChoices')}</p>
          <div className="scheduled-cutoff-presets">{[7, 30, 90].map(days => <button type="button" className="fontbtn" key={days}
            onClick={() => setPicker({ ...picker, local: scheduledLocalInput(snapshot!.serverNow + days * 86400000, zone!) })}>{t('scheduled.cutoffDays', { days })}</button>)}</div>
        </div>
      </> : editor?.frequency === 'hourly' ? <div className="scheduled-minute-grid">{Array.from({ length: 60 }, (_, minute) =>
        <button type="button" key={minute} aria-pressed={picker.minute === minute} onClick={() => setPicker({ ...picker, minute })}>{String(minute).padStart(2, '0')}</button>)}</div> : <>
        {editor?.frequency === 'once' && <input className="scheduled-picker-input" type="date" aria-label={t('scheduled.date')} value={picker.date} onChange={event => setPicker({ ...picker, date: event.target.value })} />}
        <input className="scheduled-picker-input" type="time" aria-label={t('scheduled.time')} value={picker.time} onChange={event => setPicker({ ...picker, time: event.target.value })} />
      </>}
    </div>
  </ActionSheet></div>;

  const renderDetail = () => detail && <div className="settings-page-content scheduled-page-content scheduled-detail-content">
    <section className="settings-page-group"><h2>{t('scheduled.message')}</h2>
      <div className="settings-page-list scheduled-detail-text">{detail.item.text}</div>
    </section>
    <section className="settings-page-group"><div className="settings-page-list">
      {(pending?.id === detail.item.id && pending.kind === detail.kind || detail.kind === 'exception' || detail.item.state !== 'active' || !detail.item.enabled || detail.item.blocked) &&
        <ValueRow label={t('scheduled.status')}>{pending?.id === detail.item.id && pending.kind === detail.kind ? <span role="status">{t(pending.action === 'trigger' ? 'scheduled.submitting' : 'scheduled.saving')}</span> : <StatusBadge selection={detail} />}</ValueRow>}
      {detail.kind === 'task' ? <>
        <ValueRow label={t('scheduled.repeat')}>{scheduledRuleSummary(detail.item.rule)}</ValueRow>
        <ValueRow label={t(detail.item.state === 'ended' ? 'scheduled.finished' : 'scheduled.next')}>
          {dateTime(detail.item.state === 'ended' ? detail.item.endedAt : detail.item.nextAt, detail.item.timeZone)}{detail.item.state === 'active' && snapshot && scheduledTaskTimeHint(detail.item, snapshot.serverNow) ? ` (${scheduledTaskTimeHint(detail.item, snapshot.serverNow)})` : ''}</ValueRow>
        {detail.item.rule.endsAt && <ValueRow label={t('scheduled.cutoff')}>{dateTime(Date.parse(detail.item.rule.endsAt), detail.item.timeZone)}</ValueRow>}
        {detail.item.lastResult && <ValueRow label={t('scheduled.lastResult')}>{resultText(detail.item.lastResult)}</ValueRow>}
      </> : <>
        <ValueRow label={t('scheduled.sendTime')}>{dateTime(detail.item.scheduledAt, detail.item.timeZone)}</ValueRow>
        <ValueRow label={t('scheduled.lastResult')}>{resultText(detail.item.reason)}</ValueRow>
      </>}
    </div>{detail.kind === 'exception' && detail.item.unknown && <p className="settings-page-footer">{t('scheduled.unknownHelp')}</p>}</section>
  </div>;

  return <>
    <div className="tool-sheet-backdrop" onClick={close} />
    <section className="tool-sheet scheduled-sheet" role="dialog" aria-modal="true" aria-label={t('scheduled.title')}>
      <div className="tool-sheet-grip" />
      <header className="tool-sheet-head scheduled-head">
        <div className="scheduled-head-main">
          {page === 'list' && <span className="tool-sheet-ic"><ClockIcon /></span>}
          {page !== 'list' && <button type="button" className="scheduled-back" aria-label={t('scheduled.back')} onClick={back}><ChevronRightIcon /></button>}
          <span className="tool-sheet-title">{title}</span>
          {page === 'list' && <button type="button" className="scheduled-head-action" aria-label={t('scheduled.add')} disabled={saving || !run || !snapshot} onClick={() => edit()}><PlusIcon /></button>}
          {page === 'editor' && <button type="button" className="scheduled-head-action" disabled={saving || !previewNextAt || !complete || !editor?.text.trim()} onClick={save} aria-busy={saving}>{t(saving ? 'scheduled.saving' : 'scheduled.save')}</button>}
          {page === 'detail' && detail && <button type="button" className="scheduled-head-action" onClick={() => openMenu(detail)} aria-label={t('scheduled.more')}><MoreHorizontalIcon /></button>}
          <button type="button" className="cmd-close scheduled-close" aria-label={t('common.close')} onClick={close}><XIcon /></button>
        </div>
        {snapshot && <p className="scheduled-subtitle"><span className="scheduled-server-time">{t('scheduled.serverTime')}: {scheduledDisplayLocal(scheduledLocalInput(snapshot.serverNow, snapshot.timeZone))}</span>{feedback && <span className="scheduled-action-feedback" role="status" aria-live="polite">{feedback}</span>}</p>}
      </header>
      {error && <div className="scheduled-error" role="alert">{error}</div>}
      {(refreshError || source.error) && <div className="scheduled-refresh-error" role="alert"><span>{refreshError || source.error}</span><button type="button" disabled={refreshing} onClick={() => { void refreshSnapshot(); }}>{t('common.retry')}</button></div>}
      {page === 'list' && renderTabs()}
      <div ref={scrollBody} className="tool-sheet-body scheduled-body">
      <div key={viewKey} className={`scheduled-page scheduled-nav-${direction}`}>
        {page === 'list' && renderList()}
        {page === 'editor' && renderEditor()}
        {page === 'detail' && renderDetail()}
      </div>
      {page !== 'list' && snapshot && (page === 'detail' ? detail?.item.timeZone : zone) !== snapshot.timeZone &&
        <p className="settings-page-footer scheduled-zone-hint">{t('scheduled.taskTimeZone', { zone: page === 'detail' ? detail?.item.timeZone : zone })}</p>}
      </div>
    </section>
    {renderPicker()}
    {menu && <div className="scheduled-overlay-layer"><ActionSheet key={`${menu.kind}:${menu.item.id}`} open title={t('scheduled.actions')} actions={menuActions} onClose={closeMenu} /></div>}
    {confirm && <div className="settings-confirm-backdrop scheduled-confirm-layer" onClick={dismissConfirm}>
      <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-label={confirm.message}
        onClick={(event) => event.stopPropagation()}><p>{confirm.message}</p><div className="settings-confirm-actions">
          <button type="button" onClick={dismissConfirm}>{t('scheduled.cancel')}</button>
          <button type="button" className="danger" onClick={() => { const action = confirm.action; dismissConfirm(); action(); }}>{confirm.label ?? t('scheduled.confirm')}</button>
        </div></div>
    </div>}
  </>;
}
