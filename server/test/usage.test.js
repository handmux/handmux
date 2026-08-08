import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpHome } from './tmphome.js';

const require = createRequire(import.meta.url);
const { writeSnapshot } = require('../src/codexUsageSnapshot.cjs');
import {
  readClaudeUsage, readCodexUsage, getUsage, getUsageCached, claudeUsagePath,
  readClaudeContext, claudeContextDir,
} from '../src/usage.js';

// Write a Codex rollout at sessions/YYYY/MM/DD/<name> with the given jsonl lines.
function writeRollout(home, y, m, d, name, lines) {
  const dir = path.join(home, '.codex', 'sessions', y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}
const tokenCount = (ts, usedPercent, totals, secondary = null) => ({
  timestamp: ts, type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: totals, model_context_window: 258400 },
    rate_limits: {
      primary: { used_percent: usedPercent, window_minutes: 43200, resets_at: 1785599998 },
      secondary,
    },
  },
});
const tokenCountWithoutQuota = (ts, totals) => ({
  timestamp: ts, type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: totals, model_context_window: 258400 },
  },
});

describe('readClaudeUsage', () => {
  it('reads the statusLine snapshot; null when missing or garbage', () => {
    const home = tmpHome('usg-');
    expect(readClaudeUsage(home)).toBeNull();
    fs.mkdirSync(path.dirname(claudeUsagePath(home)), { recursive: true });
    fs.writeFileSync(claudeUsagePath(home), JSON.stringify({
      updatedAt: 5, rateLimits: { fiveHour: { usedPercent: 42, resetsAt: 111 }, sevenDay: { usedPercent: 15 } },
    }));
    expect(readClaudeUsage(home)).toMatchObject({ rateLimits: { fiveHour: { usedPercent: 42 } } });
    fs.writeFileSync(claudeUsagePath(home), 'not json');
    expect(readClaudeUsage(home)).toBeNull();
  });
});

describe('readClaudeContext (per-session context-window snapshot)', () => {
  it('reads <sessionId>.json; null when missing', () => {
    const home = tmpHome('ctx-');
    expect(readClaudeContext('sess-1', home)).toBeNull();
    fs.mkdirSync(claudeContextDir(home), { recursive: true });
    fs.writeFileSync(path.join(claudeContextDir(home), 'sess-1.json'), JSON.stringify({ model: 'Opus 4.8', usedPercent: 24, updatedAt: 9 }));
    expect(readClaudeContext('sess-1', home)).toMatchObject({ model: 'Opus 4.8', usedPercent: 24 });
  });

  it('rejects an unsafe session id (path traversal) without reading', () => {
    const home = tmpHome('ctx-');
    expect(readClaudeContext('../claude-usage', home)).toBeNull();
    expect(readClaudeContext('a/b', home)).toBeNull();
    expect(readClaudeContext('', home)).toBeNull();
    expect(readClaudeContext(null, home)).toBeNull();
  });
});

