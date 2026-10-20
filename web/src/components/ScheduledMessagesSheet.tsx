import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRunRef } from '../agentCatalog.js';
import { scheduledRequest } from '../scheduledMessagesApi.js';
import type { ScheduledException, ScheduledRule, ScheduledSnapshot, ScheduledTask } from '../scheduledMessagesApi.js';
import { useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { t } from '../i18n';
import './scheduledMessages.css';

type Editor = { task?: ScheduledTask; exception?: ScheduledException; text: string; frequency: ScheduledRule['frequency']; slots: ScheduledRule['slots']; endsAtLocal: string };
function localInput(at: number, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export default function ScheduledMessagesSheet({ tmuxSession, run, onClose }: { tmuxSession: string; run: AgentRunRef | null; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ScheduledSnapshot | null>(null);
  const [tab, setTab] = useState<'active' | 'ended' | 'exceptions'>('active');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<null | { message: string; action: () => void }>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [preview, setPreview] = useState<{ nextAt: number | null; timeZone: string } | null>(null);
  const mounted = useRef(true);
  const runRef = useRef(run); runRef.current = run;
  const request = <T,>(action: string, fields: Record<string, unknown> = {}) => scheduledRequest<T>(tmuxSession, runRef.current, action, fields);
  const reload = async () => { const result = await request<ScheduledSnapshot>('snapshot'); if (mounted.current) setSnapshot(result); };
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await reload(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('scheduled.loadFailed')); } finally { if (mounted.current) timer = setTimeout(() => { void poll(); }, 3000); } };
    void poll(); return () => { mounted.current = false; clearTimeout(timer); };
  }, [tmuxSession]);
  const historyDepth = useRef(0);
  const pendingHistoryDrop = useRef(0);
  const queueUnwind = (depth: number) => {
    if (depth <= 0) return;
    pendingHistoryDrop.current += depth;
    if (pendingHistoryDrop.current !== depth) return;
    // Confirmation + editor can close in one React event. One go(-N) preserves the exact owned depth.
    queueMicrotask(() => { const count = pendingHistoryDrop.current; pendingHistoryDrop.current = 0; unwindHistory(count); });
  };
  const pushLevel = () => { window.history.pushState({ scheduledMessages: true, depth: historyDepth.current + 1 }, ''); historyDepth.current++; };
  const dropLevel = () => { if (historyDepth.current > 0) { historyDepth.current--; queueUnwind(1); } };
  const showConfirm = (value: { message: string; action: () => void }) => { pushLevel(); setConfirm(value); };
  const leave = (action: () => void) => { if (dirty) showConfirm({ message: t('scheduled.discardChanges'), action }); else action(); };
  const leaveEditor = () => { dropLevel(); setEditor(null); setDirty(false); setError(''); };
  const back = () => leave(leaveEditor);
  const close = () => leave(onClose);
  const dismissConfirm = () => { dropLevel(); setConfirm(null); };
  useHistoryLayer(true, () => {
    historyDepth.current = Math.max(0, historyDepth.current - 1);
    if (confirm) { setConfirm(null); return; }
    if (editor) {
      if (dirty) {
        // Restore the consumed editor level so cancelling the confirmation retains Back ownership.
        pushLevel(); showConfirm({ message: t('scheduled.discardChanges'), action: leaveEditor });
      } else { setEditor(null); setDirty(false); setError(''); }
    } else onClose();
  });
  useEffect(() => { pushLevel(); return () => { queueUnwind(historyDepth.current); historyDepth.current = 0; }; }, []);
  const rule = useMemo(() => editor ? { frequency: editor.frequency, slots: editor.slots, ...(editor.frequency === 'once' ? {} : { endsAtLocal: editor.endsAtLocal }) } : null, [editor]);
  useEffect(() => {
    setPreview(null); setPreviewError(''); if (!rule) return;
    let valid = true;
    const timer = setTimeout(() => { void request<{ nextAt: number | null; timeZone: string }>('preview', { request: rule, ...(editor?.task ? { timeZone: editor.task.timeZone } : editor?.exception ? { timeZone: editor.exception.timeZone } : {}) }).then((result) => { if (valid) setPreview(result); }).catch((cause) => { if (valid) setPreviewError(cause instanceof Error ? cause.message : t('scheduled.chooseFuture')); }); }, 200);
    return () => { valid = false; clearTimeout(timer); };
  }, [rule]);
  const dateTime = (at: number | undefined | null, zone = snapshot?.timeZone) => at == null ? '—' : new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
  const resultText = (reason: string) => { const key = `scheduled.result.${reason}`; const value = t(key); return value === key ? t('scheduled.result.failed') : value; };
  const edit = (task?: ScheduledTask, exception?: ScheduledException) => {
    pushLevel();
    setEditor({ ...(task ? { task } : {}), ...(exception ? { exception } : {}), text: task?.text ?? exception?.text ?? '', frequency: task?.rule.frequency ?? 'once', slots: structuredClone(task?.rule.slots ?? [{ date: '', time: '09:00' }]), endsAtLocal: task?.rule.endsAt ? localInput(Date.parse(task.rule.endsAt), task.timeZone) : '' });
    setDirty(false); setError('');
  };
  const change = (update: Partial<Editor>) => { setEditor((current) => current ? { ...current, ...update } : current); setDirty(true); };
  const mutate = async (action: string, fields: Record<string, unknown>, after?: () => void) => {
    if (saving) return; setSaving(true); setError('');
    try { await request(action, fields); await reload(); after?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('scheduled.loadFailed')); void reload().catch(() => {}); }
    finally { if (mounted.current) setSaving(false); }
  };
  const save = () => {
    if (!editor || !rule || !preview?.nextAt || !editor.text.trim()) return;
    const done = leaveEditor;
    if (editor.exception) void mutate('exception', { id: editor.exception.id, revision: editor.exception.revision, request: { action: 'reschedule', rule } }, done);
    else if (editor.task) void mutate('update', { id: editor.task.id, revision: editor.task.revision, request: { ...rule, text: editor.text } }, done);
    else void mutate('create', { request: { ...rule, text: editor.text } }, done);
  };
  const remove = (task: ScheduledTask) => showConfirm({ message: t('scheduled.deleteConfirm'), action: () => { void mutate('delete', { id: task.id, revision: task.revision }); } });
  const zone = editor?.task?.timeZone ?? editor?.exception?.timeZone ?? snapshot?.timeZone;
  const slotFields = editor?.slots.map((slot, index) => <div className="scheduled-slot" key={index}>
    {editor.frequency === 'once' && <label>{t('scheduled.date')}<input type="date" aria-label={t('scheduled.date')} value={slot.date ?? ''} onChange={(event) => change({ slots: editor.slots.map((value, i) => i === index ? { ...value, date: event.target.value } : value) })} /></label>}
    {editor.frequency === 'weekly' && <span>{t(`scheduled.day.${slot.weekday}`)}</span>}
    {editor.frequency === 'hourly' ? <label>{t('scheduled.minute')}<input type="number" min="0" max="59" aria-label={t('scheduled.minute')} value={slot.minute ?? 0} onChange={(event) => change({ slots: editor.slots.map((value, i) => i === index ? { minute: Number(event.target.value) } : value) })} /></label>
      : <label>{t('scheduled.time')}<input type="time" aria-label={t('scheduled.time')} value={slot.time ?? ''} onChange={(event) => change({ slots: editor.slots.map((value, i) => i === index ? { ...value, time: event.target.value } : value) })} /></label>}
  </div>);
  return <>
    <div className="cmd-backdrop" onClick={close} />
    <section className="cmd-panel cmd-editor scheduled-sheet" role="dialog" aria-modal="true" aria-label={t('scheduled.title')}>
      <header className="cmd-head">
        {editor && <button type="button" className="fontbtn" onClick={back}>{t('scheduled.back')}</button>}
        <span className="cmd-title">{editor ? t(editor.task ? 'scheduled.edit' : editor.exception ? 'scheduled.reschedule' : 'scheduled.add') : t('scheduled.title')}</span>
        {!editor && <button type="button" className="fontbtn" disabled={!run} onClick={() => edit()}>{t('scheduled.add')}</button>}
        <button type="button" className="fontbtn" onClick={close} aria-label={t('common.close')}>×</button>
      </header>
      <div className="cmd-list scheduled-content">
        {snapshot && <p className="scheduled-secondary">{t('scheduled.serverTime')}: {dateTime(snapshot.serverNow)} · {snapshot.timeZone}</p>}
        {error && <p role="alert" className="scheduled-error">{error}</p>}
        {editor ? <>
          <p className="scheduled-secondary">{t('scheduled.target')}: {tmuxSession} / {editor.task?.target.paneId ?? editor.exception?.target.paneId ?? run?.paneId} · {editor.task?.target.sessionId ?? editor.exception?.target.sessionId ?? run?.sessionId} · {zone}</p>
          <label>{t('scheduled.message')}<textarea aria-label={t('scheduled.message')} value={editor.text} disabled={!!editor.exception} onChange={(event) => change({ text: event.target.value })} rows={4} /></label>
          {!editor.exception && <div className="scheduled-segments">{(['once', 'hourly', 'daily', 'weekly'] as const).map((frequency) => <button type="button" className="fontbtn" key={frequency} aria-pressed={editor.frequency === frequency} onClick={() => { if (editor.frequency !== frequency) change({ frequency, slots: frequency === 'hourly' ? [{ minute: 0 }] : frequency === 'weekly' ? [{ weekday: 1, time: '09:00' }] : frequency === 'once' ? [{ date: '', time: '09:00' }] : [{ time: '09:00' }] }); }}>{t(`scheduled.${frequency}`)}</button>)}</div>}
          {editor.frequency === 'weekly' && <div className="scheduled-segments">{[1, 2, 3, 4, 5, 6, 7].map((weekday) => <button type="button" className="fontbtn" key={weekday} aria-pressed={editor.slots.some((slot) => slot.weekday === weekday)} onClick={() => change({ slots: editor.slots.some((slot) => slot.weekday === weekday) ? editor.slots.filter((slot) => slot.weekday !== weekday) : [...editor.slots, { weekday, time: '09:00' }] })}>{t(`scheduled.day.${weekday}`)}</button>)}</div>}
          {slotFields}
          {editor.frequency !== 'once' && <label>{t('scheduled.cutoff')}<input type="datetime-local" aria-label={t('scheduled.cutoff')} required value={editor.endsAtLocal} onChange={(event) => change({ endsAtLocal: event.target.value })} /></label>}
          <p role="status" className="scheduled-secondary">{t('scheduled.next')}: {preview?.nextAt ? dateTime(preview.nextAt, zone) : previewError || t('scheduled.chooseFuture')}</p>
          <button type="button" className="cmd-submit" disabled={saving || !preview?.nextAt || !editor.text.trim()} onClick={save}>{t('scheduled.save')}</button>
        </> : <>
          <div className="scheduled-segments" role="tablist">{(['active', 'ended', 'exceptions'] as const).map((value) => <button type="button" role="tab" aria-selected={tab === value} className="fontbtn" key={value} onClick={() => setTab(value)}>{t(`scheduled.${value}`)}</button>)}</div>
          {tab === 'exceptions' ? snapshot?.exceptions.length ? snapshot.exceptions.map((item) => <article className="scheduled-item" key={item.id}>
            <p className="scheduled-message">{item.text}</p><p>{resultText(item.reason)}{item.count ? ` ×${item.count}` : ''}</p>
            <p className="scheduled-secondary">{dateTime(item.scheduledAt, item.timeZone)}{item.missedThroughAt ? ` – ${dateTime(item.missedThroughAt, item.timeZone)}` : ''} · {item.timeZone} · {item.target.tmuxSession} / {item.target.paneId} · {item.target.sessionId}</p>
            {item.unknown && <p>{t('scheduled.unknownHelp')}</p>}
            <div className="scheduled-actions"><button type="button" className="fontbtn" disabled={item.unknown || saving} onClick={() => edit(undefined, item)}>{t('scheduled.reschedule')}</button><button type="button" className="fontbtn" disabled={saving} onClick={() => showConfirm({ message: t('scheduled.discardException'), action: () => { void mutate('exception', { id: item.id, revision: item.revision, request: { action: 'discard' } }); } })}>{t('scheduled.discard')}</button></div>
          </article>) : <p className="scheduled-secondary">{t('scheduled.empty')}</p>
          : snapshot?.tasks.filter((task) => task.state === tab).length ? snapshot.tasks.filter((task) => task.state === tab).map((task) => <article className="scheduled-item" key={task.id}>
            <button type="button" className={`scheduled-message scheduled-open ${task.state === 'ended' ? 'scheduled-secondary' : ''}`} disabled={task.state === 'ended'} onClick={() => edit(task)}>{task.text}</button>
            <p className="scheduled-secondary">{task.target.tmuxSession} / {task.target.paneId} · {task.target.sessionId} · {task.timeZone} · {t(`scheduled.${task.rule.frequency}`)} · {t(task.enabled && !task.blocked ? 'scheduled.enabled' : 'scheduled.paused')}</p>
            <p>{t(task.state === 'ended' ? 'scheduled.finished' : 'scheduled.next')}: {dateTime(task.state === 'ended' ? task.endedAt : task.nextAt, task.timeZone)}</p>
            {task.state === 'active' && task.rule.endsAt && <p className="scheduled-secondary">{t('scheduled.cutoff')}: {dateTime(Date.parse(task.rule.endsAt), task.timeZone)}</p>}
            {task.lastResult && <p>{dateTime(task.lastAt, task.timeZone)} · {resultText(task.lastResult)}</p>}
            <div className="scheduled-actions">{task.state === 'active' && <button type="button" className="fontbtn" disabled={saving || task.blocked} onClick={() => { void mutate('update', { id: task.id, revision: task.revision, request: { enabled: !task.enabled } }); }}>{t(task.enabled ? 'scheduled.pause' : 'scheduled.resume')}</button>}<button type="button" className="fontbtn" disabled={saving} onClick={() => remove(task)}>{t('scheduled.delete')}</button></div>
          </article>) : <p className="scheduled-secondary">{t('scheduled.empty')}</p>}
        </>}
      </div>
      {confirm && <div className="scheduled-confirm" role="alertdialog" aria-modal="true"><p>{confirm.message}</p><button type="button" className="fontbtn" onClick={dismissConfirm}>{t('scheduled.cancel')}</button><button type="button" className="fontbtn" onClick={() => { const action = confirm.action; dismissConfirm(); action(); }}>{t('scheduled.confirm')}</button></div>}
    </section>
  </>;
}
