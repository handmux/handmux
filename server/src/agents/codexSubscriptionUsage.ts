import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readLatestUsage, readSnapshot, writeSnapshot } from '../codexUsageSnapshot.js';
import type { CodexUsage, UsageRateLimitWindow } from '../codexUsageSnapshot.js';
import { codexSessionsDir, codexUsagePath } from '../usagePaths.js';
import type {
  AgentSubscriptionUsageAdapterSnapshot,
  AgentSubscriptionUsageAdapterV1,
  AgentSubscriptionUsageGroup,
  AgentSubscriptionUsageWindow,
} from '../agent-runtime/subscriptionUsage.js';
import type { DeprecatedSubscriptionUsageLegacyProjector } from '../agent-runtime/subscriptionUsageLegacy.js';

export interface CodexSubscriptionUsageOptions {
  home?: string;
  now?: () => number;
  calibrationMs?: number;
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  accountTtlMs?: number;
  fetchAccount?: () => Promise<CodexAccountLimits | null>;
}

export interface CodexAccountSummary {
  type: string;
  email: string | null;
  planType: string | null;
}

export interface CodexRateLimits {
  primary: UsageRateLimitWindow | null;
  secondary: UsageRateLimitWindow | null;
}

export interface CodexModelRateLimits extends CodexRateLimits {
  limitId: string;
  limitName: string | null;
}

export interface CodexAccountLimits {
  account: CodexAccountSummary | null;
  rateLimits: CodexRateLimits;
  modelRateLimits: CodexModelRateLimits[];
  resetCredits: { availableCount: number; expiryTimes: number[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

function rolloutFilesByMtime(dir: string): Array<{ file: string; mtimeMs: number }> {
  const files: Array<{ file: string; mtimeMs: number }> = [];
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* raced away */ }
      }
    }
  };
  visit(dir);
  return files.sort((first, second) => second.mtimeMs - first.mtimeMs);
}

function scanCodexUsage(home: string): CodexUsage | null {
  let latest: CodexUsage | null = null;
  for (const { file, mtimeMs } of rolloutFilesByMtime(codexSessionsDir(home))) {
    if (latest?.updatedAt && mtimeMs < latest.updatedAt) break;
    const usage = readLatestUsage(file);
    if (usage && (!latest || usage.updatedAt > latest.updatedAt)) latest = usage;
  }
  return latest;
}

export function readCodexSubscriptionUsage(
  home: string = homedir(),
  { now = Date.now(), calibrationMs = 60_000 }: { now?: number; calibrationMs?: number } = {},
): CodexUsage | null {
  const file = codexUsagePath(home);
  const snapshot = readSnapshot(file);
  if (snapshot && now - snapshot.checkedAt < calibrationMs) return snapshot.usage;
  writeSnapshot(file, scanCodexUsage(home), { checkedAt: now });
  return readSnapshot(file)?.usage ?? null;
}

function normalizeWindow(value: unknown): UsageRateLimitWindow | null {
  if (!isRecord(value) || !finite(value.usedPercent)) return null;
  return {
    usedPercent: value.usedPercent,
    windowMinutes: finite(value.windowDurationMins) ? value.windowDurationMins : null,
    resetsAt: finite(value.resetsAt) ? value.resetsAt : null,
  };
}

function normalizeAccount(value: unknown): CodexAccountSummary | null {
  if (!isRecord(value)) return null;
  const type = optionalString(value.type);
  return type ? { type, email: optionalString(value.email), planType: optionalString(value.planType) } : null;
}

function normalizeModels(value: unknown, mainLimitId: string | null): CodexModelRateLimits[] {
  if (!isRecord(value)) return [];
  const models: CodexModelRateLimits[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const limitId = optionalString(raw.limitId) ?? key;
    if (limitId === (mainLimitId ?? 'codex') || seen.has(limitId)) continue;
    const primary = normalizeWindow(raw.primary);
    const secondary = normalizeWindow(raw.secondary);
    if (!primary && !secondary) continue;
    models.push({ limitId, limitName: optionalString(raw.limitName), primary, secondary });
    seen.add(limitId);
  }
  return models;
}