describe('readCodexUsage', () => {
  it('null when Codex has never run', () => {
    expect(readCodexUsage(tmpHome('usg-'))).toBeNull();
  });

  it('picks the newest rollout and its LAST token_count (rate_limits + cumulative tokens)', () => {
    const home = tmpHome('usg-');
    // an older day + older file that should be ignored
    writeRollout(home, '2026', '07', '02', 'rollout-2026-07-02T10-00-00-a.jsonl', [
      tokenCount('2026-07-02T10:00:00.000Z', 5, { input_tokens: 1, total_tokens: 1 }),
    ]);
    // newest day, newest file, two token_counts — the LAST one wins
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T00-45-17-z.jsonl', [
      tokenCount('2026-07-03T00:45:00.000Z', 10, { input_tokens: 100, total_tokens: 110 }),
      { timestamp: '2026-07-03T00:45:10.000Z', type: 'response_item', payload: { type: 'x' } },
      tokenCount('2026-07-03T00:45:17.000Z', 16, {
        input_tokens: 21960, cached_input_tokens: 19712, output_tokens: 120, reasoning_output_tokens: 40, total_tokens: 22080,
      }),
    ]);
    const u = readCodexUsage(home);
    expect(u.rateLimits.primary).toEqual({ usedPercent: 16, windowMinutes: 43200, resetsAt: 1785599998 });
    expect(u.rateLimits.secondary).toBeNull();
    expect(u.tokens).toEqual({ total: 22080, input: 21960, cachedInput: 19712, output: 120, reasoning: 40 });
    expect(u.contextWindow).toBe(258400);
    expect(u.updatedAt).toBe(Date.parse('2026-07-03T00:45:17.000Z'));
  });

  it('maps a present secondary window too', () => {
    const home = tmpHome('usg-');
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T01-00-00-s.jsonl', [
      tokenCount('2026-07-03T01:00:00.000Z', 20, { total_tokens: 5 },
        { used_percent: 55, window_minutes: 300, resets_at: 1785600000 }),
    ]);
    expect(readCodexUsage(home).rateLimits.secondary).toEqual({ usedPercent: 55, windowMinutes: 300, resetsAt: 1785600000 });
  });

  it('keeps the latest machine-wide quota while a newer rollout has no token_count yet', () => {
    const home = tmpHome('usg-');
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T01-00-00-o.jsonl', [
      tokenCount('2026-07-03T01:00:00.000Z', 23, { total_tokens: 8 }),
    ]);
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T02-00-00-n.jsonl', [
      { timestamp: '2026-07-03T02:00:00.000Z', type: 'session_meta', payload: {} },
    ]);
    expect(readCodexUsage(home).rateLimits.primary.usedPercent).toBe(23);
  });

  it('uses the newest token_count across all sessions, not the newest-created rollout', () => {
    const home = tmpHome('usg-');
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T01-00-00-o.jsonl', [
      { timestamp: '2026-07-03T01:00:00.000Z', type: 'session_meta', payload: {} },
    ]);
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T02-00-00-n.jsonl', [
      tokenCount('2026-07-03T02:00:00.000Z', 24, { total_tokens: 9 }),
    ]);
    const olderSession = path.join(home, '.codex', 'sessions', '2026', '07', '03', 'rollout-2026-07-03T01-00-00-o.jsonl');
    fs.appendFileSync(olderSession, `\n${JSON.stringify(tokenCount('2026-07-03T03:00:00.000Z', 31, { total_tokens: 12 }))}`);
    expect(readCodexUsage(home).rateLimits.primary.usedPercent).toBe(31);
  });

  it('reports a stable no-quota state when the latest token_count has no rate_limits', () => {
    const home = tmpHome('usg-');
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T01-00-00-o.jsonl', [
      tokenCount('2026-07-03T01:00:00.000Z', 23, { total_tokens: 8 }),
    ]);
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T02-00-00-n.jsonl', [
      tokenCountWithoutQuota('2026-07-03T02:00:00.000Z', { total_tokens: 10 }),
    ]);
    expect(readCodexUsage(home).rateLimits).toEqual({ primary: null, secondary: null });
  });
});

