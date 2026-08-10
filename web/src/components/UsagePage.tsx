import { useEffect, useState } from 'react';
import { getUsage, UnauthorizedError } from '../api.js';
import { AgentMark } from './icons.jsx';
import { t } from '../i18n';

interface UsageWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowMinutes?: number | null;
}

interface ClaudeRateLimits {
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
  sevenDayOpus?: UsageWindow | null;
  sevenDaySonnet?: UsageWindow | null;
}

interface CodexRateLimits {
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
}

interface ClaudeUsage {
  updatedAt?: number | null;
  rateLimits: ClaudeRateLimits;
}

interface CodexUsage {
  updatedAt?: number | null;
  rateLimits: CodexRateLimits;
}

export interface UsageSnapshot {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const usageWindowOf = (value: unknown): UsageWindow | null => {
  const window = recordOf(value);
  const usedPercent = finiteNumber(window?.usedPercent);
  if (!window || usedPercent == null) return null;
  const resetsAt = finiteNumber(window.resetsAt);
  const windowMinutes = finiteNumber(window.windowMinutes);
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowMinutes != null ? { windowMinutes } : {}),
  };
};

const updatedAtOf = (value: Record<string, unknown>): number | undefined => {
  const updatedAt = finiteNumber(value.updatedAt);
  return updatedAt == null ? undefined : updatedAt;
};

const claudeUsageOf = (value: unknown): ClaudeUsage | null => {
  const usage = recordOf(value);
  if (!usage) return null;
  const limits = recordOf(usage.rateLimits) || {};
  const updatedAt = updatedAtOf(usage);
  return {
    rateLimits: {
      fiveHour: usageWindowOf(limits.fiveHour),
      sevenDay: usageWindowOf(limits.sevenDay),
      sevenDayOpus: usageWindowOf(limits.sevenDayOpus),
      sevenDaySonnet: usageWindowOf(limits.sevenDaySonnet),
    },
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
};

const codexUsageOf = (value: unknown): CodexUsage | null => {
  const usage = recordOf(value);
  if (!usage) return null;
  const limits = recordOf(usage.rateLimits) || {};
  const updatedAt = updatedAtOf(usage);
  return {
    rateLimits: {
      primary: usageWindowOf(limits.primary),
      secondary: usageWindowOf(limits.secondary),
    },
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
};

export function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
  const snapshot = recordOf(value);
  return snapshot ? {
    claude: claudeUsageOf(snapshot.claude),
    codex: codexUsageOf(snapshot.codex),
  } : null;
}

// Usage page: per-agent quota/limit windows, read from disk by the server (no credentials). Codex comes
// from its rollout's rate_limits (zero-config); Claude's 5h/weekly % come from the statusLine capturer
// (opt-in) — when it isn't wired, or hasn't seen an API response yet, we show a short how-to instead of a
// fake gauge. Poll-free: fetched on open (the numbers move on the hour scale, so a manual refresh is enough).

// A rate-limit window's human label. Codex reports window_minutes; Claude's are named (5h / weekly).
function winLabel(minutes: number | null | undefined): string {
  if (minutes === 300) return t('usage.win5h');
  if (minutes === 10080) return t('usage.winWeekly');
  if (minutes === 43200) return t('usage.winMonthly');
  if (minutes != null && minutes > 0) return t('usage.winGeneric', { h: Math.round(minutes / 60) });
  return '';
}

function fmtReset(resetsAt: number | null | undefined, nowMs: number): string {
  if (!resetsAt) return '';
  const s = resetsAt - Math.floor(nowMs / 1000);
  if (s <= 0) return t('usage.resetSoon');
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return t('usage.resetIn', { t: span });
}

// The snapshot is only as fresh as the last time the agent was active (Claude's statusLine fires on each
// API response; Codex's token_count on each turn). Surface that so a stale number isn't mistaken for live.
function Updated({ at, now }: { at?: number | null; now: number }) {
  if (!at) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const line = s < 60 ? t('usage.updatedNow')
    : s < 3600 ? t('usage.updatedMin', { n: Math.floor(s / 60) })
    : s < 86400 ? t('usage.updatedHr', { n: Math.floor(s / 3600) })
    : t('usage.updatedDay', { n: Math.floor(s / 86400) });
  return <div className="usage-updated">{line}</div>;
}

// How far the current reset window has elapsed (0–100), so the bar can mark where "on-pace" is: usage left
// of the line = burning slower than time, right of it = faster. Needs both the window length and its reset.
function timeElapsedPct(
  resetsAt: number | null | undefined,
  windowMinutes: number | null | undefined,
  nowMs: number,
): number | null {
  if (!resetsAt || !windowMinutes) return null;
  const remain = resetsAt - Math.floor(nowMs / 1000);
  return Math.max(0, Math.min(100, (1 - remain / (windowMinutes * 60)) * 100));
}

function Bar({ pct, timePct }: { pct: number; timePct?: number | null }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const lvl = p >= 80 ? 'hi' : p >= 50 ? 'mid' : 'lo';
  return (
    <div className="usage-bar">
      <div className={`usage-bar-fill lvl-${lvl}`} style={{ width: `${p}%` }} />
      {timePct != null && <div className="usage-bar-time" style={{ left: `${timePct}%` }} title={t('usage.timeMark')} />}
    </div>
  );
}

function LimitRow({ label, pct, reset, sub, timePct }: {
  label: string;
  pct: number;
  reset?: string;
  sub?: string;
  timePct?: number | null;
}) {
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-label">{label}{sub && <span className="usage-row-sub"> · {sub}</span>}</span>
        <span className="usage-row-pct">{Math.round(pct)}%</span>
      </div>
      <Bar pct={pct} timePct={timePct ?? null} />
      {reset && <div className="usage-row-reset">{reset}</div>}
    </div>
  );
}

