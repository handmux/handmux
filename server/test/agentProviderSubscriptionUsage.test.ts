import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tmpHome } from './tmphome.js';
import { claudeUsagePath } from '../src/usagePaths.js';
import { createClaudeSubscriptionUsageAdapter } from '../src/agents/claudeSubscriptionUsage.js';
import {
  createCodexSubscriptionUsageAdapter,
  fetchCodexSubscriptionUsage,
  readCodexSubscriptionUsage,
} from '../src/agents/codexSubscriptionUsage.js';
import { writeSnapshot } from '../src/codexUsageSnapshot.js';
import { SubscriptionUsageService } from '../src/agent-runtime/subscriptionUsage.js';

describe('built-in Subscription Usage adapters', () => {
  const rollout = (timestamp: string, usedPercent: number) => JSON.stringify({
    timestamp, type: 'event_msg', payload: {
      type: 'token_count', info: {
        total_token_usage: { total_tokens: usedPercent }, model_context_window: 100,
      },
      rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 4_000 } },
    },
  });
  it('points missing Claude usage setup at the unified Agent command', async () => {
    const adapter = createClaudeSubscriptionUsageAdapter({ home: tmpHome('claude-usage-setup-') });
    expect(await adapter.snapshot()).toEqual({
      groups: [], updatedAt: null, status: 'setup_required',
      setupCommand: 'handmux agent enable claude',
    });
  });

  it('normalizes Claude account and model windows from its statusLine snapshot', async () => {
    const home = tmpHome('claude-usage-adapter-');
    fs.mkdirSync(path.dirname(claudeUsagePath(home)), { recursive: true });
    fs.writeFileSync(claudeUsagePath(home), JSON.stringify({
      updatedAt: 2_000,
      rateLimits: {
        fiveHour: { usedPercent: 20, resetsAt: 3_000 },
        sevenDay: { usedPercent: 30, resetsAt: 4_000 },
        sevenDayOpus: { usedPercent: 40, resetsAt: 5_000 },
      },
    }));
    const adapter = createClaudeSubscriptionUsageAdapter({ home });
    expect(await adapter.snapshot()).toEqual({
      groups: [{ kind: 'account', id: 'account', windows: [
        { id: 'five-hour', usedPercent: 20, windowMinutes: 300, resetsAt: 3_000 },
        { id: 'weekly', usedPercent: 30, windowMinutes: 10_080, resetsAt: 4_000 },
      ] }, { kind: 'model', id: 'opus', label: 'Opus', windows: [
        { id: 'weekly', usedPercent: 40, windowMinutes: 10_080, resetsAt: 5_000 },
      ] }],
      updatedAt: 2_000, status: 'ready',
    });
    expect(adapter.legacySnapshot()).toEqual({
      updatedAt: 2_000,
      rateLimits: {
        fiveHour: { usedPercent: 20, resetsAt: 3_000 },
        sevenDay: { usedPercent: 30, resetsAt: 4_000 },
        sevenDayOpus: { usedPercent: 40, resetsAt: 5_000 },
      },
    });
  });

  it('uses rollout fallback, merges in-flight fetches, and does not success-cache failures', async () => {
    const home = tmpHome('codex-usage-adapter-');
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '29');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), JSON.stringify({
      timestamp: '2026-08-29T00:00:00.000Z', type: 'event_msg', payload: {
        type: 'token_count', info: { total_token_usage: {}, model_context_window: 100 },
        rate_limits: { primary: { used_percent: 7, window_minutes: 300, resets_at: 4_000 } },
      },
    }));
    let now = Date.parse('2026-08-29T00:01:00.000Z');
    let resolveAccount!: (value: null) => void;
    const fetchAccount = vi.fn(() => new Promise<null>((resolve) => { resolveAccount = resolve; }));
    const adapter = createCodexSubscriptionUsageAdapter({
      home, now: () => now, calibrationMs: 0, fetchAccount,
    });
    const first = adapter.snapshot();
    const concurrent = adapter.snapshot();
    await Promise.resolve();
    expect(fetchAccount).toHaveBeenCalledOnce();
    resolveAccount(null);
    const snapshots = await Promise.all([first, concurrent]);
    expect(snapshots[0].groups[0]?.windows[0]).toMatchObject({ usedPercent: 7, windowMinutes: 300 });
    const retry = adapter.snapshot();
    await Promise.resolve();
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    resolveAccount(null);
    await retry;
  });

  it('lets the Core failure TTL throttle Codex account retries to 15s', async () => {
    const home = tmpHome('codex-core-failure-');
    let now = 1_000;
    const fetchAccount = vi.fn(async () => null);
    const adapter = createCodexSubscriptionUsageAdapter({ home, now: () => now, fetchAccount });
    const service = new SubscriptionUsageService({
      adapters: { codex: adapter }, descriptors: { codex: { label: 'Codex CLI' } },
      ttlMs: 15_000, now: () => now,
    });
    await service.snapshots();
    now = 15_999;
    await service.snapshots();
    expect(fetchAccount).toHaveBeenCalledOnce();
    now = 16_001;
    await service.snapshots();
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it('selects newest usage across sessions, calibrates, and never rolls a newer snapshot back', () => {
    const home = tmpHome('codex-rollouts-');
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '29');
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, 'rollout-old.jsonl');
    const newer = path.join(dir, 'rollout-new.jsonl');
    fs.writeFileSync(older, rollout('2026-08-29T00:00:00.000Z', 10));
    fs.writeFileSync(newer, rollout('2026-08-29T00:01:00.000Z', 20));
    expect(readCodexSubscriptionUsage(home, { now: 1_000, calibrationMs: 60_000 })
      ?.rateLimits.primary?.usedPercent).toBe(20);
    fs.appendFileSync(older, `\n${rollout('2026-08-29T00:02:00.000Z', 30)}`);
    expect(readCodexSubscriptionUsage(home, { now: 30_000, calibrationMs: 60_000 })
      ?.rateLimits.primary?.usedPercent).toBe(20);
    expect(readCodexSubscriptionUsage(home, { now: 61_001, calibrationMs: 60_000 })
      ?.rateLimits.primary?.usedPercent).toBe(30);
    writeSnapshot(path.join(home, '.handmux', 'codex-usage.json'), {
      updatedAt: Date.parse('2026-08-29T00:03:00.000Z'),
      rateLimits: { primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 4_000 }, secondary: null },
      tokens: { total: 40, input: null, cachedInput: null, output: null, reasoning: null },
      contextWindow: 100,
    });
    expect(readCodexSubscriptionUsage(home, { now: 122_000, calibrationMs: 60_000 })
      ?.rateLimits.primary?.usedPercent).toBe(40);
  });

  it('forces both Codex account and rollout caches on explicit refresh', async () => {
    const home = tmpHome('codex-manual-refresh-');
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '31');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-refresh.jsonl');
    fs.writeFileSync(file, rollout('2026-08-31T00:00:00.000Z', 10));
    let accountUsed = 20;
    const fetchAccount = vi.fn(async () => ({
      account: null,
      rateLimits: {
        primary: { usedPercent: accountUsed, windowMinutes: 300, resetsAt: 4_000 }, secondary: null,
      },
      modelRateLimits: [], resetCredits: null,
    }));
    const adapter = createCodexSubscriptionUsageAdapter({
      home, now: () => 1_000, calibrationMs: 60_000, accountTtlMs: 60_000, fetchAccount,
    });

    expect((await adapter.snapshot()).groups[0]?.windows[0]?.usedPercent).toBe(20);
    accountUsed = 30;
    fs.appendFileSync(file, `\n${rollout('2026-08-31T00:01:00.000Z', 40)}`);
    expect((await adapter.snapshot()).groups[0]?.windows[0]?.usedPercent).toBe(20);
    expect(fetchAccount).toHaveBeenCalledOnce();

    expect((await adapter.snapshot({ refresh: true })).groups[0]?.windows[0]?.usedPercent).toBe(30);
    expect(fetchAccount).toHaveBeenCalledTimes(2);

    const rolloutOnly = createCodexSubscriptionUsageAdapter({
      home, now: () => 1_000, calibrationMs: 60_000, fetchAccount: async () => ({
        account: null,
        rateLimits: { primary: null, secondary: null },
        modelRateLimits: [], resetCredits: null,
      }),
    });
    await rolloutOnly.snapshot();
    expect(rolloutOnly.legacySnapshot()).toMatchObject({ tokens: { total: 40 } });
    fs.appendFileSync(file, `\n${rollout('2026-08-31T00:02:00.000Z', 50)}`);
    await rolloutOnly.snapshot();
    expect(rolloutOnly.legacySnapshot()).toMatchObject({ tokens: { total: 40 } });
    await rolloutOnly.snapshot({ refresh: true });
    expect(rolloutOnly.legacySnapshot()).toMatchObject({ tokens: { total: 50 } });
  });

  it('treats a null Codex force-fetch as failure while ordinary reads retain the last account', async () => {
    const account = {
      account: null,
      rateLimits: {
        primary: { usedPercent: 21, windowMinutes: 300, resetsAt: 4_000 }, secondary: null,
      },
      modelRateLimits: [], resetCredits: null,
    };
    const fetchAccount = vi.fn().mockResolvedValueOnce(account).mockResolvedValueOnce(null);
    const adapter = createCodexSubscriptionUsageAdapter({
      home: tmpHome('codex-null-refresh-'), now: () => 1_000, fetchAccount,
    });
    expect((await adapter.snapshot()).groups[0]?.windows[0]?.usedPercent).toBe(21);
    await expect(adapter.snapshot({ refresh: true })).rejects.toThrow('refresh failed');
    expect((await adapter.snapshot()).groups[0]?.windows[0]?.usedPercent).toBe(21);
  });

  it('runs a forced Codex account fetch after an in-flight normal fetch and merges forced waiters', async () => {
    const pending: Array<(value: {
      account: null;
      rateLimits: { primary: { usedPercent: number; windowMinutes: number; resetsAt: number }; secondary: null };
      modelRateLimits: never[];
      resetCredits: null;
    }) => void> = [];
    const fetchAccount = vi.fn(() => new Promise<{
      account: null;
      rateLimits: { primary: { usedPercent: number; windowMinutes: number; resetsAt: number }; secondary: null };
      modelRateLimits: never[];
      resetCredits: null;
    }>((resolve) => pending.push(resolve)));
    const adapter = createCodexSubscriptionUsageAdapter({
      home: tmpHome('codex-mixed-refresh-'), now: () => 1_000, fetchAccount,
    });
    const result = (usedPercent: number) => ({
      account: null as null,
      rateLimits: {
        primary: { usedPercent, windowMinutes: 300, resetsAt: 4_000 }, secondary: null as null,
      },
      modelRateLimits: [] as never[], resetCredits: null as null,
    });

    const normal = adapter.snapshot();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const firstRefresh = adapter.snapshot({ refresh: true });
    const secondRefresh = adapter.snapshot({ refresh: true });
    expect(fetchAccount).toHaveBeenCalledOnce();
    pending[0]!(result(11));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    pending[1]!(result(22));

    expect((await normal).groups[0]?.windows[0]?.usedPercent).toBe(11);
    const [first, second] = await Promise.all([firstRefresh, secondRefresh]);
    expect(first.groups[0]?.windows[0]?.usedPercent).toBe(22);
    expect(second).toEqual(first);
  });

  it('keeps authoritative Codex reset count and bounded separate expiries', async () => {
    let now = 2_000;
    const fetchAccount = vi.fn(async () => ({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      rateLimits: { primary: { usedPercent: 9, windowMinutes: 300, resetsAt: 3_000 }, secondary: null },
      modelRateLimits: [],
      resetCredits: { availableCount: 3, expiryTimes: [5_000, 4_000] },
    }));
    const adapter = createCodexSubscriptionUsageAdapter({
      home: tmpHome('codex-account-'), now: () => now, fetchAccount,
    });
    const snapshot = await adapter.snapshot();
    expect(snapshot).toMatchObject({
      account: { label: 'dev@example.com', plan: 'Pro' }, status: 'ready',
      resetCredits: { availableCount: 3, expiryTimes: [5_000, 4_000] },
    });
    expect(adapter.legacySnapshot()).toMatchObject({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      rateLimits: { primary: { usedPercent: 9 } },
      rateLimitResetCredits: { availableCount: 3, expiryTimes: [5_000, 4_000] },
      tokens: { total: null }, contextWindow: null,
    });
    now += 59_999;
    await adapter.snapshot();
    expect(fetchAccount).toHaveBeenCalledOnce();
    now += 2;
    await adapter.snapshot();
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });

  it('parses real Codex JSON-RPC stdio and never exposes sensitive account fields', async () => {
    const home = tmpHome('codex-stdio-');
    const script = path.join(home, 'fake-codex.cjs');
    fs.writeFileSync(script, `
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\\n')) >= 0) {
          const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
          if (message.method === 'account/read') process.stdout.write(JSON.stringify({ id: 2, result: {
            account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro', accessToken: 'secret' }
          } }) + '\\n');
          if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: 3, result: {
            rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4000 }, secondary: null },
            rateLimitsByLimitId: { spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 4, windowDurationMins: 10080 }, secondary: null } },
            rateLimitResetCredits: { availableCount: 2, credits: [
              { status: 'available', expiresAt: 6000 }, { status: 'consumed', expiresAt: 3000 },
              { status: 'available', expiresAt: 5000 }, { status: 'available', expiresAt: null }
            ] }
          } }) + '\\n');
        }
      });
    `);
    const result = await fetchCodexSubscriptionUsage({
      home, command: process.execPath, args: [script], timeoutMs: 1_000,
    });
    expect(result).toEqual({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      rateLimits: { primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 4_000 }, secondary: null },
      modelRateLimits: [{
        limitId: 'spark', limitName: 'Spark',
        primary: { usedPercent: 4, windowMinutes: 10_080, resetsAt: null }, secondary: null,
      }],
      resetCredits: { availableCount: 2, expiryTimes: [5_000, 6_000] },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    const coreDto = await createCodexSubscriptionUsageAdapter({
      home, now: () => 2_000, fetchAccount: async () => result,
    }).snapshot();
    expect(coreDto.account).toEqual({ label: 'dev@example.com', plan: 'Pro' });
    expect(coreDto).not.toHaveProperty('tokens');
    expect(JSON.stringify(coreDto)).not.toMatch(/accessToken|secret/);
  });

  it('filters complete JSON-RPC model and credit details before bounding the Core DTO', async () => {
    const home = tmpHome('codex-stdio-bounds-');
    const script = path.join(home, 'fake-codex-bounds.cjs');
    const validModels = Array.from({ length: 63 }, (_, index) => ({
      limitId: `model-${index}`, limitName: `Model ${index}`,
      primary: { usedPercent: index, windowDurationMins: 300 }, secondary: null,
    }));
    const rateLimitsByLimitId = Object.fromEntries([
      ['main', {
        limitId: 'codex', limitName: 'Main',
        primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: null,
      }],
      ['model-0', validModels[0]],
      ['duplicate-model-0', { ...validModels[0], limitName: 'Duplicate' }],
      ['empty', { limitId: 'empty', limitName: 'Empty', primary: null, secondary: null }],
      ...validModels.slice(1).map((model) => [model.limitId, model] as const),
    ]);
    const validExpiryTimes = Array.from({ length: 300 }, (_, index) => 10_000 + index);
    const credits = [
      ...Array.from({ length: 260 }, () => ({ status: 'consumed', expiresAt: null })),
      ...[...validExpiryTimes].reverse().map((expiresAt) => ({ status: 'available', expiresAt })),
    ];
    const rateLimitsResult = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4_000 },
        secondary: null,
      },
      rateLimitsByLimitId,
      rateLimitResetCredits: { availableCount: 300, credits },
    };
    fs.writeFileSync(script, `
      const rateLimitsResult = ${JSON.stringify(rateLimitsResult)};
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\\n')) >= 0) {
          const message = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
          if (message.method === 'account/read') process.stdout.write(JSON.stringify({ id: 2, result: {
            account: { type: 'chatgpt', email: 'bounds@example.com', planType: 'pro' }
          } }) + '\\n');
          if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({
            id: 3, result: rateLimitsResult
          }) + '\\n');
        }
      });
    `);

    const fetched = await fetchCodexSubscriptionUsage({
      home, command: process.execPath, args: [script], timeoutMs: 1_000,
    });
    if (!fetched) throw new Error('expected JSON-RPC fixture to return usage');
    expect(fetched.modelRateLimits).toHaveLength(63);
    expect(fetched.modelRateLimits.map((model) => model.limitId)).toEqual(
      validModels.map((model) => model.limitId),
    );
    expect(fetched.resetCredits).toEqual({ availableCount: 300, expiryTimes: validExpiryTimes });

    const adapter = createCodexSubscriptionUsageAdapter({
      home, now: () => 2_000, fetchAccount: async () => fetched,
    });
    const coreDto = await adapter.snapshot();
    expect(coreDto.groups).toHaveLength(64);
    expect(coreDto.groups.filter((group) => group.kind === 'model')).toHaveLength(63);
    expect(coreDto.resetCredits).toEqual({
      availableCount: 300, expiryTimes: validExpiryTimes.slice(0, 256),
    });
    expect(adapter.legacySnapshot()).toMatchObject({
      modelRateLimits: fetched.modelRateLimits,
      rateLimitResetCredits: { availableCount: 300, expiryTimes: validExpiryTimes },
    });
  });

  it('reserves the 64-group Core bound for one account plus at most 63 models', async () => {
    const modelRateLimits = Array.from({ length: 70 }, (_, index) => ({
      limitId: `model-${index}`, limitName: null,
      primary: { usedPercent: index, windowMinutes: 300, resetsAt: null }, secondary: null,
    }));
    const snapshot = await createCodexSubscriptionUsageAdapter({
      home: tmpHome('codex-model-bound-'),
      fetchAccount: async () => ({
        account: null,
        rateLimits: { primary: { usedPercent: 1, windowMinutes: 300, resetsAt: null }, secondary: null },
        modelRateLimits, resetCredits: null,
      }),
    }).snapshot();
    expect(snapshot.groups).toHaveLength(64);
    expect(snapshot.groups.filter((group) => group.kind === 'model')).toHaveLength(63);
  });
});
