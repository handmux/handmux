import { describe, expect, it, vi } from 'vitest';
import { SubscriptionUsageService } from '../src/agent-runtime/subscriptionUsage.js';
import type { AgentSubscriptionUsageAdapterSnapshot } from '../src/agent-runtime/subscriptionUsage.js';

describe('SubscriptionUsageService', () => {
  it('owns identity, validation, clamping, TTL, and in-flight request sharing', async () => {
    let resolveSnapshot: ((value: AgentSubscriptionUsageAdapterSnapshot) => void) | undefined;
    const snapshot = vi.fn(() => new Promise<AgentSubscriptionUsageAdapterSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    }));
    let now = 1_000;
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot } },
      descriptors: { codex: { label: 'Codex CLI', presentation: { iconId: 'codex' } } },
      ttlMs: 500,
      now: () => now,
    });

    const first = service.snapshots();
    const concurrent = service.snapshots();
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledTimes(1);
    resolveSnapshot?.({
      account: { label: 'dev@example.com', plan: 'Pro' },
      groups: [{ kind: 'account', id: 'account', windows: [
        { id: 'primary', usedPercent: 140, windowMinutes: 300, resetsAt: 2_000 },
      ] }],
      resetCredits: { availableCount: 1, expiryTimes: [3_000, 2_000] },
      updatedAt: 900,
      status: 'ready',
    });
    const [one, two] = await Promise.all([first, concurrent]);
    expect(one).toEqual(two);
    expect(one).toEqual([{
      agentId: 'codex', label: 'Codex CLI', iconId: 'codex',
      account: { label: 'dev@example.com', plan: 'Pro' },
      groups: [{ kind: 'account', id: 'account', windows: [{
        id: 'primary', usedPercent: 100, windowMinutes: 300, resetsAt: 2_000,
      }] }],
      resetCredits: { availableCount: 1, expiryTimes: [2_000] },
      updatedAt: 900, status: 'ready',
    }]);

    await service.snapshots();
    expect(snapshot).toHaveBeenCalledTimes(1);
    now = 1_501;
    const refreshed = service.snapshots();
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledTimes(2);
    resolveSnapshot?.({ groups: [], updatedAt: null, status: 'pending' });
    await refreshed;
  });

  it('contains adapter failures as a generic unavailable snapshot', async () => {
    const health = vi.fn();
    const service = new SubscriptionUsageService({
      adapters: { claude: { apiVersion: 1, snapshot: async () => { throw new Error('provider secret'); } } },
      descriptors: { claude: { label: 'Claude Code' } },
      reportHealth: health,
    });
    expect(await service.snapshots()).toEqual([{
      agentId: 'claude', label: 'Claude Code', groups: [], updatedAt: null, status: 'unavailable',
    }]);
    expect(health).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      availability: 'unavailable', message: 'Subscription Usage provider failed',
    }));
  });

  it('bypasses the Core TTL on explicit refresh and shares an in-flight refresh', async () => {
    let resolveRefresh: ((value: AgentSubscriptionUsageAdapterSnapshot) => void) | undefined;
    const snapshot = vi.fn(async ({ refresh = false }: { refresh?: boolean } = {}) => {
      if (!refresh) return {
        groups: [{ kind: 'account' as const, id: 'account', windows: [{ id: 'primary', usedPercent: 1 }] }],
        updatedAt: 1_000, status: 'ready' as const,
      };
      return new Promise<AgentSubscriptionUsageAdapterSnapshot>((resolve) => { resolveRefresh = resolve; });
    });
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot } },
      descriptors: { codex: { label: 'Codex CLI' } },
      ttlMs: 60_000,
      now: () => 1_000,
    });

    await service.snapshots();
    const first = service.snapshots({ refresh: true });
    const concurrent = service.snapshots({ refresh: true });
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenLastCalledWith({ refresh: true });
    resolveRefresh?.({
      groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 2 }] }],
      updatedAt: 1_001, status: 'ready',
    });
    const [one, two] = await Promise.all([first, concurrent]);
    expect(one).toEqual(two);
    expect(one[0]?.groups[0]?.windows[0]?.usedPercent).toBe(2);
    expect(one[0]?.refreshStatus).toBe('fresh');
    expect((await service.snapshots())[0]).not.toHaveProperty('refreshStatus');
  });

  it('refreshes only the explicitly targeted adapter and returns only that snapshot', async () => {
    const claude = vi.fn(async () => ({
      groups: [{ kind: 'account' as const, id: 'account', windows: [{ id: 'primary', usedPercent: 1 }] }],
      updatedAt: 1_000, status: 'ready' as const,
    }));
    const codex = vi.fn(async () => ({
      groups: [{ kind: 'account' as const, id: 'account', windows: [{ id: 'primary', usedPercent: 2 }] }],
      updatedAt: 1_000, status: 'ready' as const,
    }));
    const service = new SubscriptionUsageService({
      adapters: {
        claude: { apiVersion: 1, snapshot: claude },
        codex: { apiVersion: 1, snapshot: codex },
      },
      descriptors: { claude: { label: 'Claude Code' }, codex: { label: 'Codex CLI' } },
      ttlMs: 60_000,
      now: () => 1_000,
    });

    await service.snapshots();
    const targeted = await service.snapshots({ refresh: true, targetAgentId: 'codex' });
    expect(targeted).toHaveLength(1);
    expect(targeted[0]).toMatchObject({ agentId: 'codex', refreshStatus: 'fresh' });
    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(2);
    expect(codex).toHaveBeenLastCalledWith({ refresh: true });
    await expect(service.snapshots({ targetAgentId: 'codex' })).rejects.toThrow(RangeError);
    await expect(service.snapshots({ refresh: true, targetAgentId: 'unknown' })).rejects.toThrow(RangeError);
  });

  it('marks an explicit provider failure stale without caching the transient refresh status', async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce({
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 7 }] }],
        updatedAt: 1_000, status: 'ready',
      })
      .mockRejectedValueOnce(new Error('offline'));
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot } },
      descriptors: { codex: { label: 'Codex CLI' } },
      ttlMs: 60_000,
      now: () => 1_000,
    });
    await service.snapshots();

    const [stale] = await service.snapshots({ refresh: true });
    expect(stale).toMatchObject({ refreshStatus: 'stale' });
    expect(stale?.groups[0]?.windows[0]?.usedPercent).toBe(7);
    const [cached] = await service.snapshots();
    expect(cached?.groups[0]?.windows[0]?.usedPercent).toBe(7);
    expect(cached).not.toHaveProperty('refreshStatus');
  });

  it('runs a forced read after an in-flight normal read while merging forced waiters', async () => {
    const pending: Array<{
      refresh: boolean;
      resolve: (value: AgentSubscriptionUsageAdapterSnapshot) => void;
    }> = [];
    const snapshot = vi.fn(({ refresh = false }: { refresh?: boolean } = {}) => (
      new Promise<AgentSubscriptionUsageAdapterSnapshot>((resolve) => pending.push({ refresh, resolve }))
    ));
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot } },
      descriptors: { codex: { label: 'Codex CLI' } },
    });

    const normal = service.snapshots();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const firstRefresh = service.snapshots({ refresh: true });
    const secondRefresh = service.snapshots({ refresh: true });
    expect(snapshot).toHaveBeenCalledOnce();
    pending[0]!.resolve({
      groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 1 }] }],
      updatedAt: 1_000, status: 'ready',
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.refresh).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({
      groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 2 }] }],
      updatedAt: 1_001, status: 'ready',
    });

    expect((await normal)[0]).not.toHaveProperty('refreshStatus');
    const [first, second] = await Promise.all([firstRefresh, secondRefresh]);
    expect(first[0]).toMatchObject({ refreshStatus: 'fresh' });
    expect(second).toEqual(first);
    expect(first[0]?.groups[0]?.windows[0]?.usedPercent).toBe(2);
  });

  it('throttles first failure, keeps last-good stale, and recovers after TTL', async () => {
    let now = 1_000;
    let call = 0;
    const health = vi.fn();
    const snapshot = vi.fn(async (): Promise<AgentSubscriptionUsageAdapterSnapshot> => {
      call += 1;
      if (call === 2) throw new Error('offline');
      return {
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: call }] }],
        updatedAt: now, status: 'ready',
      };
    });
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot } },
      descriptors: { codex: { label: 'Codex CLI' } },
      ttlMs: 100, now: () => now, reportHealth: health,
    });
    expect((await service.snapshots())[0]?.groups[0]?.windows[0]?.usedPercent).toBe(1);
    now = 1_101;
    expect((await service.snapshots())[0]?.groups[0]?.windows[0]?.usedPercent).toBe(1);
    expect(health).toHaveBeenLastCalledWith('codex', expect.objectContaining({
      availability: 'degraded', lastSuccessAt: 1_000,
    }));
    await service.snapshots();
    expect(snapshot).toHaveBeenCalledTimes(2);
    now = 1_202;
    expect((await service.snapshots())[0]?.groups[0]?.windows[0]?.usedPercent).toBe(3);
    expect(health).toHaveBeenLastCalledWith('codex', expect.objectContaining({ availability: 'ready' }));
  });

  it.each([
    { groups: [{ kind: 'account', id: 'same', windows: [{ id: 'a', usedPercent: 1 }] },
      { kind: 'model', id: 'same', windows: [{ id: 'b', usedPercent: 2 }] }], updatedAt: 1, status: 'ready' },
    { groups: [{ kind: 'account', id: 'account', windows: [
      { id: 'same', usedPercent: 1 }, { id: 'same', usedPercent: 2 },
    ] }], updatedAt: 1, status: 'ready' },
    { groups: [], resetCredits: { availableCount: 1, expiryTimes: Array(257).fill(1) }, updatedAt: 1, status: 'ready' },
    { groups: [], updatedAt: 1, status: 'ready' },
    { groups: [{ kind: 'account', id: 'account', windows: [{ id: 'a', usedPercent: 1 }] }], updatedAt: 1, status: 'pending' },
  ])('rejects invalid IDs, bounds, and status/payload invariants', async (raw) => {
    const health = vi.fn();
    const service = new SubscriptionUsageService({
      adapters: { codex: { apiVersion: 1, snapshot: async () => raw as AgentSubscriptionUsageAdapterSnapshot } },
      descriptors: { codex: { label: 'Codex CLI' } }, reportHealth: health,
    });
    expect((await service.snapshots())[0]?.status).toBe('unavailable');
    expect(health).toHaveBeenLastCalledWith('codex', expect.objectContaining({
      availability: 'unavailable', message: 'invalid Subscription Usage snapshot',
    }));
  });
});
