import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError, createApiAccount, deleteApiAccount, getAgentUsage, getApiAccounts,
  patchApiAccount, queryApiAccount, UnauthorizedError,
} from '../api.js';
import { useAgentCatalogDescriptor } from '../agentCatalog.js';
import {
  AgentMark, GaugeIcon, MoreHorizontalIcon, PencilIcon, RefreshIcon, RenewIcon, XIcon,
} from './icons.jsx';
import { getLangCode, t } from '../i18n';
import { getAgentUsageEnabled, setAgentUsageEnabled } from '../storage.js';
import ActionSheet from './ActionSheet.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import UsageActionMenu from './UsageActionMenu.js';

interface UsageWindow {
  id: string;
  label?: string;
  usedPercent: number;
  resetsAt?: number | null;
  windowMinutes?: number | null;
}

interface UsageGroup {
  kind: 'account' | 'model';
  id: string;
  label?: string;
  windows: UsageWindow[];
}

interface AgentUsage {
  agentId: string;
  label: string;
  iconId?: string;
  account?: { label: string; plan?: string };
  groups: UsageGroup[];
  resetCredits?: { availableCount: number; expiryTimes: number[] };
  updatedAt?: number | null;
  status: 'ready' | 'pending' | 'setup_required' | 'unavailable';
  setupCommand?: string;
  refreshStatus?: 'fresh' | 'stale';
}

export interface UsageSnapshot {
  agents: AgentUsage[];
}

type ProviderErrorCode = 'invalid_credential' | 'rate_limited' | 'provider_timeout'
  | 'provider_unreachable' | 'unsupported_response';
const PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
  'invalid_credential', 'rate_limited', 'provider_timeout', 'provider_unreachable', 'unsupported_response',
]);
interface DeepSeekBalanceResult {
  providerType: 'deepseek'; isAvailable: boolean;
  balances: Array<{ currency: string; totalBalance: string; toppedUpBalance: string; grantedBalance: string }>;
}
interface MoonshotBalanceResult {
  providerType: 'moonshot'; currency: 'CNY';
  availableBalance: number; voucherBalance: number; cashBalance: number;
}
type ProviderType = 'deepseek' | 'moonshot';
type ProviderResult = DeepSeekBalanceResult | MoonshotBalanceResult;
const API_PROVIDERS: Record<ProviderType, { label: string; defaultName: string }> = {
  deepseek: { label: 'DeepSeek', defaultName: 'DeepSeek' },
  moonshot: { label: 'Moonshot (Kimi)', defaultName: 'Moonshot (Kimi)' },
};
interface ApiAccountView {
  id: string; name: string; providerType: ProviderType; credentialConfigured: true;
  createdAt: number; updatedAt: number; latestSuccess: ProviderResult | null;
  lastSuccessAt: number | null; lastAttemptAt: number | null; lastErrorCode: ProviderErrorCode | null;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const nonNegativeInteger = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const stringOf = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const idOf = (value: unknown): string | null => {
  const id = stringOf(value);
  return id && /^[a-z][a-z0-9._-]{0,127}$/.test(id) ? id : null;
};

const usageWindowOf = (value: unknown): UsageWindow | null => {
  const window = recordOf(value);
  const id = idOf(window?.id);
  const usedPercent = finiteNumber(window?.usedPercent);
  if (!window || !id || usedPercent == null) return null;
  const resetsAt = finiteNumber(window.resetsAt);
  const windowMinutes = finiteNumber(window.windowMinutes);
  return {
    id,
    ...(stringOf(window.label) ? { label: stringOf(window.label)! } : {}),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowMinutes != null ? { windowMinutes } : {}),
  };
};

const updatedAtOf = (value: Record<string, unknown>): number | undefined => {
  const updatedAt = finiteNumber(value.updatedAt);
  return updatedAt == null ? undefined : updatedAt;
};

const agentUsageOf = (value: unknown): AgentUsage | null => {
  const usage = recordOf(value);
  if (!usage) return null;
  const agentId = idOf(usage.agentId);
  const label = stringOf(usage.label);
  const status = usage.status;
  const refreshStatus = usage.refreshStatus;
  if (!agentId || !label || !['ready', 'pending', 'setup_required', 'unavailable'].includes(String(status))) return null;
  if (refreshStatus !== undefined && refreshStatus !== 'fresh' && refreshStatus !== 'stale') return null;
  const groups = Array.isArray(usage.groups) ? usage.groups.flatMap((value): UsageGroup[] => {
    const group = recordOf(value);
    const id = idOf(group?.id);
    if (!group || !id || (group.kind !== 'account' && group.kind !== 'model')
      || !Array.isArray(group.windows)) return [];
    const windows = group.windows.flatMap((window) => {
      const parsed = usageWindowOf(window);
      return parsed ? [parsed] : [];
    });
    if (!windows.length) return [];
    return [{
      kind: group.kind,
      id,
      ...(stringOf(group.label) ? { label: stringOf(group.label)! } : {}),
      windows,
    }];
  }) : [];
  const resetCredits = recordOf(usage.resetCredits);
  const availableCount = nonNegativeInteger(resetCredits?.availableCount);
  const resetCreditExpiryTimes = Array.isArray(resetCredits?.expiryTimes)
    ? resetCredits.expiryTimes.flatMap((value): number[] => {
      const time = finiteNumber(value);
      return time != null && time > 0
        && Number.isFinite(new Date(time * 1000).getTime()) ? [time] : [];
    }) : [];
  const rawAccount = recordOf(usage.account);
  const accountLabel = stringOf(rawAccount?.label);
  const account = rawAccount && accountLabel ? {
    label: accountLabel,
    ...(stringOf(rawAccount.plan) ? { plan: stringOf(rawAccount.plan)! } : {}),
  } : null;
  const updatedAt = updatedAtOf(usage);
  return {
    agentId, label,
    ...(idOf(usage.iconId) ? { iconId: idOf(usage.iconId)! } : {}),
    ...(account ? { account } : {}),
    groups,
    ...(availableCount == null ? {} : { resetCredits: {
      availableCount,
      expiryTimes: resetCreditExpiryTimes.slice(0, availableCount),
    } }),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    status: status as AgentUsage['status'],
    ...(stringOf(usage.setupCommand) ? { setupCommand: stringOf(usage.setupCommand)! } : {}),
    ...(refreshStatus === undefined ? {} : { refreshStatus }),
  };
};

