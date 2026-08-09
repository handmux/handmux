import { useState } from 'react';
import { InboxIcon, AgentMark } from './icons.jsx';
import { VIEW_LABEL, relTime, viewCounts } from '../inbox.js';
import { t } from '../i18n';
import type { InboxRow, InboxView } from '../inbox.js';
import type { ClaudeHooksStatus } from '../hooks/useServerConfig.js';

interface InboxGroup {
  session: string;
  items: InboxRow[];
}

interface InboxProps {
  rows: InboxRow[];
  top: InboxView | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelectRow: (row: InboxRow) => void;
  onMarkAllRead: () => void;
  hooksStatus: ClaudeHooksStatus | null;
  onEnableHooks?: (() => Promise<unknown>) | null;
}

// Top-bar inbox: tray icon + a single priority dot (orange needs > green done > blue working) that
// gives an at-a-glance signal even when nothing "needs you". Opens a dropdown roster of every Claude
// pane (grouped by session) and its current view. Presentational — rows are pre-sorted by inboxRows;
// taps bubble out via the callbacks. 清除已完成 advances the device read-ts high-water mark — it drops
// only the present done rows (working/needs are never history-filtered), so it's shown ONLY when there
// is at least one done row to clear.
export default function Inbox({
  rows, top, open, onToggle, onClose, onSelectRow, onMarkAllRead, hooksStatus, onEnableHooks,
}: InboxProps) {
  const groups: InboxGroup[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.session === r.session) last.items.push(r);
    else groups.push({ session: r.session, items: [r] });
  }
  const now = Date.now();
  const hasDone = rows.some((r) => r.view === 'done');
  const counts = viewCounts(rows);

  const [enabling, setEnabling] = useState(false);
  const [enableErr, setEnableErr] = useState(false);
  const showEnable = groups.length === 0 && hooksStatus === 'absent';
  const doEnable = async (): Promise<void> => {
    setEnabling(true); setEnableErr(false);
    try {
      const result = await onEnableHooks?.();
      const status = result !== null && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).status : null;
      if (status !== 'installed') setEnableErr(true);
    }
    catch { setEnableErr(true); }
    finally { setEnabling(false); }
  };

  return (
    <>
      <button className="topbar-icon inbox-btn" onClick={onToggle} aria-label={t('inbox.title')} title={t('inbox.title')}>
        <InboxIcon />
        {top && <span className={`inbox-dot ${top}`} aria-hidden="true" />}
      </button>
      {open && (
        <>
          <div className="inbox-backdrop" onClick={onClose} />
          <div className="inbox-panel" role="dialog" aria-label={t('inbox.title')}>
            <div className="inbox-head">
              <span>{t('inbox.title')}</span>
              {/* 进行中/已完成/需要你 tally, top-right of the panel, in line with the 收件箱 title. */}
              <div className="inbox-summary">
                <span className="inbox-chip working">{t('inbox.working')} {counts.working}</span>
                <span className="inbox-chip done">{t('inbox.done')} {counts.done}</span>
                <span className="inbox-chip needs">{t('inbox.needs')} {counts.needs}</span>
              </div>
              {hasDone && <button className="inbox-readall" onClick={onMarkAllRead}>{t('inbox.clearDone')}</button>}
            </div>
            {groups.length === 0 ? (
              showEnable ? (
                <div className="inbox-empty inbox-enable">
                  <div className="inbox-enable-title">{t('inbox.enableTitle')}</div>
                  <div className="inbox-enable-hint">{t('inbox.enableHint')}</div>
                  <button className="inbox-enable-btn" onClick={() => void doEnable()} disabled={enabling}>
                    {enabling ? t('inbox.enabling') : t('inbox.enableBtn')}
                  </button>
                  {enableErr && <div className="inbox-enable-err">{t('inbox.enableFailed')}</div>}
                </div>
              ) : (
                <div className="inbox-empty">{t('inbox.empty')}</div>
              )
            ) : groups.map((g) => (
              <div key={g.session} className="inbox-group">
                <div className="inbox-group-title">{g.session}</div>
                {g.items.map((r) => (
                  <button key={r.pane} className="inbox-row" onClick={() => onSelectRow(r)}>
                    <div className="inbox-row-head">
                      <span className={`inbox-chip ${r.view}`}>{VIEW_LABEL[r.view]}</span>
                      <AgentMark agent={r.agent} />
                      <span className="inbox-loc">{r.windowName || r.window}</span>
                      <span className="inbox-time">{relTime(r.ts, now)}</span>
                    </div>
                    {r.msg && <div className="inbox-msg">{r.msg}</div>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
