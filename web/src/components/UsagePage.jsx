import { useEffect, useState } from 'react';
import { getUsage, UnauthorizedError } from '../api.js';
import { AgentMark } from './icons.jsx';
import { t } from '../i18n';

// Usage page: per-agent quota/limit windows, read from disk by the server (no credentials). Codex comes
// from its rollout's rate_limits (zero-config); Claude's 5h/weekly % come from the statusLine capturer
// (opt-in) — when it isn't wired, or hasn't seen an API response yet, we show a short how-to instead of a
// fake gauge. Poll-free: fetched on open (the numbers move on the hour scale, so a manual refresh is enough).

// A rate-limit window's human label. Codex reports window_minutes; Claude's are named (5h / weekly).
function winLabel(minutes) {
  if (minutes === 300) return t('usage.win5h');
  if (minutes === 10080) return t('usage.winWeekly');
  if (minutes === 43200) return t('usage.winMonthly');
  if (minutes > 0) return t('usage.winGeneric', { h: Math.round(minutes / 60) });
  return '';
}

function fmtReset(resetsAt, nowMs) {
  if (!resetsAt) return '';
  const s = resetsAt - Math.floor(nowMs / 1000);
  if (s <= 0) return t('usage.resetSoon');
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return t('usage.resetIn', { t: span });
}

// The snapshot is only as fresh as the last time the agent was active (Claude's statusLine fires on each
// API response; Codex's token_count on each turn). Surface that so a stale number isn't mistaken for live.
function Updated({ at, now }) {
  if (!at) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const line = s < 60 ? t('usage.updatedNow')
    : s < 3600 ? t('usage.updatedMin', { n: Math.floor(s / 60) })
    : s < 86400 ? t('usage.updatedHr', { n: Math.floor(s / 3600) })
    : t('usage.updatedDay', { n: Math.floor(s / 86400) });
  return <div className="usage-updated">{line}</div>;
}

function Bar({ pct }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const lvl = p >= 80 ? 'hi' : p >= 50 ? 'mid' : 'lo';
  return <div className="usage-bar"><div className={`usage-bar-fill lvl-${lvl}`} style={{ width: `${p}%` }} /></div>;
}

function LimitRow({ label, pct, reset, sub }) {
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-label">{label}{sub && <span className="usage-row-sub"> · {sub}</span>}</span>
        <span className="usage-row-pct">{Math.round(pct)}%</span>
      </div>
      <Bar pct={pct} />
      {reset && <div className="usage-row-reset">{reset}</div>}
    </div>
  );
}

function ClaudeCard({ claude, now }) {
  return (
    <section className="usage-agent">
      <div className="usage-agent-head"><AgentMark agent="claude" /><span>Claude Code</span></div>
      {!claude ? (
        <div className="usage-empty">
          <div>{t('usage.claudeOff')}</div>
          <code className="usage-code">handmux hooks install</code>
        </div>
      ) : (!claude.rateLimits?.fiveHour && !claude.rateLimits?.sevenDay) ? (
        <div className="usage-empty">{t('usage.claudePending')}</div>
      ) : (
        <>
          {claude.rateLimits.fiveHour && (
            <LimitRow label={t('usage.win5h')} pct={claude.rateLimits.fiveHour.usedPercent}
              reset={fmtReset(claude.rateLimits.fiveHour.resetsAt, now)} />
          )}
          {claude.rateLimits.sevenDay && (
            <LimitRow label={t('usage.winWeekly')} pct={claude.rateLimits.sevenDay.usedPercent}
              reset={fmtReset(claude.rateLimits.sevenDay.resetsAt, now)} />
          )}
          {claude.rateLimits.sevenDayOpus && (
            <LimitRow label={t('usage.winWeekly')} sub="Opus" pct={claude.rateLimits.sevenDayOpus.usedPercent} />
          )}
          {claude.rateLimits.sevenDaySonnet && (
            <LimitRow label={t('usage.winWeekly')} sub="Sonnet" pct={claude.rateLimits.sevenDaySonnet.usedPercent} />
          )}
          <Updated at={claude.updatedAt} now={now} />
        </>
      )}
    </section>
  );
}

function CodexCard({ codex, now }) {
  const rl = codex?.rateLimits;
  return (
    <section className="usage-agent">
      <div className="usage-agent-head"><AgentMark agent="codex" /><span>Codex CLI</span></div>
      {!codex ? (
        <div className="usage-empty">{t('usage.codexOff')}</div>
      ) : (
        <>
          {rl?.primary && (
            <LimitRow label={winLabel(rl.primary.windowMinutes) || t('usage.winPrimary')}
              pct={rl.primary.usedPercent} reset={fmtReset(rl.primary.resetsAt, now)} />
          )}
          {rl?.secondary && (
            <LimitRow label={winLabel(rl.secondary.windowMinutes) || t('usage.winSecondary')}
              pct={rl.secondary.usedPercent} reset={fmtReset(rl.secondary.resetsAt, now)} />
          )}
          {!rl?.primary && !rl?.secondary && <div className="usage-empty">{t('usage.codexNoQuota')}</div>}
          <Updated at={codex.updatedAt} now={now} />
        </>
      )}
    </section>
  );
}

export default function UsagePage({ open, onClose, onAuthFail }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const now = Date.now();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError('');
    getUsage()
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof UnauthorizedError) onAuthFail?.();
        else setError(t('usage.loadFailed'));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card usage-card" role="dialog" aria-label={t('usage.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('usage.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          {loading && !data ? (
            <div className="usage-empty">{t('common.loading')}</div>
          ) : error ? (
            <div className="bind-error">{error}</div>
          ) : data ? (
            <>
              {data.codex && <CodexCard codex={data.codex} now={now} />}
              <ClaudeCard claude={data.claude} now={now} />
            </>
          ) : null}
          {data && (data.claude || data.codex) && <div className="usage-note">{t('usage.activityNote')}</div>}
        </div>
      </div>
    </>
  );
}