export function parseUsageSnapshot(value: unknown): UsageSnapshot | null {
  const snapshot = recordOf(value);
  if (!snapshot || !Array.isArray(snapshot.agents)) return null;
  return { agents: snapshot.agents.flatMap((value) => {
    const agent = agentUsageOf(value);
    return agent ? [agent] : [];
  }) };
}

const deepSeekBalanceOf = (value: unknown): DeepSeekBalanceResult | null => {
  const result = recordOf(value);
  if (!result || result.providerType !== 'deepseek' || typeof result.isAvailable !== 'boolean'
    || !Array.isArray(result.balances)) return null;
  const balances = result.balances.flatMap((value): DeepSeekBalanceResult['balances'] => {
    const balance = recordOf(value);
    return balance && ['currency', 'totalBalance', 'toppedUpBalance', 'grantedBalance']
      .every((key) => typeof balance[key] === 'string') ? [{
        currency: balance.currency as string, totalBalance: balance.totalBalance as string,
        toppedUpBalance: balance.toppedUpBalance as string, grantedBalance: balance.grantedBalance as string,
      }] : [];
  });
  return balances.length === result.balances.length
    ? { providerType: 'deepseek', isAvailable: result.isAvailable, balances } : null;
};

const MAX_MOONSHOT_BALANCE = 1_000_000_000_000_000;

const boundedAmount = (value: unknown, allowNegative = false): value is number => (
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_MOONSHOT_BALANCE
    && (allowNegative || value >= 0)
);

const moonshotBalanceOf = (value: unknown): MoonshotBalanceResult | null => {
  const result = recordOf(value);
  if (!result || result.providerType !== 'moonshot' || result.currency !== 'CNY'
    || !boundedAmount(result.availableBalance) || !boundedAmount(result.voucherBalance)
    || !boundedAmount(result.cashBalance, true)) return null;
  return {
    providerType: 'moonshot', currency: 'CNY', availableBalance: result.availableBalance,
    voucherBalance: result.voucherBalance, cashBalance: result.cashBalance,
  };
};

const providerResultOf = (value: unknown, providerType: ProviderType): ProviderResult | null => {
  const result = providerType === 'deepseek' ? deepSeekBalanceOf(value)
    : moonshotBalanceOf(value);
  return result?.providerType === providerType ? result : null;
};

const apiAccountOf = (value: unknown): ApiAccountView | null => {
  const account = recordOf(value);
  if (!account || typeof account.id !== 'string' || !account.id || typeof account.name !== 'string'
    || !account.name || !['deepseek', 'moonshot'].includes(String(account.providerType))
    || account.credentialConfigured !== true) return null;
  const providerType = account.providerType as ProviderType;
  const latestSuccess = account.latestSuccess === null ? null : providerResultOf(account.latestSuccess, providerType);
  const timestamp = (candidate: unknown): number | null => (
    candidate === null ? null : typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null
  );
  if (typeof account.createdAt !== 'number' || typeof account.updatedAt !== 'number'
    || (account.latestSuccess !== null && !latestSuccess)) return null;
  const errors = ['invalid_credential', 'rate_limited', 'provider_timeout', 'provider_unreachable', 'unsupported_response'];
  if (account.lastErrorCode !== null && !errors.includes(String(account.lastErrorCode))) return null;
  return {
    id: account.id, name: account.name, providerType, credentialConfigured: true,
    createdAt: account.createdAt, updatedAt: account.updatedAt, latestSuccess,
    lastSuccessAt: timestamp(account.lastSuccessAt), lastAttemptAt: timestamp(account.lastAttemptAt),
    lastErrorCode: account.lastErrorCode as ProviderErrorCode | null,
  };
};