describe('Codex persistent calibration snapshot', () => {
  it('returns the snapshot for 60 seconds without rereading a changed rollout', () => {
    const home = tmpHome('usg-snap-');
    const file = writeRollout(home, '2026', '07', '23', 'rollout-2026-07-23T01-00-00-a.jsonl', [
      tokenCount('2026-07-23T01:00:00.000Z', 18, { total_tokens: 10 }),
    ]);
    const first = readCodexUsage(home, { now: 1_000, calibrationMs: 60_000 });
    fs.writeFileSync(file, 'broken');

    expect(readCodexUsage(home, { now: 30_000, calibrationMs: 60_000 })).toEqual(first);
  });

  it('performs a rollout calibration after 60 seconds and sees new events', () => {
    const home = tmpHome('usg-snap-');
    const file = writeRollout(home, '2026', '07', '23', 'rollout-2026-07-23T02-00-00-a.jsonl', [
      tokenCount('2026-07-23T02:00:00.000Z', 20, { total_tokens: 10 }),
    ]);
    expect(readCodexUsage(home, { now: 1_000, calibrationMs: 60_000 }).rateLimits.primary.usedPercent).toBe(20);
    fs.appendFileSync(file, `\n${JSON.stringify(tokenCount('2026-07-23T02:01:00.000Z', 37, { total_tokens: 20 }))}`);

    expect(readCodexUsage(home, { now: 30_000, calibrationMs: 60_000 }).rateLimits.primary.usedPercent).toBe(20);
    expect(readCodexUsage(home, { now: 61_001, calibrationMs: 60_000 }).rateLimits.primary.usedPercent).toBe(37);
  });

  it('never lets a full scan roll a newer cached snapshot back', () => {
    const home = tmpHome('usg-snap-');
    writeRollout(home, '2026', '07', '23', 'rollout-2026-07-23T03-00-00-a.jsonl', [
      tokenCount('2026-07-23T03:00:00.000Z', 30, { total_tokens: 10 }),
    ]);
    const snapshotPath = path.join(home, '.handmux', 'codex-usage.json');
    const cachedUsage = {
      updatedAt: Date.parse('2026-07-23T04:00:00.000Z'),
      rateLimits: { primary: { usedPercent: 45, windowMinutes: 300, resetsAt: 1785600000 }, secondary: null },
      tokens: { total: 20, input: null, cachedInput: null, output: null, reasoning: null },
      contextWindow: 258400,
    };
    writeSnapshot(snapshotPath, cachedUsage);

    expect(readCodexUsage(home, { now: 61_001, calibrationMs: 60_000 })).toEqual(cachedUsage);
  });

  it('records an empty calibration so a newly-created rollout waits for the next interval', () => {
    const home = tmpHome('usg-snap-');
    expect(readCodexUsage(home, { now: 1_000, calibrationMs: 60_000 })).toBeNull();
    writeRollout(home, '2026', '07', '23', 'rollout-2026-07-23T05-00-00-a.jsonl', [
      tokenCount('2026-07-23T05:00:00.000Z', 50, { total_tokens: 10 }),
    ]);

    expect(readCodexUsage(home, { now: 30_000, calibrationMs: 60_000 })).toBeNull();
    expect(readCodexUsage(home, { now: 61_001, calibrationMs: 60_000 })).not.toBeNull();
  });
});

describe('getUsage / getUsageCached', () => {
  it('prefers the official Codex account limit over a Spark rollout limit', async () => {
    const home = tmpHome('usg-official-');
    writeRollout(home, '2026', '07', '23', 'rollout-2026-07-23T09-00-00-spark.jsonl', [
      tokenCount('2026-07-23T09:00:00.000Z', 8, { total_tokens: 9 }),
    ]);
    const fakeAppServer = path.join(home, 'fake-codex-app-server.cjs');
    fs.writeFileSync(fakeAppServer, `
      let pending = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
          }
          if (message.method === 'account/rateLimits/read') {
            process.stdout.write(JSON.stringify({
              id: message.id,
              result: {
                rateLimits: {
                  primary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 1785258130 },
                  secondary: null,
                },
              },
            }) + '\\n');
          }
        }
      });
    `);

    const usage = await getUsage(home, {
      now: 1234,
      codexCommand: process.execPath,
      codexArgs: [fakeAppServer],
      codexTimeoutMs: 1000,
    });

    expect(usage.codex.rateLimits.primary).toEqual({
      usedPercent: 51,
      windowMinutes: 10080,
      resetsAt: 1785258130,
    });
  });

  it('bundles both agents (either may be null)', async () => {
    const home = tmpHome('usg-');
    const u = await getUsage(home, { codexCommand: '/missing-codex-for-test' });
    expect(u).toEqual({ claude: null, codex: null });
  });

  it('caches within the ttl and refreshes after it', async () => {
    const home = tmpHome('usg-');
    const options = { ttlMs: 1000, now: 1000, codexCommand: '/missing-codex-for-test' };
    const a = await getUsageCached(home, options);
    // add a codex rollout AFTER the first (cached) read
    writeRollout(home, '2026', '07', '03', 'rollout-2026-07-03T03-00-00-c.jsonl', [
      tokenCount('2026-07-03T03:00:00.000Z', 7, { total_tokens: 9 }),
    ]);
    expect(await getUsageCached(home, { ...options, now: 1500 })).toBe(a); // still cached → codex null
    expect((await getUsageCached(home, { ...options, now: 62_000 })).codex).not.toBeNull(); // calibration passed → rescanned
  });
});
