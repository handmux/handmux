import type { AgentPresentation } from './adapter.js';

export type AgentSubscriptionUsageStatus =
  | 'ready'
  | 'pending'
  | 'setup_required'
  | 'unavailable';

export interface AgentSubscriptionUsageWindow {
  id: string;
  label?: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface AgentSubscriptionUsageGroup {
  kind: 'account' | 'model';
  id: string;
  label?: string;
  windows: AgentSubscriptionUsageWindow[];
}

export interface AgentSubscriptionUsageAccount {
  label: string;
  plan?: string;
}

export interface AgentSubscriptionUsageResetCredits {
  availableCount: number;
  expiryTimes: number[];
}

// Adapter-owned projection. It contains only provider facts already normalized to the Handmux contract;
// credentials, provider payloads, and session-scoped token/context usage are deliberately excluded.
export interface AgentSubscriptionUsageAdapterSnapshot {
  account?: AgentSubscriptionUsageAccount;
  groups: AgentSubscriptionUsageGroup[];
  resetCredits?: AgentSubscriptionUsageResetCredits;
  updatedAt: number | null;
  status: AgentSubscriptionUsageStatus;
  setupCommand?: string;
}

export interface AgentSubscriptionUsageAdapterV1 {
  apiVersion: 1;
  snapshot(options?: { refresh?: boolean }): Promise<AgentSubscriptionUsageAdapterSnapshot>;
}

export interface AgentSubscriptionUsageSnapshot extends AgentSubscriptionUsageAdapterSnapshot {
  agentId: string;
  label: string;
  iconId?: string;
  refreshStatus?: 'fresh' | 'stale';
}

export interface SubscriptionUsageServiceOptions {
  adapters: Readonly<Record<string, AgentSubscriptionUsageAdapterV1>>;
  descriptors: Readonly<Record<string, {
    label: string;
    presentation?: AgentPresentation;
  }>>;
  ttlMs?: number;
  now?: () => number;
  reportHealth?: (agentId: string, update: {
    availability: 'ready' | 'degraded' | 'unavailable';
    message?: string;
    lastSuccessAt?: number;
  }) => void;
}

interface CacheEntry {
  at: number;
  data: AgentSubscriptionUsageSnapshot;
  lastGood: AgentSubscriptionUsageSnapshot | null;
  lastSuccessAt?: number;
  promise: Promise<AgentSubscriptionUsageSnapshot> | null;
  promiseRefresh: boolean;
}

const ID_RE = /^[a-z][a-z0-9._-]{0,127}$/;
const MAX_GROUPS = 64;
const MAX_WINDOWS = 8;
const MAX_EXPIRIES = 256;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: unknown, max = 256): value is string => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
);