export function parseApiAccounts(value: unknown): ApiAccountView[] | null {
  if (!Array.isArray(value)) return null;
  const accounts = value.flatMap((candidate) => {
    const account = apiAccountOf(candidate); return account ? [account] : [];
  });
  return accounts.length === value.length ? accounts : null;
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

function fmtExpiry(expiresAt: number): string {
  const date = new Date(expiresAt * 1000);
  try {
    return new Intl.DateTimeFormat(getLangCode(), {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

// The snapshot is only as fresh as the last time the agent was active (Claude's statusLine fires on each
// API response; Codex's token_count on each turn). Surface that so a stale number isn't mistaken for live.
function Updated({ at, now, compact = false }: { at?: number | null; now: number; compact?: boolean }) {
  if (!at) return null;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const line = s < 60 ? t('usage.updatedNow')
    : s < 3600 ? t('usage.updatedMin', { n: Math.floor(s / 60) })
    : s < 86400 ? t('usage.updatedHr', { n: Math.floor(s / 3600) })
    : t('usage.updatedDay', { n: Math.floor(s / 86400) });
  const short = s < 60 ? t('usage.updatedCompactNow')
    : s < 3600 ? t('usage.updatedCompactMin', { n: Math.floor(s / 60) })
    : s < 86400 ? t('usage.updatedCompactHr', { n: Math.floor(s / 3600) })
    : t('usage.updatedCompactDay', { n: Math.floor(s / 86400) });
  return <div className="usage-updated" {...(compact ? { 'aria-label': line, title: line } : {})}>
    {compact ? short : line}
  </div>;
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

function windowLabel(window: UsageWindow): string {
  if (window.label) return window.label;
  return winLabel(window.windowMinutes)
    || (window.id === 'secondary' ? t('usage.winSecondary') : t('usage.winPrimary'));
}

function QuotaGroup({ title, windows, now }: {
  title: string;
  windows: UsageWindow[];
  now: number;
}) {
  return (
    <div className="usage-quota-group">
      <div className="usage-quota-title">{title}</div>
      {windows.map((window) => (
        <LimitRow key={window.id} label={windowLabel(window)} pct={window.usedPercent}
          reset={fmtReset(window.resetsAt, now)}
          timePct={timeElapsedPct(window.resetsAt, window.windowMinutes, now)} />
      ))}
    </div>
  );
}

function AgentUsageCard({
  usage, fallback, now, loading = false, error = '', refreshError = '', refreshing = false,
  menuDisabled = false, contentEnabled = true, menuOpen = false, onMenu,
}: {
  usage: AgentUsage | null;
  fallback: AgentUsage;
  now: number;
  loading?: boolean;
  error?: string;
  refreshError?: string;
  refreshing?: boolean;
  menuDisabled?: boolean;
  contentEnabled?: boolean;
  menuOpen?: boolean;
  onMenu?: (anchor: HTMLButtonElement) => void;
}) {
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const value = usage ?? fallback;
  const { descriptor } = useAgentCatalogDescriptor(value.agentId);
  const accountGroups = value.groups.filter((group) => group.kind === 'account');
  const modelGroups = value.groups.filter((group) => group.kind === 'model');
  const disclosureId = `usage-model-limits-${value.agentId}`;
  return (
    <section className={`usage-agent ${contentEnabled ? '' : 'usage-agent-collapsed'}`.trim()}
      data-usage-agent={value.agentId}>
      <div className="usage-agent-head">
        <AgentMark agent={value.agentId} /><span className="usage-agent-title">{descriptor?.label ?? value.label}</span>
        {contentEnabled && refreshing ? <span className="usage-refresh-status" role="status">
          <span className="api-balance-spinner" aria-hidden="true" />{t('usage.refreshing')}
        </span> : contentEnabled && !loading ? <Updated at={value.updatedAt ?? null} now={now} /> : <span />}
        {onMenu && <button type="button" className="usage-agent-menu" onClick={(event) => onMenu(event.currentTarget)}
          disabled={loading || menuDisabled}
          aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={t('usage.menu', { provider: descriptor?.label ?? value.label })}>
          <MoreHorizontalIcon />
        </button>}
      </div>
      {contentEnabled && <div className="usage-agent-body">
        {refreshError && <div className="api-balance-error usage-refresh-error" role="alert">
          {refreshError}
        </div>}
        {loading && <div className="usage-agent-skeleton" role="status" aria-label={t('common.loading')}>
          {[0, 1].map((row) => <div className="usage-row usage-row-skeleton" key={row}>
            <div className="usage-row-head"><i /><i /></div><div className="usage-bar" />
          </div>)}
        </div>}
        {!loading && error && <div className="usage-empty usage-agent-error" role="alert">{error}</div>}
        {!loading && !error && value.account && (
            <div className="usage-account">
          <span>{value.account.label}</span>
          {value.account.plan && <strong>{value.account.plan}</strong>}
            </div>
        )}
        {!loading && !error && accountGroups.map((group) => (
        <QuotaGroup key={group.id} title={group.label || t('usage.accountQuota')}
          windows={group.windows} now={now} />
        ))}
        {!loading && !error && modelGroups.length > 0 && (
            <div className="usage-model-limits">
              <button
                type="button"
                className="usage-model-limits-trigger"
                aria-expanded={modelsExpanded}
            aria-controls={disclosureId}
                onClick={() => setModelsExpanded((expanded) => !expanded)}
              >
                <span>{t('usage.modelLimits')}</span>
                <span className="usage-model-limits-meta">
                  <span className="usage-model-limits-count">{modelGroups.length}</span>
                  <span className="usage-model-limits-chevron" aria-hidden="true">›</span>
                </span>
              </button>
              <div
            id={disclosureId}
                className="usage-model-limits-content"
                hidden={!modelsExpanded}
              >
            {modelGroups.map((group) => (
              <QuotaGroup key={group.id} title={group.label || group.id} windows={group.windows} now={now} />
                ))}
              </div>
            </div>
        )}
        {!loading && !error && value.groups.length === 0 && value.status !== 'ready' && (
        <div className="usage-empty">
          {value.status === 'setup_required' ? t('usage.setupRequired')
            : value.status === 'unavailable' ? t('usage.unavailable') : t('usage.pending')}
          {value.setupCommand && <code className="usage-code">{value.setupCommand}</code>}
        </div>
        )}
        {!loading && !error && value.resetCredits && (
            <div className="usage-reset-credits">
              <span>{t('usage.resetCredits')}</span>
              <span className="usage-reset-credits-value">
            <strong>{t('usage.resetCreditsCount', { n: value.resetCredits.availableCount })}</strong>
            {value.resetCredits.expiryTimes.map((expiresAt, index) => (
                  <small key={`${expiresAt}:${index}`}>{t('usage.resetCreditExpires', {
                    time: fmtExpiry(expiresAt),
                  })}</small>
                ))}
              </span>
            </div>
        )}
      </div>}
    </section>
  );
}

function providerErrorText(code: ProviderErrorCode | null): string {
  if (!code) return '';
  return t(`apiBalance.error.${code}`);
}

export function apiAccountSaveErrorText(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.code === 'storage_unavailable') return t('apiBalance.error.storage_unavailable');
    if (reason.code === 'conflict') return t('apiBalance.error.conflict');
    if (reason.code === 'account_limit_reached') return t('apiBalance.error.account_limit_reached');
    if (reason.code === 'not_found') return t('apiBalance.error.not_found');
    if (PROVIDER_ERROR_CODES.has(reason.code as ProviderErrorCode)) {
      return providerErrorText(reason.code as ProviderErrorCode);
    }
  }
  return t('apiBalance.saveFailed');
}

function apiAccountQueryErrorText(reason: unknown): string {
  const mapped = apiAccountSaveErrorText(reason);
  return mapped === t('apiBalance.saveFailed') ? t('apiBalance.refreshFailed') : mapped;
}

export function isApiCredentialContextSafe(secureContext: boolean, hostname: string): boolean {
  if (secureContext) return true;
  const host = hostname.toLowerCase();
  const octets = host.split('.');
  const ipv4Loopback = octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return host === 'localhost' || ipv4Loopback || host === '::1' || host === '[::1]';
}

export function isApiAccountNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && [...trimmed].length <= 64;
}

function credentialTransportSafe(): boolean {
  return typeof window !== 'undefined'
    && isApiCredentialContextSafe(window.isSecureContext, window.location.hostname);
}

interface BalanceDisplay {
  primaryLabel: string;
  primaryValue: string;
  details: Array<{ label: string; value: string }>;
  extras: Array<{ key: string; label: string; value: string; details: Array<{ label: string; value: string }> }>;
  availability: boolean | null;
}

function balanceDisplayOf(result: ProviderResult | null): BalanceDisplay | null {
  if (!result) return null;
  switch (result.providerType) {
    case 'deepseek': {
      const [primary, ...extras] = result.balances;
      if (!primary) return {
        primaryLabel: t('apiBalance.noBalanceData'), primaryValue: '—', details: [], extras: [],
        availability: result.isAvailable,
      };
      const details = (balance: DeepSeekBalanceResult['balances'][number]) => [
        { label: t('apiBalance.toppedUp'), value: balance.toppedUpBalance },
        { label: t('apiBalance.granted'), value: balance.grantedBalance },
      ];
      return {
        primaryLabel: t('apiBalance.currencyAvailable', { currency: primary.currency }),
        primaryValue: primary.totalBalance,
        details: details(primary),
        extras: extras.map((balance) => ({
          key: balance.currency, label: t('apiBalance.currencyAvailable', { currency: balance.currency }),
          value: balance.totalBalance, details: details(balance),
        })),
        availability: result.isAvailable,
      };
    }
    case 'moonshot': return {
      primaryLabel: t('apiBalance.currencyAvailable', { currency: result.currency }),
      primaryValue: String(result.availableBalance),
      details: [
        { label: t('apiBalance.cash'), value: String(result.cashBalance) },
        { label: t('apiBalance.voucher'), value: String(result.voucherBalance) },
      ],
      extras: [], availability: null,
    };
  }
}

function BalanceDetails({ details }: { details: BalanceDisplay['details'] }) {
  return <span className="api-balance-details">{details.map((detail) => (
    <span className="api-balance-detail" key={detail.label}>
      <span>{detail.label}</span> <b>{detail.value}</b>
    </span>
  ))}</span>;
}

function ApiAccountCard({ account, busy, feedback, menuOpen, onMenu }: {
  account: ApiAccountView; busy: boolean; feedback: string | undefined; menuOpen: boolean;
  onMenu: (account: ApiAccountView, anchor: HTMLButtonElement) => void;
}) {
  const display = balanceDisplayOf(account.latestSuccess);
  return (
    <section className="api-balance-card" data-account-id={account.id}>
      <div className="api-balance-primary-row">
        <strong className="api-balance-name">{account.name}</strong>
        {display ? <div className="api-balance-primary">
          <span>{display.primaryLabel}</span><strong>{display.primaryValue}</strong>
        </div> : <span className="api-balance-not-queried">{t('apiBalance.notQueried')}</span>}
        <button className="api-balance-menu" type="button" onClick={(event) => onMenu(account, event.currentTarget)}
          aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={t('apiBalance.menuAccount', {
            account: account.name, provider: API_PROVIDERS[account.providerType].label,
          })}>
          <MoreHorizontalIcon />
        </button>
      </div>
      <div className="api-balance-secondary">
        <span className="api-balance-provider">
          {API_PROVIDERS[account.providerType].label}
          {display?.availability != null && <span className={`api-balance-status ${display.availability ? 'available' : 'unavailable'}`}>
            <i aria-hidden="true" />{t(display.availability ? 'apiBalance.available' : 'apiBalance.insufficient')}
          </span>}
        </span>
        <div className="api-balance-update-slot">
          {busy ? <span className="api-balance-refreshing" role="status">
            <span className="api-balance-spinner" aria-hidden="true" />{t('apiBalance.refreshing')}
          </span> : display ? <Updated at={account.lastSuccessAt} now={Date.now()} compact /> : null}
        </div>
        {display && <BalanceDetails details={display.details} />}
      </div>
      {display?.extras.map((extra) => <div className="api-balance-extra" key={extra.key}>
        <span>{extra.label}</span><strong>{extra.value}</strong><BalanceDetails details={extra.details} />
      </div>)}
      {(feedback || account.lastErrorCode) && <div className="api-balance-error api-balance-account-error" role="alert">
        {feedback || providerErrorText(account.lastErrorCode)}
      </div>}
    </section>
  );
}

function ApiAccountSkeleton() {
  return <section className="api-balance-card api-balance-skeleton">
    <div className="api-balance-primary-row">
      <i className="api-balance-skeleton-name" />
      <i className="api-balance-skeleton-amount" />
      <span className="api-balance-menu api-balance-menu-placeholder" aria-hidden="true"><MoreHorizontalIcon /></span>
    </div>
    <div className="api-balance-secondary">
      <i className="api-balance-skeleton-meta" />
      <div className="api-balance-update-slot"><i className="api-balance-skeleton-time" /></div>
      <span className="api-balance-details"><i className="api-balance-skeleton-details" /></span>
    </div>
  </section>;
}

type FormMode = 'add' | 'rename' | 'credential';

function ApiAccountForm({ mode, account, providerType, returnFocus, onClose, onSaved, onAuthFail }: {
  mode: FormMode; account: ApiAccountView | null; providerType: ProviderType; onClose: () => void;
  returnFocus?: HTMLButtonElement;
  onSaved: (account: ApiAccountView) => void; onAuthFail?: () => void;
}) {
  const [name, setName] = useState(mode === 'add' ? API_PROVIDERS[providerType].defaultName : account?.name ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const needsKey = mode !== 'rename';
  const safe = credentialTransportSafe();
  const validName = isApiAccountNameValid(name);
  useEffect(() => () => requestRef.current?.abort(), []);
  useLayoutEffect(() => {
    (mode === 'credential' ? keyInputRef.current : nameInputRef.current)?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [mode, returnFocus]);
  const cancelAndClose = () => { requestRef.current?.abort(); onClose(); };
  const submit = async () => {
    if (!validName || (needsKey && !key)) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const raw = mode === 'add'
        ? await createApiAccount(
          { providerType, name, credential: { kind: 'apiKey', value: key } }, controller.signal,
        )
        : await patchApiAccount(account!.id, mode === 'rename'
          ? { name } : { credential: { kind: 'apiKey', value: key } }, controller.signal);
      const saved = apiAccountOf(raw);
      if (!saved) throw new Error('invalid response');
      onSaved(saved); cancelAndClose();
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      else setError(apiAccountSaveErrorText(reason));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <div className="settings-backdrop api-form-backdrop" onClick={cancelAndClose} />
      <div className="settings-card api-account-form" role="dialog" aria-modal="true"
        aria-label={t(`apiBalance.form.${mode}`)}>
        <div className="settings-head">
          <span className="settings-title">{t(`apiBalance.form.${mode}`)}</span>
          <button type="button" className="settings-close" onClick={cancelAndClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-body api-form-body">
          <div className="api-form-section-label">{t('apiBalance.account')}</div>
          <div className="api-form-group">
            <div className="api-form-row api-form-provider"><span>{t('apiBalance.provider')}</span><strong>{API_PROVIDERS[providerType].label}</strong></div>
            {mode !== 'credential' && <label className="api-form-row api-form-field"><span>{t('apiBalance.name')}</span>
              <input ref={nameInputRef} value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
            </label>}
            {needsKey && <label className="api-form-row api-form-field"><span>API Key</span>
              <input ref={keyInputRef} type="password" value={key} maxLength={4096} autoComplete="off" autoCapitalize="none"
                autoCorrect="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} />
            </label>}
          </div>
          {needsKey && <p className="api-form-note">{t('apiBalance.credentialNote')}</p>}
          {needsKey && !safe && <div className="api-balance-error">{t('apiBalance.secureRequired')}</div>}
          {error && <div className="api-balance-error">{error}</div>}
        </div>
        <div className="settings-btns api-form-actions">
          <button type="button" className="fontbtn" onClick={cancelAndClose}>{t('common.cancel')}</button>
          <button type="button" className="fontbtn bind-confirm api-form-submit"
            disabled={busy || !validName || (needsKey && (!key || !safe))} onClick={() => void submit()}>
            {busy ? <span className="api-balance-spinner" role="status" aria-label={t('apiBalance.verifying')} />
              : t(needsKey ? 'apiBalance.verifySave' : 'common.save')}
          </button>
        </div>
      </div>
    </>
  );
}

function ApiBalanceTab({ active, onAuthFail }: {
  active: boolean; onAuthFail?: () => void;
}) {
  const [accounts, setAccounts] = useState<ApiAccountView[] | null>(null);
  const [error, setError] = useState('');
  const [queryFeedback, setQueryFeedback] = useState<Record<string, string>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{
    mode: FormMode; account: ApiAccountView | null; providerType: ProviderType;
    returnFocus?: HTMLButtonElement;
  } | null>(null);
  const [menu, setMenu] = useState<{ account: ApiAccountView; anchor: HTMLButtonElement } | null>(null);
  const [providerPicker, setProviderPicker] = useState(false);
  const nestedOverlayOpen = providerPicker || !!menu || !!form;
  useBackButton(active && nestedOverlayOpen, () => {
    if (providerPicker) setProviderPicker(false);
    else if (menu) setMenu(null);
    else setForm(null);
  });
  const replace = (account: ApiAccountView) => setAccounts((current) => (
    current ? current.map((candidate) => candidate.id === account.id ? account : candidate) : [account]
  ));
  const clearQueryFeedback = (id: string) => setQueryFeedback((current) => {
    if (!(id in current)) return current;
    const next = { ...current }; delete next[id]; return next;
  });
  const reportQueryFeedback = (id: string, message: string) => setQueryFeedback((current) => (
    { ...current, [id]: message }
  ));
  const refresh = async (account: ApiAccountView) => {
    setBusyIds((current) => new Set(current).add(account.id));
    try {
      const updated = apiAccountOf(await queryApiAccount(account.id));
      if (updated) {
        replace(updated); setError(''); clearQueryFeedback(account.id);
      } else {
        setError(''); reportQueryFeedback(account.id, t('apiBalance.refreshFailed'));
      }
    } catch (reason) {
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      else if (reason instanceof ApiError && reason.status === 404) {
        setAccounts((current) => current?.filter((candidate) => candidate.id !== account.id) ?? []);
        setError(''); clearQueryFeedback(account.id);
      } else {
        reportQueryFeedback(account.id, apiAccountQueryErrorText(reason));
        try {
          const parsed = parseApiAccounts(await getApiAccounts());
          if (parsed) { setAccounts(parsed); setError(''); }
          else setError(t('apiBalance.loadFailed'));
        } catch (reloadError) {
          if (reloadError instanceof UnauthorizedError) onAuthFail?.();
          else setError(t('apiBalance.loadFailed'));
        }
      }
    } finally {
      setBusyIds((current) => { const next = new Set(current); next.delete(account.id); return next; });
    }
  };
  useEffect(() => {
    if (!active || accounts !== null) return;
    let cancelled = false;
    getApiAccounts().then((raw) => {
      if (cancelled) return;
      const parsed = parseApiAccounts(raw);
      if (!parsed) { setError(t('apiBalance.loadFailed')); return; }
      setAccounts(parsed); setError('');
      const stale = parsed.filter((account) => !account.lastSuccessAt || Date.now() - account.lastSuccessAt > 60_000);
      for (const account of stale) void refresh(account);
    }).catch((reason) => {
      if (cancelled) return;
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      else if (reason instanceof ApiError && reason.code === 'storage_unavailable') {
        setError(apiAccountSaveErrorText(reason));
      } else setError(t('apiBalance.loadFailed'));
    });
    return () => { cancelled = true; };
  // Loading is intentionally once per open UsagePage instance; refresh updates accounts separately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, accounts, onAuthFail]);
  const remove = async (account: ApiAccountView) => {
    try {
      await deleteApiAccount(account.id);
      setAccounts((current) => current?.filter((item) => item.id !== account.id) ?? []);
      setError(''); clearQueryFeedback(account.id);
    } catch (reason) {
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      else if (reason instanceof ApiError && reason.status === 404) {
        setAccounts((current) => current?.filter((item) => item.id !== account.id) ?? []);
        setError(''); clearQueryFeedback(account.id);
      } else if (reason instanceof ApiError && reason.code === 'storage_unavailable') {
        setError(apiAccountSaveErrorText(reason));
      } else setError(t('apiBalance.deleteFailed'));
    }
    setMenu(null);
  };
  if (!active) return null;
  return <div className="api-balance-tab">
    {error && <div className="api-balance-error api-balance-global-error">{error}</div>}
    {accounts === null && !error ? <div className="api-balance-skeletons" role="status" aria-label={t('common.loading')}>
      <ApiAccountSkeleton /><ApiAccountSkeleton />
    </div> : accounts?.length === 0 ? <div className="api-balance-empty">
      <strong>{t('apiBalance.empty')}</strong><span>{t('apiBalance.emptyHint')}</span>
    </div> : accounts?.map((account) => <ApiAccountCard key={account.id} account={account}
      busy={busyIds.has(account.id)} feedback={queryFeedback[account.id]}
      menuOpen={menu?.account.id === account.id}
      onMenu={(selected, anchor) => setMenu({ account: selected, anchor })} />)}
    <button type="button" className="api-balance-add-row" onClick={() => setProviderPicker(true)}>
      <span aria-hidden="true">＋</span><strong>{t('apiBalance.addAccount')}</strong>
    </button>
    <p className="api-balance-storage-note">{t('apiBalance.storageNote')}</p>
    {form && <OverlayPortal className="usage-nested-overlay"><ApiAccountForm {...form} onClose={() => setForm(null)}
      {...(onAuthFail ? { onAuthFail } : {})} onSaved={(saved) => {
      setAccounts((current) => form.mode === 'add' ? [...(current ?? []), saved]
        : (current ?? []).map((account) => account.id === saved.id ? saved : account));
      setError(''); clearQueryFeedback(saved.id);
    }} /></OverlayPortal>}
    {providerPicker && <OverlayPortal className="usage-nested-overlay"><ActionSheet open
      title={t('apiBalance.chooseProvider')} onClose={() => setProviderPicker(false)}
      actions={(Object.entries(API_PROVIDERS) as Array<[ProviderType, typeof API_PROVIDERS[ProviderType]]>)
        .map(([providerType, provider]) => ({
          key: providerType, label: provider.label, onClick: () => {
            setProviderPicker(false); setForm({ mode: 'add', account: null, providerType });
          },
        }))} /></OverlayPortal>}
    {menu && <UsageActionMenu anchor={menu.anchor}
      label={t('apiBalance.menuAccount', {
        account: menu.account.name, provider: API_PROVIDERS[menu.account.providerType].label,
      })}
      onClose={() => setMenu(null)} actions={[
        { key: 'refresh', label: t('apiBalance.refresh'), icon: <RefreshIcon />,
          disabled: busyIds.has(menu.account.id), onClick: () => void refresh(menu.account) },
        { key: 'rename', label: t('apiBalance.rename'), icon: <PencilIcon />,
          restoreFocusOnSelect: false,
          onClick: () => setForm({ mode: 'rename', account: menu.account,
            providerType: menu.account.providerType, returnFocus: menu.anchor }) },
        { key: 'credential', label: t('apiBalance.replaceCredential'), icon: <RenewIcon />,
          restoreFocusOnSelect: false,
          onClick: () => setForm({ mode: 'credential', account: menu.account,
            providerType: menu.account.providerType, returnFocus: menu.anchor }) },
        { key: 'delete', label: t('common.delete'), icon: <XIcon />, danger: true,
          confirmLabel: t('apiBalance.deleteConfirm'), onClick: () => void remove(menu.account) },
      ]} />}
  </div>;
}

export default function UsagePage({ open, onClose, onAuthFail }: {
  open: boolean;
  onClose: () => void;
  onAuthFail?: () => void;
}) {
  const [tab, setTab] = useState<'subscription' | 'api'>('subscription');
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshingAgents, setRefreshingAgents] = useState<Set<string>>(() => new Set());
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  const [usageMenu, setUsageMenu] = useState<{
    agentId: 'claude' | 'codex'; anchor: HTMLButtonElement;
  } | null>(null);
  const [usageEnabled, setUsageEnabled] = useState<Record<'claude' | 'codex', boolean>>(() => ({
    claude: getAgentUsageEnabled('claude'), codex: getAgentUsageEnabled('codex'),
  }));
  const usageRequestRef = useRef(0);
  const now = Date.now();

  useBackButton(open && tab === 'subscription' && usageMenu !== null, () => setUsageMenu(null));

  const loadSubscriptionUsage = useCallback(async () => {
    const request = ++usageRequestRef.current;
    setLoading(true); setError('');
    try {
      const snapshot = parseUsageSnapshot(await getAgentUsage());
      if (usageRequestRef.current !== request) return;
      if (snapshot) setData(snapshot);
      else setError(t('usage.loadFailed'));
    } catch (reason) {
      if (usageRequestRef.current !== request) return;
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      setError(t('usage.loadFailed'));
    } finally {
      if (usageRequestRef.current === request) setLoading(false);
    }
  }, [onAuthFail]);

  const refreshProvider = useCallback(async (agentId: 'claude' | 'codex') => {
    const request = usageRequestRef.current;
    setRefreshingAgents((current) => new Set(current).add(agentId));
    setRefreshErrors((current) => {
      const next = { ...current }; delete next[agentId]; return next;
    });
    try {
      const snapshot = parseUsageSnapshot(await getAgentUsage(true, agentId));
      if (usageRequestRef.current !== request) return;
      const refreshed = snapshot?.agents.length === 1 ? snapshot.agents[0] : undefined;
      if (!refreshed || refreshed.agentId !== agentId) {
        setRefreshErrors((current) => ({ ...current, [agentId]: t('usage.refreshFailed') }));
        return;
      }
      setData((current) => current ? {
        agents: current.agents.some((agent) => agent.agentId === agentId)
          ? current.agents.map((agent) => agent.agentId === agentId ? refreshed : agent)
          : [...current.agents, refreshed],
      } : { agents: [refreshed] });
      if (refreshed.refreshStatus !== 'fresh') {
        setRefreshErrors((current) => ({ ...current, [agentId]: t('usage.refreshFailed') }));
      }
    } catch (reason) {
      if (usageRequestRef.current !== request) return;
      if (reason instanceof UnauthorizedError) onAuthFail?.();
      setRefreshErrors((current) => ({ ...current, [agentId]: t('usage.refreshFailed') }));
    } finally {
      if (usageRequestRef.current === request) {
        setRefreshingAgents((current) => {
          const next = new Set(current); next.delete(agentId); return next;
        });
      }
    }
  }, [onAuthFail]);

  useEffect(() => {
    if (!open) {
      usageRequestRef.current += 1;
      setTab('subscription'); setUsageMenu(null); setRefreshingAgents(new Set()); setRefreshErrors({});
      return undefined;
    }
    setTab('subscription');
    void loadSubscriptionUsage();
    return () => { usageRequestRef.current += 1; };
  }, [open, loadSubscriptionUsage]);

  if (!open) return null;

  return (
    <OverlayPortal>
      <>
        <div className="settings-backdrop usage-backdrop" onClick={onClose} />
        <div className="settings-card usage-card" role="dialog" aria-label={t('usage.title')} aria-modal="true">
          <div className="settings-head usage-card-head">
            <span className="settings-title">{t('usage.title')}</span>
            <button type="button" className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
          </div>
        <div className="usage-tabs cmd-seg" role="tablist" aria-label={t('usage.title')}>
          <button type="button" role="tab" aria-selected={tab === 'subscription'}
            className={`cmd-seg-btn ${tab === 'subscription' ? 'on' : ''}`} onClick={() => setTab('subscription')}>
            {t('usage.subscriptionTab')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'api'}
            className={`cmd-seg-btn ${tab === 'api' ? 'on' : ''}`} onClick={() => setTab('api')}>
            {t('usage.apiTab')}
          </button>
        </div>
          <div className="settings-body usage-card-body">
            <div className="settings-section usage-sheet-content">
          {tab === 'subscription' && (() => {
            const agents = data?.agents ?? [];
            const fixed = ([
              { agentId: 'claude', label: 'Claude Code', groups: [], status: 'unavailable' },
              { agentId: 'codex', label: 'Codex', groups: [], status: 'unavailable' },
            ] satisfies AgentUsage[]);
            const fixedIds = new Set(fixed.map((agent) => agent.agentId));
            return <>
              {data && error && <div className="api-balance-error usage-load-error" role="alert">{error}</div>}
              {fixed.map((fallback) => <AgentUsageCard key={fallback.agentId}
                usage={agents.find((agent) => agent.agentId === fallback.agentId) ?? null}
                fallback={fallback} now={now} loading={!data && (loading || !error)} error={data ? '' : error}
                refreshError={refreshErrors[fallback.agentId] ?? ''}
                refreshing={refreshingAgents.has(fallback.agentId)}
                menuDisabled={loading}
                contentEnabled={usageEnabled[fallback.agentId as 'claude' | 'codex']}
                menuOpen={usageMenu?.agentId === fallback.agentId}
                onMenu={(anchor) => setUsageMenu({
                  agentId: fallback.agentId as 'claude' | 'codex', anchor,
                })} />)}
              {agents.filter((agent) => !fixedIds.has(agent.agentId)).map((usage) => (
                <AgentUsageCard key={usage.agentId} usage={usage} fallback={usage} now={now} />
              ))}
            </>;
          })()}
          <ApiBalanceTab active={tab === 'api'} {...(onAuthFail ? { onAuthFail } : {})} />
            </div>
          </div>
        </div>
        {usageMenu && <UsageActionMenu anchor={usageMenu.anchor}
          label={t('usage.menu', {
            provider: usageMenu.agentId === 'claude' ? 'Claude Code' : 'Codex',
          })}
          onClose={() => setUsageMenu(null)} actions={usageEnabled[usageMenu.agentId] ? [{
            key: 'refresh', label: t('usage.refresh'), icon: <RefreshIcon />,
            disabled: refreshingAgents.has(usageMenu.agentId),
            onClick: () => void refreshProvider(usageMenu.agentId),
          }, {
            key: 'hide', label: t('usage.hide'), icon: <GaugeIcon />,
            onClick: () => {
              setUsageEnabled((current) => ({ ...current, [usageMenu.agentId]: false }));
              setAgentUsageEnabled(usageMenu.agentId, false);
              setRefreshErrors((current) => {
                const next = { ...current }; delete next[usageMenu.agentId]; return next;
              });
            },
          }] : [{
            key: 'show', label: t('usage.show'), icon: <GaugeIcon />, onClick: () => {
              setUsageEnabled((current) => ({ ...current, [usageMenu.agentId]: true }));
              setAgentUsageEnabled(usageMenu.agentId, true);
              setRefreshErrors((current) => {
                const next = { ...current }; delete next[usageMenu.agentId]; return next;
              });
            },
          }]} />}
      </>
    </OverlayPortal>
  );
}