function ClaudeCard({ claude, now }: { claude: ClaudeUsage | null; now: number }) {
  return (
    <section className="usage-agent">
      <div className="usage-agent-head"><AgentMark agent="claude" /><span>Claude Code</span><Updated at={claude?.updatedAt ?? null} now={now} /></div>
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
              reset={fmtReset(claude.rateLimits.fiveHour.resetsAt, now)}
              timePct={timeElapsedPct(claude.rateLimits.fiveHour.resetsAt, 300, now)} />
          )}
          {claude.rateLimits.sevenDay && (
            <LimitRow label={t('usage.winWeekly')} pct={claude.rateLimits.sevenDay.usedPercent}
              reset={fmtReset(claude.rateLimits.sevenDay.resetsAt, now)}
              timePct={timeElapsedPct(claude.rateLimits.sevenDay.resetsAt, 10080, now)} />
          )}
          {claude.rateLimits.sevenDayOpus && (
            <LimitRow label={t('usage.winWeekly')} sub="Opus" pct={claude.rateLimits.sevenDayOpus.usedPercent}
              timePct={timeElapsedPct(claude.rateLimits.sevenDayOpus.resetsAt, 10080, now)} />
          )}
          {claude.rateLimits.sevenDaySonnet && (
            <LimitRow label={t('usage.winWeekly')} sub="Sonnet" pct={claude.rateLimits.sevenDaySonnet.usedPercent}
              timePct={timeElapsedPct(claude.rateLimits.sevenDaySonnet.resetsAt, 10080, now)} />
          )}
        </>
      )}
    </section>
  );
}

function CodexCard({ codex, now }: { codex: CodexUsage | null; now: number }) {
  const rl = codex?.rateLimits;
  return (
    <section className="usage-agent">
      <div className="usage-agent-head"><AgentMark agent="codex" /><span>Codex CLI</span><Updated at={codex?.updatedAt ?? null} now={now} /></div>
      {!codex ? (
        <div className="usage-empty">{t('usage.codexOff')}</div>
      ) : (
        <>
          {rl?.primary && (
            <LimitRow label={winLabel(rl.primary.windowMinutes) || t('usage.winPrimary')}
              pct={rl.primary.usedPercent} reset={fmtReset(rl.primary.resetsAt, now)}
              timePct={timeElapsedPct(rl.primary.resetsAt, rl.primary.windowMinutes, now)} />
          )}
          {rl?.secondary && (
            <LimitRow label={winLabel(rl.secondary.windowMinutes) || t('usage.winSecondary')}
              pct={rl.secondary.usedPercent} reset={fmtReset(rl.secondary.resetsAt, now)}
              timePct={timeElapsedPct(rl.secondary.resetsAt, rl.secondary.windowMinutes, now)} />
          )}
          {!rl?.primary && !rl?.secondary && <div className="usage-empty">{t('usage.codexNoQuota')}</div>}
        </>
      )}
    </section>
  );
}

export default function UsagePage({ open, onClose, onAuthFail }: {
  open: boolean;
  onClose: () => void;
  onAuthFail?: () => void;
}) {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const now = Date.now();

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true); setError('');
    getUsage()
      .then((value: unknown) => {
        if (cancelled) return;
        const snapshot = parseUsageSnapshot(value);
        if (snapshot) setData(snapshot);
        else setError(t('usage.loadFailed'));
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) onAuthFail?.();
        else setError(t('usage.loadFailed'));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, onAuthFail]);

  if (!open) return null;

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card usage-card" role="dialog" aria-label={t('usage.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('usage.title')}</span>
          <span className="usage-head-note">{t('usage.activityNote')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          {loading && !data ? (
            <div className="usage-empty">{t('common.loading')}</div>
          ) : error ? (
            <div className="bind-error">{error}</div>
          ) : data ? (
            <>
              <CodexCard codex={data.codex} now={now} />
              <ClaudeCard claude={data.claude} now={now} />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