function normalizeWindow(value: AgentSubscriptionUsageWindow): AgentSubscriptionUsageWindow | null {
  if (!value || !ID_RE.test(value.id) || !finite(value.usedPercent)) return null;
  const windowMinutes = finite(value.windowMinutes) && value.windowMinutes > 0
    ? value.windowMinutes : undefined;
  const resetsAt = finite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : undefined;
  return {
    id: value.id,
    ...(bounded(value.label) ? { label: value.label.trim() } : {}),
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function normalizeAdapterSnapshot(
  value: AgentSubscriptionUsageAdapterSnapshot,
): AgentSubscriptionUsageAdapterSnapshot | null {
  if (!value || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS
    || !['ready', 'pending', 'setup_required', 'unavailable'].includes(value.status)
    || (value.updatedAt !== null && (!finite(value.updatedAt) || value.updatedAt <= 0))) return null;
  const groupIds = new Set<string>();
  const groups: AgentSubscriptionUsageGroup[] = [];
  for (const group of value.groups) {
    if (!group || (group.kind !== 'account' && group.kind !== 'model')
      || !ID_RE.test(group.id) || groupIds.has(group.id) || !Array.isArray(group.windows)
      || group.windows.length === 0 || group.windows.length > MAX_WINDOWS) return null;
    groupIds.add(group.id);
    const windowIds = new Set<string>();
    const windows: AgentSubscriptionUsageWindow[] = [];
    for (const window of group.windows) {
      const normalized = normalizeWindow(window);
      if (!normalized || windowIds.has(normalized.id)) return null;
      windowIds.add(normalized.id);
      windows.push(normalized);
    }
    groups.push({
      kind: group.kind,
      id: group.id,
      ...(bounded(group.label) ? { label: group.label.trim() } : {}),
      windows,
    });
  }
  const account = value.account && bounded(value.account.label) ? {
    label: value.account.label.trim(),
    ...(bounded(value.account.plan) ? { plan: value.account.plan.trim() } : {}),
  } : undefined;
  const credits = value.resetCredits;
  if (credits && (!Number.isSafeInteger(credits.availableCount) || credits.availableCount < 0
    || !Array.isArray(credits.expiryTimes) || credits.expiryTimes.length > MAX_EXPIRIES)) return null;
  const resetCredits = credits ? {
      availableCount: credits.availableCount,
      expiryTimes: credits.expiryTimes.slice(0, MAX_EXPIRIES).filter((time) => finite(time) && time > 0)
        .sort((first, second) => first - second)
        .slice(0, credits.availableCount),
    } : undefined;
  const hasPayload = Boolean(account || groups.length || resetCredits);
  if ((value.status === 'ready') !== hasPayload) return null;
  if (value.status !== 'ready' && hasPayload) return null;
  if ((value.status === 'setup_required') !== bounded(value.setupCommand, 512)) return null;
  return {
    ...(account === undefined ? {} : { account }),
    groups,
    ...(resetCredits === undefined ? {} : { resetCredits }),
    updatedAt: value.updatedAt,
    status: value.status,
    ...(bounded(value.setupCommand, 512) ? { setupCommand: value.setupCommand.trim() } : {}),
  };
}

export class SubscriptionUsageService {
  readonly #adapters: ReadonlyMap<string, AgentSubscriptionUsageAdapterV1>;
  readonly #descriptors: SubscriptionUsageServiceOptions['descriptors'];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #reportHealth: NonNullable<SubscriptionUsageServiceOptions['reportHealth']>;

  constructor({
    adapters, descriptors, ttlMs = 15_000, now = Date.now, reportHealth = () => {},
  }: SubscriptionUsageServiceOptions) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || !adapters || !descriptors) {
      throw new TypeError('SubscriptionUsageService requires adapters, descriptors, and a valid TTL');
    }
    const entries = Object.entries(adapters);
    if (!entries.length) throw new TypeError('SubscriptionUsageService requires at least one adapter');
    for (const [agentId, adapter] of entries) {
      if (!ID_RE.test(agentId) || !adapter || adapter.apiVersion !== 1
        || typeof adapter.snapshot !== 'function' || !descriptors[agentId]
        || !bounded(descriptors[agentId]?.label)) {
        throw new TypeError(`Invalid Subscription Usage adapter: ${agentId}`);
      }
    }
    this.#adapters = new Map(entries);
    this.#descriptors = descriptors;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#reportHealth = reportHealth;
  }

  async snapshots({
    refresh = false,
    targetAgentId,
  }: { refresh?: boolean; targetAgentId?: string } = {}): Promise<AgentSubscriptionUsageSnapshot[]> {
    if (targetAgentId !== undefined && (!refresh || !this.#adapters.has(targetAgentId))) {
      throw new RangeError('Invalid Subscription Usage target');
    }
    const agentIds = targetAgentId === undefined ? [...this.#adapters.keys()] : [targetAgentId];
    const snapshots = await Promise.all(
      agentIds.map((agentId) => this.#snapshot(agentId, refresh)),
    );
    return snapshots.map((snapshot) => structuredClone(snapshot));
  }

  async #snapshot(agentId: string, refresh: boolean): Promise<AgentSubscriptionUsageSnapshot> {
    const now = this.#now();
    const cached = this.#cache.get(agentId);
    if (!refresh && cached?.data && now - cached.at < this.#ttlMs) return cached.data;
    if (cached?.promise) {
      if (refresh && !cached.promiseRefresh) {
        return cached.promise.then(() => this.#snapshot(agentId, true));
      }
      return cached.promise.then((snapshot) => {
        if (refresh || snapshot.refreshStatus === undefined) return snapshot;
        const { refreshStatus: _refreshStatus, ...plain } = snapshot;
        return plain;
      });
    }
    const descriptor = this.#descriptors[agentId]!;
    const adapter = this.#adapters.get(agentId)!;
    let invalid = false;
    const unavailable = (): AgentSubscriptionUsageSnapshot => ({
      agentId,
      label: descriptor.label.trim(),
      ...(descriptor.presentation?.iconId === undefined
        ? {} : { iconId: descriptor.presentation.iconId }),
      groups: [], updatedAt: null, status: 'unavailable',
    });
    const promise = Promise.resolve().then(() => adapter.snapshot({ refresh })).then((raw) => {
      const normalized = normalizeAdapterSnapshot(raw);
      if (!normalized) {
        invalid = true;
        throw new Error('invalid Subscription Usage snapshot');
      }
      const data: AgentSubscriptionUsageSnapshot = {
        agentId,
        label: descriptor.label.trim(),
        ...(descriptor.presentation?.iconId === undefined
          ? {} : { iconId: descriptor.presentation.iconId }),
        ...normalized,
      };
      const acceptedAt = this.#now();
      this.#cache.set(agentId, {
        at: acceptedAt, data, lastGood: data, lastSuccessAt: acceptedAt,
        promise: null, promiseRefresh: false,
      });
      try {
        this.#reportHealth(agentId, { availability: 'ready', lastSuccessAt: acceptedAt });
      } catch { /* health diagnostics cannot turn a valid provider snapshot into a failure */ }
      return refresh ? { ...data, refreshStatus: 'fresh' as const } : data;
    }).catch(() => {
      const data = cached?.lastGood ?? unavailable();
      this.#cache.set(agentId, {
        at: this.#now(), data, lastGood: cached?.lastGood ?? null,
        ...(cached?.lastSuccessAt === undefined ? {} : { lastSuccessAt: cached.lastSuccessAt }),
        promise: null, promiseRefresh: false,
      });
      try {
        this.#reportHealth(agentId, {
          availability: cached?.lastGood ? 'degraded' : 'unavailable',
          message: invalid ? 'invalid Subscription Usage snapshot' : 'Subscription Usage provider failed',
          ...(cached?.lastSuccessAt === undefined ? {} : { lastSuccessAt: cached.lastSuccessAt }),
        });
      } catch { /* diagnostics remain best effort */ }
      return refresh ? { ...data, refreshStatus: 'stale' as const } : data;
    });
    this.#cache.set(agentId, {
      at: cached?.at ?? 0,
      data: cached?.data ?? unavailable(),
      lastGood: cached?.lastGood ?? null,
      ...(cached?.lastSuccessAt === undefined ? {} : { lastSuccessAt: cached.lastSuccessAt }),
      promise, promiseRefresh: refresh,
    });
    return promise;
  }
}
