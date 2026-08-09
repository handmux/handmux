// Usage/quota reader for the phone's Usage page:
//   • Claude — the snapshot the statusLine capturer writes to ~/.handmux/claude-usage.json. Claude Code's
//     statusLine stdin is the ONLY documented local source of the 5h/weekly rate-limit % (see
//     server/hooks/handmux-statusline.cjs). Absent until the user opts the capturer in → returns null.
//   • Codex — account limits come from Codex's local app-server (which owns auth); rollout snapshots provide
//     cumulative tokens/context and remain the fallback when that stable local method is unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pocketHome } from './cli/state.js';
import { PrivateStateStore } from './privateStateStore.js';

import {
  readLatestUsage, readSnapshot, writeSnapshot,
} from './codexUsageSnapshot.js';
import type { CodexUsage, UsageRateLimitWindow } from './codexUsageSnapshot.js';

export interface ClaudeContextSnapshot {
  model?: string;
  usedPercent?: number;
  updatedAt?: number;
}

export interface CodexRateLimits {
  primary: UsageRateLimitWindow | null;
  secondary: UsageRateLimitWindow | null;
}

export interface UsageOptions {
  now?: number;
  calibrationMs?: number;
  codexCommand?: string;
  codexArgs?: readonly string[];
  codexTimeoutMs?: number;
  codexRateLimitsTtlMs?: number;
  ttlMs?: number;
}

export interface UsageSummary {
  claude: Record<string, unknown> | null;
  codex: CodexUsage | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function claudeUsagePath(home: string = homedir()): string { return path.join(pocketHome(home), 'claude-usage.json'); }
export function claudeContextDir(home: string = homedir()): string { return path.join(pocketHome(home), 'context'); }

// Per-session context-window snapshot the statusLine capturer writes to ~/.handmux/context/<sessionId>.json
// ({ model, usedPercent, updatedAt }). null if the capturer isn't wired, the session never rendered, or the
// id is unsafe. Used to show the CURRENT pane's context % (the global claude-usage.json can't — it's one
// last-writer-wins snapshot across all sessions). sessionId is sanitised to keep the read inside the dir.
export function readClaudeContext(sessionId: unknown, home: string = homedir()): ClaudeContextSnapshot | null {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return null;
  try {
    const snap = new PrivateStateStore<unknown>(
      path.join(claudeContextDir(home), `${sessionId}.json`),
    ).read();
    if (!isRecord(snap)) return null;
    const context: ClaudeContextSnapshot = {};
    if (typeof snap.model === 'string') context.model = snap.model;
    if (finiteNumber(snap.usedPercent)) context.usedPercent = snap.usedPercent;
    if (finiteNumber(snap.updatedAt)) context.updatedAt = snap.updatedAt;
    return context;
  } catch { return null; }
}
export function codexSessionsDir(home: string = homedir()): string { return path.join(home, '.codex', 'sessions'); }
export function codexUsagePath(home: string = homedir()): string { return path.join(pocketHome(home), 'codex-usage.json'); }

// Claude: read the statusLine snapshot. null if the capturer isn't wired / never populated it.
export function readClaudeUsage(home: string = homedir()): Record<string, unknown> | null {
  try {
    const snap = new PrivateStateStore<unknown>(claudeUsagePath(home)).read();
    return isRecord(snap) ? snap : null;
  } catch { return null; }
}

// Usage is machine-wide, not owned by whichever session happened to be created last. Enumerate rollout
// files by modification time: an active older session can be newer than a freshly-created rollout, while
// a new rollout may have no token_count until its first response. Once a file's mtime is older than the
// newest event already found, no remaining file can contain a newer event, so the scan stays bounded.
interface RolloutFile { file: string; mtimeMs: number }

function rolloutFilesByMtime(dir: string): RolloutFile[] {
  const files: RolloutFile[] = [];
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* file raced away */ }
      }
    }
  };
  visit(dir);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Zero-config reconciliation runs at most once per calibration interval and updates a persistent cache.
function scanCodexUsage(home: string): CodexUsage | null {
  let latest: CodexUsage | null = null;
  for (const { file, mtimeMs } of rolloutFilesByMtime(codexSessionsDir(home))) {
    if (latest?.updatedAt && mtimeMs < latest.updatedAt) break;
    const usage = readLatestUsage(file);
    if (usage && (!latest || usage.updatedAt > latest.updatedAt)) latest = usage;
  }
  return latest;
}

// Prefer the machine-wide cache. A bounded rollout scan refreshes it at most once per minute; App Server
// supplies live account rate limits separately below.
export function readCodexUsage(
  home: string = homedir(),
  { now = Date.now(), calibrationMs = 60_000 }: UsageOptions = {},
): CodexUsage | null {
  const file = codexUsagePath(home);
  const snapshot = readSnapshot(file);
  if (snapshot && (now - snapshot.checkedAt) < calibrationMs) return snapshot.usage;

  const scanned = scanCodexUsage(home);
  writeSnapshot(file, scanned, { checkedAt: now });
  return readSnapshot(file)?.usage || null;
}

