import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentRunRef } from '../agentCatalog.js';
import { scheduledRequest } from '../scheduledMessagesApi.js';
import type { ScheduledException, ScheduledRule, ScheduledTask } from '../scheduledMessagesApi.js';
import { scheduledDisplayLocal, scheduledLocalInput, scheduledOnceDefault, scheduledRuleComplete, scheduledSummary } from '../scheduledMessagesPresentation.js';
import { useScheduledMessagesSnapshot } from '../hooks/useScheduledMessagesSnapshot.js';
import type { ScheduledMessagesSnapshotController } from '../hooks/useScheduledMessagesSnapshot.js';
import { useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { ClockIcon, XIcon, CheckIcon, MoreHorizontalIcon, ChevronRightIcon, PlusIcon } from './icons.jsx';
import ActionSheet from './ActionSheet.js';
import { t } from '../i18n';
import './scheduledMessages.css';

type Page = 'list' | 'editor' | 'detail';
type Dropdown = 'repeat' | 'time' | 'cutoff';
type Selection = { kind: 'task'; item: ScheduledTask } | { kind: 'exception'; item: ScheduledException };
interface Editor {
  task?: ScheduledTask;
  exception?: ScheduledException;
  text: string;
  frequency: ScheduledRule['frequency'];
  slots: ScheduledRule['slots'];
  endsAtLocal: string;
}
interface Confirmation { message: string; action: () => void; label?: string }

function NavRow({ label, value, onClick, expanded }: { label: string; value: string; onClick: () => void; expanded: boolean }) {
  return <button type="button" className="settings-page-row scheduled-dropdown-toggle" aria-expanded={expanded} onClick={onClick}>
    <span className="settings-page-row-label">{label}</span>
    <span className="settings-page-row-trailing">
      <span className="settings-page-row-value">{value}</span>
      <span className="settings-page-chevron" aria-hidden="true"><ChevronRightIcon /></span>
    </span>
  </button>;
}
function StatusBadge({ selection }: { selection: Selection }) {
  const task = selection.kind === 'task' ? selection.item : null;
  const status = selection.kind === 'exception' || task?.state === 'exception' ? 'exception'
    : task?.state === 'ended' ? 'ended' : task?.blocked ? 'exception' : task?.enabled ? 'pending' : 'paused';
  const label = status === 'exception' ? 'scheduled.exception' : `scheduled.${status}`;
  return <span className={`scheduled-status-badge scheduled-status-${status}`}>{t(label)}</span>;
}
function CalendarInput({ type, label, value, min, max, onChange }: {
  type: 'date' | 'datetime-local'; label: string; value: string; min?: string; max?: string; onChange: (value: string) => void;
}) {
  return <span className={`scheduled-calendar-input scheduled-calendar-${type}`}>
    <span className="scheduled-picker-display" aria-hidden="true">{scheduledDisplayLocal(value) || t('scheduled.choose')}</span>
    <input className="scheduled-picker-input" type={type} aria-label={label} value={value} min={min} max={max}
      onClick={event => { try { event.currentTarget.showPicker?.(); } catch { /* Native keyboard/picker remains available. */ } }}
      onChange={event => onChange(event.target.value)} />
  </span>;
}
function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="settings-page-row settings-page-value-row">
    <span className="settings-page-row-label">{label}</span>
    <span className="settings-page-row-value">{children}</span>
  </div>;
}

