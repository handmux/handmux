import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './tmphome.js';

const require = createRequire(import.meta.url);
const {
  readLatestUsage, readSnapshot, writeSnapshot,
} = require('../src/codexUsageSnapshot.cjs');

function tokenCount(timestamp, usedPercent, total = 10, extra = {}) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 2,
          cached_input_tokens: 3,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1785600000 },
        secondary: null,
      },
      ...extra,
    },
  };
}

function rollout(home, name, rows) {
  const file = path.join(home, name);
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  return file;
}

describe('Codex usage snapshot', () => {
  it('reads the last token_count and normalizes the existing API shape', () => {
    const home = tmpHome('codex-snap-');
    const file = rollout(home, 'rollout.jsonl', [
      tokenCount('2026-07-23T01:00:00.000Z', 12, 20),
      { timestamp: '2026-07-23T01:01:00.000Z', payload: { type: 'message' } },
      tokenCount('2026-07-23T01:02:03.000Z', 21, 30),
    ]);

    expect(readLatestUsage(file)).toEqual({
      updatedAt: Date.parse('2026-07-23T01:02:03.000Z'),
      rateLimits: {
        primary: { usedPercent: 21, windowMinutes: 300, resetsAt: 1785600000 },
        secondary: null,
      },
      tokens: { total: 30, input: 28, cachedInput: 3, output: 2, reasoning: 1 },
      contextWindow: 258400,
    });
  });

  it('finds a token_count spanning a 64 KiB read boundary and ignores a damaged tail line', () => {
    const home = tmpHome('codex-snap-');
    const file = rollout(home, 'rollout.jsonl', [
      tokenCount('2026-07-23T02:00:00.000Z', 32, 40, { padding: '界'.repeat(30 * 1024) }),
      JSON.stringify({ payload: { type: 'message', text: 'y'.repeat(70 * 1024) } }),
      '{"timestamp":"unfinished"',
    ]);

    expect(readLatestUsage(file).rateLimits.primary.usedPercent).toBe(32);
  });

  it('returns a stable no-quota usage and leaves empty rollouts as no-ops', () => {
    const home = tmpHome('codex-snap-');
    const noQuota = tokenCount('2026-07-23T03:00:00.000Z', 0, 50);
    delete noQuota.payload.rate_limits;
    const file = rollout(home, 'rollout.jsonl', [noQuota]);
    const empty = rollout(home, 'empty.jsonl', [{ type: 'session_meta', payload: {} }]);

    expect(readLatestUsage(file).rateLimits).toEqual({ primary: null, secondary: null });
    expect(readLatestUsage(empty)).toBeNull();
  });

  it('persists checkedAt separately from usage and never lets an older session win', () => {
    const home = tmpHome('codex-snap-');
    const snapshotPath = path.join(home, 'codex-usage.json');
    const newer = rollout(home, 'newer.jsonl', [tokenCount('2026-07-23T05:00:00.000Z', 55)]);
    const older = rollout(home, 'older.jsonl', [tokenCount('2026-07-23T04:00:00.000Z', 44)]);

    writeSnapshot(snapshotPath, readLatestUsage(newer));
    writeSnapshot(snapshotPath, readLatestUsage(older));
    expect(readSnapshot(snapshotPath)).toMatchObject({
      checkedAt: 0,
      usage: {
        updatedAt: Date.parse('2026-07-23T05:00:00.000Z'),
        rateLimits: { primary: { usedPercent: 55 } },
      },
    });

    const current = readSnapshot(snapshotPath).usage;
    writeSnapshot(snapshotPath, current, { checkedAt: 1234 });
    expect(readSnapshot(snapshotPath)).toEqual({ version: 1, checkedAt: 1234, usage: current });
  });

  it('can record an empty full calibration without inventing usage', () => {
    const home = tmpHome('codex-snap-');
    const snapshotPath = path.join(home, 'codex-usage.json');

    writeSnapshot(snapshotPath, null, { checkedAt: 9000 });

    expect(readSnapshot(snapshotPath)).toEqual({ version: 1, checkedAt: 9000, usage: null });
  });
});