function normalizeRateLimitWindow(value: unknown): UsageRateLimitWindow | null {
  if (!isRecord(value) || !finiteNumber(value.usedPercent)) return null;
  return {
    usedPercent: value.usedPercent,
    windowMinutes: finiteNumber(value.windowDurationMins) ? value.windowDurationMins : null,
    resetsAt: finiteNumber(value.resetsAt) ? value.resetsAt : null,
  };
}

// Query the same stable local account method used by Codex's own rich clients. The child process reuses
// Codex's auth internally; handmux neither reads nor receives credentials. Every failure is a null fallback.
export function fetchCodexRateLimits(
  home: string = homedir(),
  {
    codexCommand = 'codex',
    codexArgs = ['app-server', '--stdio'],
    codexTimeoutMs = 5000,
  }: UsageOptions = {},
): Promise<CodexRateLimits | null> {
  return new Promise<CodexRateLimits | null>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let settled = false;
    let stdout = '';

    const finish = (value: CodexRateLimits | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* best effort */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), codexTimeoutMs);
    try {
      child = spawn(codexCommand, codexArgs, {
        env: { ...process.env, CODEX_HOME: path.join(home, '.codex') },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }

    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        finish(null);
        return;
      }
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
          child?.stdin?.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 2 })}\n`);
        } else if (message.id === 2) {
          const result = isRecord(message.result) ? message.result : null;
          const source = result && isRecord(result.rateLimits) ? result.rateLimits : null;
          if (!source) {
            finish(null);
            return;
          }
          finish({
            primary: normalizeRateLimitWindow(source.primary),
            secondary: normalizeRateLimitWindow(source.secondary),
          });
          return;
        }
      }
    });

    child.stdin?.on('error', () => finish(null));
    child.stdin?.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'handmux', title: 'handmux', version: '0.0.0' } },
    })}\n`);
  });
}

interface CodexLimitsCache {
  at: number;
  home: string | null;
  data: CodexRateLimits | null;
  ready: boolean;
  promise: Promise<CodexRateLimits | null> | null;
}

let _codexLimitsCache: CodexLimitsCache = {
  at: 0, home: null, data: null, ready: false, promise: null,
};

async function getCodexRateLimitsCached(
  home: string,
  {
    now = Date.now(),
    codexRateLimitsTtlMs = 60_000,
    ...fetchOptions
  }: UsageOptions = {},
): Promise<CodexRateLimits | null> {
  if (_codexLimitsCache.home === home
    && _codexLimitsCache.ready
    && (now - _codexLimitsCache.at) < codexRateLimitsTtlMs) {
    return _codexLimitsCache.data;
  }
  if (_codexLimitsCache.home === home && _codexLimitsCache.promise) {
    return _codexLimitsCache.promise;
  }

  const promise = fetchCodexRateLimits(home, fetchOptions).then((data) => {
    _codexLimitsCache = {
      at: now, home, data, ready: true, promise: null,
    };
    return data;
  });
  _codexLimitsCache = {
    at: _codexLimitsCache.at,
    home,
    data: _codexLimitsCache.home === home ? _codexLimitsCache.data : null,
    ready: false,
    promise,
  };
  return promise;
}

function mergeCodexRateLimits(
  usage: CodexUsage | null,
  rateLimits: CodexRateLimits | null,
  now: number,
): CodexUsage | null {
  if (!rateLimits) return usage;
  return {
    updatedAt: now,
    rateLimits,
    tokens: usage?.tokens || {
      total: null, input: null, cachedInput: null, output: null, reasoning: null,
    },
    contextWindow: usage?.contextWindow ?? null,
  };
}

export async function getUsage(home: string = homedir(), options: UsageOptions = {}): Promise<UsageSummary> {
  const codex = readCodexUsage(home, options);
  const rateLimits = await getCodexRateLimitsCached(home, options);
  return {
    claude: readClaudeUsage(home),
    codex: mergeCodexRateLimits(codex, rateLimits, options.now ?? Date.now()),
  };
}

// Small TTL cache so a phone that re-polls doesn't rescan the rollout every few seconds. In-flight requests
// share the same promise, while the heavier Codex account query has its own one-minute cache above.
interface UsageCache {
  at: number;
  home: string | null;
  data: UsageSummary | null;
  promise: Promise<UsageSummary> | null;
}

let _cache: UsageCache = {
  at: 0, home: null, data: null, promise: null,
};
export async function getUsageCached(
  home: string = homedir(),
  options: UsageOptions = {},
): Promise<UsageSummary> {
  const { ttlMs = 15000, now = Date.now(), calibrationMs = 60_000 } = options;
  if (_cache.data && _cache.home === home && (now - _cache.at) < ttlMs) return _cache.data;
  if (_cache.promise && _cache.home === home) return _cache.promise;
  const promise = getUsage(home, {
    ...options, now, calibrationMs,
  }).then((data) => {
    _cache = {
      at: now, home, data, promise: null,
    };
    return data;
  });
  _cache = {
    at: _cache.at, home, data: _cache.home === home ? _cache.data : null, promise,
  };
  return promise;
}