export default function ScheduledMessagesSheet({ tmuxSession, run, onClose, controller }: {
  tmuxSession: string; run: AgentRunRef | null; onClose: () => void;
  controller?: ScheduledMessagesSnapshotController;
}) {
  const fallback = useScheduledMessagesSnapshot(tmuxSession, controller === undefined);
  const source = controller ?? fallback;
  const snapshot = source.snapshot;
  const [tab, setTab] = useState<'active' | 'ended' | 'exceptions'>('active');
  const [pages, setPages] = useState<Page[]>(['list']);
  const [dropdown, setDropdown] = useState<Dropdown | null>(null);
  const toggleDropdown = (value: Dropdown) => setDropdown(current => current === value ? null : value);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detail, setDetail] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<Selection | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
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
  const zone = editor?.task?.timeZone ?? editor?.exception?.timeZone ?? snapshot?.timeZone;

  const request = <T,>(action: string, fields: Record<string, unknown> = {}) =>
    scheduledRequest<T>(tmuxSession, runRef.current, action, fields);
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
  const replacePages = (next: Page[]) => { pagesRef.current = next; setPages(next); };
  const enter = (next: Page) => { pushLevel(); replacePages([...pagesRef.current, next]); };
  const popPage = (unwind = true) => {
    if (unwind) dropLevel();
    const previous = pagesRef.current.at(-1);
    replacePages(pagesRef.current.slice(0, -1));
    if (previous === 'editor') { setEditor(null); setDirty(false); setError(''); }
  };
  const returnToList = () => {
    const depth = Math.min(pagesRef.current.length - 1, historyDepth.current);
    historyDepth.current -= depth;
    queueUnwind(depth);
    replacePages(['list']);
    setEditor(null); setDetail(null); setDirty(false); setError('');
  };
  const showConfirm = (value: Confirmation) => { pushLevel(); setConfirm(value); };
  const dismissConfirm = () => { dropLevel(); setConfirm(null); };
  const closeMenu = () => { dropLevel(); setMenu(null); };
  const openMenu = (selection: Selection) => { pushLevel(); setMenu(selection); };
  const leave = (action: () => void) => {
    if (dirty) showConfirm({ message: t('scheduled.discardChanges'), action });
    else action();
  };
  const back = () => page === 'editor' ? leave(() => popPage()) : popPage();
  const close = () => leave(onClose);
  useHistoryLayer(true, () => {
    historyDepth.current = Math.max(0, historyDepth.current - 1);
    if (confirm) { setConfirm(null); return; }
    if (menu) { setMenu(null); return; }
    if (pagesRef.current.length > 1) {
      if (pagesRef.current.at(-1) === 'editor' && dirty) {
        pushLevel();
        showConfirm({ message: t('scheduled.discardChanges'), action: () => popPage() });
      } else popPage(false);
    } else onClose();
  });
  useEffect(() => {
    pushLevel();
    return () => { queueUnwind(historyDepth.current); historyDepth.current = 0; };
  }, []);

  const rule = useMemo(() => editor ? {
    frequency: editor.frequency, slots: editor.slots,
    ...(editor.frequency === 'once' ? {} : { endsAtLocal: editor.endsAtLocal }),
  } : null, [editor]);
  const cutoffMin = snapshot && zone ? scheduledLocalInput(snapshot.serverNow, zone) : '';
  const cutoffMax = snapshot && zone ? scheduledLocalInput(snapshot.serverNow + 365 * 86400000, zone) : '';
  const cutoffOutOfRange = !!editor && editor.frequency !== 'once' && !!editor.endsAtLocal &&
    (editor.endsAtLocal < cutoffMin || editor.endsAtLocal > cutoffMax);
  const complete = !!rule && scheduledRuleComplete(rule) && !cutoffOutOfRange;
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

  const dateTime = (at: number | undefined | null, timeZone = zone ?? snapshot?.timeZone) => at == null ? '—'
    : scheduledDisplayLocal(scheduledLocalInput(at, timeZone!));
  const resultText = (reason: string) => {
    const key = `scheduled.result.${reason}`;
    return t(key) === key ? t('scheduled.result.failed') : t(key);
  };
  const change = (update: Partial<Editor>) => {
    setEditor((current) => current ? { ...current, ...update } : current);
    setDirty(true);
  };
  const edit = (task?: ScheduledTask, exception?: ScheduledException) => {
    if (!snapshot) return;
    const timeZone = task?.timeZone ?? exception?.timeZone ?? snapshot.timeZone;
    setEditor({
      ...(task ? { task } : {}), ...(exception ? { exception } : {}),
      text: task?.text ?? exception?.text ?? '', frequency: task?.rule.frequency ?? 'once',
      slots: task ? structuredClone(task.rule.slots) : scheduledOnceDefault(snapshot.serverNow, timeZone),
      endsAtLocal: task?.rule.endsAt ? scheduledLocalInput(Date.parse(task.rule.endsAt), timeZone) : '',
    });
    setDropdown(null); setDirty(false); setError(''); enter('editor');
  };
  const chooseFrequency = (frequency: ScheduledRule['frequency']) => {
    setDropdown(null);
    if (!editor || !snapshot || editor.frequency === frequency) return;
    const defaultSlot = scheduledOnceDefault(snapshot.serverNow, zone!)[0]!;
    const weekday = new Date(`${defaultSlot.date}T00:00:00Z`).getUTCDay() || 7;
    const slots = frequency === 'once' ? [defaultSlot]
      : frequency === 'hourly' ? [{ minute: Number(defaultSlot.time!.slice(3)) }]
        : frequency === 'weekly' ? [{ weekday, time: defaultSlot.time! }] : [{ time: defaultSlot.time! }];
    change({ frequency, slots, ...(frequency === 'once' ? { endsAtLocal: '' } : {}) });
  };
  const mutate = async (action: string, fields: Record<string, unknown>, after?: () => void) => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await request(action, fields);
      if (!mounted.current) return;
      await reload();
      if (mounted.current) after?.();
    }
    catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : t('scheduled.loadFailed'));
      void reload().catch(() => {});
    } finally { if (mounted.current) setSaving(false); }
  };
  const save = () => {
    if (!editor || !rule || !complete || !preview?.nextAt || !editor.text.trim()) return;
    if (editor.exception) void mutate('exception', {
      id: editor.exception.id, revision: editor.exception.revision, request: { action: 'reschedule', rule },
    }, returnToList);
    else if (editor.task) void mutate('update', {
      id: editor.task.id, revision: editor.task.revision, request: { ...rule, text: editor.text },
    }, returnToList);
    else void mutate('create', { request: { ...rule, text: editor.text } }, returnToList);
  };

  const confirmDelete = (task: ScheduledTask) => showConfirm({
    message: t(task.state === 'ended' ? 'scheduled.clearRecordConfirm' : 'scheduled.deleteConfirm'), label: t('scheduled.delete'),
    action: () => { void mutate('delete', { id: task.id, revision: task.revision }); },
  });

  const menuActions = menu?.kind === 'task' ? [
    ...(menu.item.state === 'active' ? [{
      key: 'enabled', label: t(menu.item.enabled ? 'scheduled.pause' : 'scheduled.resume'),
      disabled: saving || menu.item.blocked === true,
      onClick: () => { const task = menu.item; closeMenu(); void mutate('update', { id: task.id, revision: task.revision, request: { enabled: !task.enabled } }); },
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

  const timeSummary = editor?.slots.map((slot) => editor.frequency === 'hourly'
    ? t('scheduled.hourlyMinute', { minute: slot.minute })
    : `${editor.frequency === 'weekly' ? `${t(`scheduled.day.${slot.weekday}`)} ` : slot.date ? `${scheduledDisplayLocal(slot.date)} ` : ''}${slot.time ?? ''}`).join('、') ?? '';
  const title = page === 'list' ? t('scheduled.title') : page === 'detail' ? t('scheduled.detail')
    : t(editor?.task ? 'scheduled.edit' : editor?.exception ? 'scheduled.reschedule' : 'scheduled.add');
  const tasks = snapshot?.tasks.filter((task) => task.state === tab) ?? [];
  const items: Selection[] = tab === 'exceptions'
    ? (snapshot?.exceptions ?? []).map((item) => ({ kind: 'exception', item }))
    : tasks.map((item) => ({ kind: 'task', item }));
  const showDetail = (selection: Selection) => { setDetail(selection); enter('detail'); };

  const renderList = () => <>
    <div className="file-seg scheduled-tabs" role="tablist">
      {(['active', 'ended', 'exceptions'] as const).map((value) => <button type="button" role="tab"
        aria-selected={tab === value} className={`file-seg-btn${tab === value ? ' on' : ''}${value === 'ended' ? ' scheduled-state-ended' : value === 'exceptions' && snapshot?.exceptions.length ? ' scheduled-state-exception' : ''}`}
        key={value} onClick={() => setTab(value)}>{t(`scheduled.${value}`)}</button>)}
    </div>
    <div className="scheduled-list-body">
      {items.length ? <ul className="scheduled-list">{items.map((selection) => {
        const { item } = selection;
        const isException = selection.kind === 'exception';
        const task = selection.kind === 'task' ? selection.item : null;
        const exception = selection.kind === 'exception' ? selection.item : null;
        const metadata = exception ? `${dateTime(exception.scheduledAt, exception.timeZone)} · ${resultText(exception.reason)}`
          : `${dateTime(task!.state === 'ended' ? task!.endedAt : task!.nextAt, task!.timeZone)} · ${task!.state === 'ended'
            ? resultText(task!.lastResult ?? 'submitted') : t(`scheduled.${task!.rule.frequency}`)}`;
        const action = isException ? 'reschedule' : task!.state === 'ended' ? 'delete' : 'edit';
        return <li className={`scheduled-list-row${task?.state === 'ended' ? ' scheduled-state-ended' : isException || task?.blocked ? ' scheduled-state-exception' : ''}`} key={`${selection.kind}:${item.id}`}>
          <button type="button" className="scheduled-list-main" onClick={() => showDetail(selection)}>
            <span className="scheduled-list-copy">
              <span className="scheduled-list-line scheduled-list-summary">{scheduledSummary(item.text)}</span>
              <span className="scheduled-list-line scheduled-list-meta"><StatusBadge selection={selection} /><span className="scheduled-list-meta-copy">{metadata}</span></span>
            </span>
          </button>
          <button type="button" className="scheduled-row-action" disabled={saving || exception?.unknown}
            onClick={() => action === 'delete' ? confirmDelete(task!) : edit(task ?? undefined, exception ?? undefined)}>{t(action === 'edit' ? 'scheduled.editAction' : `scheduled.${action}`)}</button>
          {action !== 'delete' && <button type="button" className="scheduled-more" aria-label={t('scheduled.more')}
            disabled={saving} onClick={() => openMenu(selection)}><MoreHorizontalIcon /></button>}
        </li>;
      })}</ul> : <p className="scheduled-empty">{t(snapshot ? 'scheduled.empty' : 'scheduled.loading')}</p>}
    </div>
  </>;

  const renderEditor = () => editor && <div className="settings-page-content scheduled-page-content">
    <section className="settings-page-group">
      <h2><label htmlFor="scheduled-message">{t('scheduled.message')}</label></h2>
      <div className="settings-page-list scheduled-message-card">
        <textarea id="scheduled-message" aria-label={t('scheduled.message')} value={editor.text} disabled={!!editor.exception}
          placeholder={t('scheduled.messagePlaceholder')} onChange={(event) => change({ text: event.target.value })} rows={3} />
      </div>
    </section>
    <section className="settings-page-group"><div className="settings-page-list">
      {!editor.exception && <>
        <NavRow label={t('scheduled.repeat')} value={t(`scheduled.${editor.frequency}`)} expanded={dropdown === 'repeat'} onClick={() => toggleDropdown('repeat')} />
        {dropdown === 'repeat' && <div className="scheduled-dropdown settings-choice-list">{(['once', 'hourly', 'daily', 'weekly'] as const).map(frequency =>
          <button type="button" key={frequency} className="settings-page-row settings-choice-row" aria-pressed={editor.frequency === frequency} onClick={() => chooseFrequency(frequency)}>
            <span className="settings-page-row-label">{t(`scheduled.${frequency}`)}</span>
            <span className="settings-choice-check" aria-hidden="true">{editor.frequency === frequency && <CheckIcon />}</span>
          </button>)}</div>}
      </>}
      <NavRow label={t('scheduled.sendTime')} value={timeSummary} expanded={dropdown === 'time'} onClick={() => toggleDropdown('time')} />
      {dropdown === 'time' && renderTimePicker()}
      {editor.frequency !== 'once' && <>
        <NavRow label={t('scheduled.cutoff')} value={scheduledDisplayLocal(editor.endsAtLocal) || t('scheduled.choose')} expanded={dropdown === 'cutoff'} onClick={() => toggleDropdown('cutoff')} />
        {dropdown === 'cutoff' && <div className="scheduled-dropdown">
          <div className="scheduled-cutoff-presets">{[7, 30, 90].map(days => <button type="button" key={days} className="fontbtn" onClick={() => change({ endsAtLocal: scheduledLocalInput(snapshot!.serverNow + days * 86400000, zone!) })}>{t('scheduled.cutoffDays', { days })}</button>)}</div>
          <label className="settings-page-row scheduled-cutoff-row"><span className="settings-page-row-label">{t('scheduled.customCutoff')}</span>
            <CalendarInput type="datetime-local" label={t('scheduled.cutoff')} value={editor.endsAtLocal} min={cutoffMin} max={cutoffMax}
              onChange={value => change({ endsAtLocal: value })} /></label>
        </div>}
      </>}
    </div>
      <div className="settings-page-footer" role="status">{cutoffOutOfRange ? t('scheduled.cutoffLimit') : preview?.nextAt
        ? `${t('scheduled.next')}: ${dateTime(preview.nextAt)}`
        : !complete ? t(editor.frequency !== 'once' && !editor.endsAtLocal ? 'scheduled.chooseCutoff' : 'scheduled.chooseFuture')
          : previewError || t(preview ? 'scheduled.chooseFuture' : 'scheduled.previewing')}</div>
    </section>

  </div>;

  const renderTimePicker = () => editor && <div className="scheduled-dropdown">
    {editor.frequency === 'weekly' && <section className="settings-page-group"><div className="settings-page-list">
      {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
        const selected = editor.slots.some((slot) => slot.weekday === weekday);
        return <div className="settings-page-row scheduled-weekday-row" key={weekday}>
          <button type="button" className="scheduled-weekday-choice" aria-pressed={selected} onClick={() => change({
            slots: selected ? editor.slots.filter((slot) => slot.weekday !== weekday)
              : [...editor.slots, { weekday, time: scheduledOnceDefault(snapshot!.serverNow, zone!)[0]!.time! }],
          })}><span className="settings-choice-check" aria-hidden="true">{selected && <CheckIcon />}</span>{t(`scheduled.day.${weekday}`)}</button>
          {editor.slots.map((slot, index) => slot.weekday === weekday && <input key={index} className="scheduled-picker-input" type="time" aria-label={`${t(`scheduled.day.${weekday}`)} ${t('scheduled.time')}`} value={slot.time ?? ''}
            onChange={event => change({ slots: editor.slots.map((value, i) => i === index ? { ...value, time: event.target.value } : value) })} />)}
        </div>;
      })}
    </div></section>}
    {editor.frequency !== 'weekly' && editor.slots.map((slot, index) => <section className="settings-page-group" key={index}>
      <div className="settings-page-list">
        {editor.frequency === 'once' && <label className="settings-page-row">
          <span className="settings-page-row-label">{t('scheduled.date')}</span>
          <CalendarInput type="date" label={t('scheduled.date')} value={slot.date ?? ''}
            onChange={date => change({ slots: editor.slots.map((value, i) => i === index ? { ...value, date } : value) })} />
        </label>}
        <label className="settings-page-row">
          <span className="settings-page-row-label">{t(editor.frequency === 'hourly' ? 'scheduled.minute' : 'scheduled.time')}</span>
          {editor.frequency === 'hourly' ? <input className="scheduled-picker-input" type="number" min="0" max="59"
            aria-label={t('scheduled.minute')} value={slot.minute ?? 0} onChange={(event) => change({ slots: editor.slots.map((value, i) => i === index ? { minute: Number(event.target.value) } : value) })} />
            : <input className="scheduled-picker-input" type="time" aria-label={t('scheduled.time')} value={slot.time ?? ''}
              onChange={event => change({ slots: editor.slots.map((value, i) => i === index ? { ...value, time: event.target.value } : value) })} />}
        </label>
      </div>
    </section>)}
  </div>;

  const renderDetail = () => detail && <div className="settings-page-content scheduled-page-content">
    <section className="settings-page-group"><h2>{t('scheduled.message')}</h2>
      <div className="settings-page-list scheduled-detail-text">{detail.item.text}</div>
    </section>
    <section className="settings-page-group"><div className="settings-page-list">
      <ValueRow label={t('scheduled.status')}><StatusBadge selection={detail} /></ValueRow>
      {detail.kind === 'task' ? <>
        <ValueRow label={t('scheduled.repeat')}>{t(`scheduled.${detail.item.rule.frequency}`)}</ValueRow>
        <ValueRow label={t(detail.item.state === 'ended' ? 'scheduled.finished' : 'scheduled.next')}>
          {dateTime(detail.item.state === 'ended' ? detail.item.endedAt : detail.item.nextAt, detail.item.timeZone)}</ValueRow>
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
          {page === 'list' && <button type="button" className="scheduled-head-action" aria-label={t('scheduled.add')} disabled={!run || !snapshot} onClick={() => edit()}><PlusIcon /></button>}
          {page === 'editor' && <button type="button" className="scheduled-head-action" disabled={saving || !preview?.nextAt || !complete || !editor?.text.trim()} onClick={save}>{t('scheduled.save')}</button>}
          {page === 'detail' && detail && <button type="button" className="scheduled-head-action" onClick={() => openMenu(detail)} aria-label={t('scheduled.more')}><MoreHorizontalIcon /></button>}
          <button type="button" className="cmd-close scheduled-close" aria-label={t('common.close')} onClick={close}><XIcon /></button>
        </div>
        {snapshot && <p className="scheduled-subtitle">{t('scheduled.serverTime')}: {dateTime(snapshot.serverNow, snapshot.timeZone)}</p>}
      </header>
      {(error || source.error) && <div className="scheduled-error" role="alert">{error || source.error}</div>}
      <div className="tool-sheet-body scheduled-body">
      {page === 'list' ? renderList() : <div className="scheduled-page">
        {page === 'editor' && renderEditor()}
        {page === 'detail' && renderDetail()}
      </div>}
      {page !== 'list' && snapshot && (page === 'detail' ? detail?.item.timeZone : zone) !== snapshot.timeZone &&
        <p className="settings-page-footer scheduled-zone-hint">{t('scheduled.taskTimeZone', { zone: page === 'detail' ? detail?.item.timeZone : zone })}</p>}
      </div>
    </section>
    {menu && <div className="scheduled-overlay-layer"><ActionSheet open title={t('scheduled.actions')} actions={menuActions} onClose={closeMenu} /></div>}
    {confirm && <div className="settings-confirm-backdrop scheduled-confirm-layer" onClick={dismissConfirm}>
      <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-label={confirm.message}
        onClick={(event) => event.stopPropagation()}><p>{confirm.message}</p><div className="settings-confirm-actions">
          <button type="button" onClick={dismissConfirm}>{t('scheduled.cancel')}</button>
          <button type="button" className="danger" onClick={() => { const action = confirm.action; dismissConfirm(); action(); }}>{confirm.label ?? t('scheduled.confirm')}</button>
        </div></div>
    </div>}
  </>;
}