function normalizeCredits(value: unknown): CodexAccountLimits['resetCredits'] {
  if (!isRecord(value) || !Number.isSafeInteger(value.availableCount)) return null;
  const availableCount = value.availableCount as number;
  if (availableCount < 0) return null;
  const expiryTimes = (Array.isArray(value.credits) ? value.credits : []).flatMap((credit): number[] => {
    if (!isRecord(credit) || credit.status !== 'available' || !finite(credit.expiresAt)
      || credit.expiresAt <= 0 || !Number.isFinite(new Date(credit.expiresAt * 1000).getTime())) return [];
    return [credit.expiresAt];
  }).sort((first, second) => first - second).slice(0, availableCount);
  return { availableCount, expiryTimes };
}

export function fetchCodexSubscriptionUsage({
  home = homedir(), command = 'codex', args = ['app-server', '--stdio'], timeoutMs = 15_000,
}: CodexSubscriptionUsageOptions = {}): Promise<CodexAccountLimits | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let settled = false;
    let stdout = '';
    let account: CodexAccountSummary | null = null;
    let accountRead = false;
    let limits: Omit<CodexAccountLimits, 'account'> | null = null;
    const finish = (value: CodexAccountLimits | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* best effort */ }
      resolve(value);
    };
    const finishWhenReady = (): void => { if (accountRead && limits) finish({ account, ...limits }); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(command, args, {
        env: { ...process.env, CODEX_HOME: path.join(home, '.codex') },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { finish(null); return; }
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) { finish(null); return; }
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!isRecord(message)) continue;
        if (message.id === 1 && message.result) {
          child?.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child?.stdin?.write(`${JSON.stringify({ method: 'account/read', id: 2, params: { refreshToken: false } })}\n`);
          child?.stdin?.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 3 })}\n`);
        } else if (message.id === 2) {
          const result = isRecord(message.result) ? message.result : null;
          account = normalizeAccount(result?.account);
          accountRead = true;
          finishWhenReady();
        } else if (message.id === 3) {
          const result = isRecord(message.result) ? message.result : null;
          const source = result && isRecord(result.rateLimits) ? result.rateLimits : null;
          if (!source) { finish(null); return; }
          limits = {
            rateLimits: {
              primary: normalizeWindow(source.primary), secondary: normalizeWindow(source.secondary),
            },
            modelRateLimits: normalizeModels(result?.rateLimitsByLimitId, optionalString(source.limitId)),
            resetCredits: normalizeCredits(result?.rateLimitResetCredits),
          };
          finishWhenReady();
        }
      }
    });
    child.stdin?.on('error', () => finish(null));
    child.stdin?.write(`${JSON.stringify({
      method: 'initialize', id: 1,
      params: { clientInfo: { name: 'handmux', title: 'handmux', version: '0.0.0' } },
    })}\n`);
  });
}

function adapterWindow(id: string, value: UsageRateLimitWindow | null): AgentSubscriptionUsageWindow | null {
  if (!value) return null;
  return {
    id, usedPercent: value.usedPercent,
    ...(value.windowMinutes === null ? {} : { windowMinutes: value.windowMinutes }),
    ...(value.resetsAt === null ? {} : { resetsAt: value.resetsAt }),
  };
}

function group(
  kind: AgentSubscriptionUsageGroup['kind'],
  id: string,
  label: string | null,
  limits: CodexRateLimits,
): AgentSubscriptionUsageGroup | null {
  const windows = [adapterWindow('primary', limits.primary), adapterWindow('secondary', limits.secondary)]
    .filter((window): window is AgentSubscriptionUsageWindow => window !== null);
  return windows.length ? { kind, id, ...(label ? { label } : {}), windows } : null;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function accountLabel(account: CodexAccountSummary): string {
  if (account.email) return account.email;
  if (account.type === 'apiKey') return 'API Key';
  if (account.type === 'chatgpt') return 'ChatGPT';
  return titleCase(account.type);
}

export function createCodexSubscriptionUsageAdapter(
  options: CodexSubscriptionUsageOptions = {},
): AgentSubscriptionUsageAdapterV1 & DeprecatedSubscriptionUsageLegacyProjector {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  let lastAccount: (CodexAccountLimits & { updatedAt: number }) | null = null;
  let accountCheckedAt = Number.NEGATIVE_INFINITY;
  let accountPromise: Promise<(CodexAccountLimits & { updatedAt: number }) | null> | null = null;
  let accountPromiseForced = false;
  let legacy: Record<string, unknown> | null = null;
  const refreshAccount = async (force: boolean): Promise<(CodexAccountLimits & { updatedAt: number }) | null> => {
    const current = now();
    if (!force && current - accountCheckedAt < (options.accountTtlMs ?? 60_000)) return lastAccount;
    if (accountPromise) {
      if (!force || accountPromiseForced) return accountPromise;
      try { await accountPromise; } catch { /* the explicit refresh below gets its own authoritative result */ }
      return refreshAccount(true);
    }
    let pending: Promise<(CodexAccountLimits & { updatedAt: number }) | null>;
    pending = (options.fetchAccount
      ? options.fetchAccount()
      : fetchCodexSubscriptionUsage({ ...options, home })).then((fetched) => {
      if (!fetched && force) throw new Error('Codex subscription usage refresh failed');
      if (fetched) {
        accountCheckedAt = now();
        lastAccount = { ...fetched, updatedAt: accountCheckedAt };
      }
      return lastAccount;
    }).finally(() => {
      if (accountPromise === pending) {
        accountPromise = null;
        accountPromiseForced = false;
      }
    });
    accountPromise = pending;
    accountPromiseForced = force;
    return pending;
  };
  return {
    apiVersion: 1,
    async snapshot({ refresh = false }: { refresh?: boolean } = {}): Promise<AgentSubscriptionUsageAdapterSnapshot> {
      const rollout = readCodexSubscriptionUsage(home, {
        now: now(), calibrationMs: refresh ? 0 : options.calibrationMs ?? 60_000,
      });
      const account = await refreshAccount(refresh);
      const effectiveLimits = account?.rateLimits ?? rollout?.rateLimits ?? { primary: null, secondary: null };
      const coreResetCredits = account?.resetCredits ? {
        availableCount: account.resetCredits.availableCount,
        expiryTimes: account.resetCredits.expiryTimes.slice(0, 256),
      } : null;
      const groups: AgentSubscriptionUsageGroup[] = [];
      const accountGroup = group('account', 'account', null, effectiveLimits);
      if (accountGroup) groups.push(accountGroup);
      for (const model of (account?.modelRateLimits ?? []).slice(0, 63)) {
        const modelGroup = group('model', model.limitId, model.limitName, model);
        if (modelGroup) groups.push(modelGroup);
      }
      legacy = !account && !rollout ? null : {
        updatedAt: account?.updatedAt ?? rollout?.updatedAt ?? null,
        account: account?.account ? structuredClone(account.account) : null,
        rateLimits: structuredClone(effectiveLimits),
        modelRateLimits: structuredClone(account?.modelRateLimits ?? []),
        rateLimitResetCredits: account?.resetCredits
          ? structuredClone(account.resetCredits) : null,
        tokens: structuredClone(rollout?.tokens ?? {
          total: null, input: null, cachedInput: null, output: null, reasoning: null,
        }),
        contextWindow: rollout?.contextWindow ?? null,
      };
      return {
        ...(account?.account ? {
          account: {
            label: accountLabel(account.account),
            ...(account.account.planType ? { plan: titleCase(account.account.planType) } : {}),
          },
        } : {}),
        groups,
        ...(coreResetCredits ? { resetCredits: coreResetCredits } : {}),
        updatedAt: account?.updatedAt ?? rollout?.updatedAt ?? null,
        status: !account && !rollout ? 'unavailable'
          : groups.length || account?.account || account?.resetCredits ? 'ready' : 'pending',
      };
    },
    legacySnapshot: () => legacy ? structuredClone(legacy) : null,
  };
}
