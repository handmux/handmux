// Persistent machine-wide Codex usage snapshot utilities. Kept as CommonJS so the ESM usage service can
// load the same bounded rollout reader without adding a second package boundary.
import fs from 'node:fs';
import path from 'node:path';

const CHUNK_BYTES = 64 * 1024;

export interface UsageRateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexUsage {
  updatedAt: number;
  rateLimits: {
    primary: UsageRateLimitWindow | null;
    secondary: UsageRateLimitWindow | null;
  };
  tokens: {
    total: number | null;
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    reasoning: number | null;
  };
  contextWindow: number | null;
}

export interface CodexUsageSnapshot {
  version: 1;
  checkedAt: number;
  usage: CodexUsage | null;
}

export interface CodexContextUsage {
  usedTokens: number;
  totalTokens: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown): value is number | null =>
  value === null || finiteNumber(value);
const numberOrNull = (value: unknown): number | null => finiteNumber(value) ? value : null;

function ensurePrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const privateRoot = parts.indexOf('.handmux');
  if (privateRoot < 0) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  for (let i = privateRoot; i < parts.length; i++) {
    const current = path.join(parsed.root, ...parts.slice(0, i + 1));
    fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    fs.chmodSync(current, 0o700);
  }
}

function windowUsage(value: unknown): UsageRateLimitWindow | null {
  if (!isRecord(value) || !finiteNumber(value.used_percent)) return null;
  return {
    usedPercent: value.used_percent,
    windowMinutes: numberOrNull(value.window_minutes),
    resetsAt: numberOrNull(value.resets_at),
  };
}

function normalize(record: unknown): CodexUsage | null {
  if (!isRecord(record) || !isRecord(record.payload)) return null;
  const payload = record.payload;
  if (payload.type !== 'token_count' || typeof record.timestamp !== 'string') return null;
  const updatedAt = Date.parse(record.timestamp);
  if (!Number.isFinite(updatedAt)) return null;
  const info = isRecord(payload.info) ? payload.info : {};
  const totals = isRecord(info.total_token_usage) ? info.total_token_usage : {};
  const rawLimits = isRecord(payload.rate_limits) ? payload.rate_limits : {};
  // A rollout may carry a model-specific limit (for example GPT-5.3-Codex-Spark's
  // `codex_bengalfox`) instead of the account's main Codex limit. Keep its token/context data, but never
  // project that independent percentage as the generic Codex quota shown by HandMux.
  const limitId = typeof rawLimits.limit_id === 'string' ? rawLimits.limit_id : null;
  const limits = limitId === null || limitId === 'codex' ? rawLimits : {};
  return {
    updatedAt,
    rateLimits: {
      primary: windowUsage(limits.primary),
      secondary: windowUsage(limits.secondary),
    },
    tokens: {
      total: numberOrNull(totals.total_tokens),
      input: numberOrNull(totals.input_tokens),
      cachedInput: numberOrNull(totals.cached_input_tokens),
      output: numberOrNull(totals.output_tokens),
      reasoning: numberOrNull(totals.reasoning_output_tokens),
    },
    contextWindow: numberOrNull(info.model_context_window),
  };
}

function contextUsage(record: unknown): CodexContextUsage | null {
  if (!isRecord(record) || !isRecord(record.payload) || record.payload.type !== 'token_count') return null;
  const info = isRecord(record.payload.info) ? record.payload.info : null;
  const last = isRecord(info?.last_token_usage) ? info.last_token_usage : null;
  const usedTokens = last?.total_tokens;
  const totalTokens = info?.model_context_window;
  if (!finiteNumber(usedTokens) || usedTokens < 0
    || !finiteNumber(totalTokens) || totalTokens <= 0) return null;
  return { usedTokens, totalTokens };
}

function parseLatest<T>(lines: readonly string[], normalizeLine: (record: unknown) => T | null): T | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('token_count')) continue;
    try {
      const usage = normalizeLine(JSON.parse(line));
      if (usage) return usage;
    } catch { /* damaged/incomplete line: continue toward older complete records */ }
  }
  return null;
}

function readLatest<T>(transcriptPath: string, normalizeLine: (record: unknown) => T | null): T | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    let end = fs.fstatSync(fd).size;
    let suffix = '';
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(end - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = `${buffer.toString('utf8')}${suffix}`.split('\n');
      if (start > 0) suffix = lines.shift() || '';
      const usage = parseLatest(lines, normalizeLine);
      if (usage) return usage;
      end = start;
    }
    return suffix ? parseLatest([suffix], normalizeLine) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function readLatestUsage(transcriptPath: string): CodexUsage | null {
  return readLatest(transcriptPath, normalize);
}

export function readLatestContextUsage(transcriptPath: string): CodexContextUsage | null {
  return readLatest(transcriptPath, contextUsage);
}

function isUsageWindow(value: unknown): value is UsageRateLimitWindow {
  return isRecord(value)
    && finiteNumber(value.usedPercent)
    && nullableNumber(value.windowMinutes)
    && nullableNumber(value.resetsAt);
}

function isCodexUsage(value: unknown): value is CodexUsage {
  if (!isRecord(value)
    || !finiteNumber(value.updatedAt)
    || !isRecord(value.rateLimits)
    || !isRecord(value.tokens)
    || !nullableNumber(value.contextWindow)) return false;
  const { primary, secondary } = value.rateLimits;
  if (primary !== null && !isUsageWindow(primary)) return false;
  if (secondary !== null && !isUsageWindow(secondary)) return false;
  return nullableNumber(value.tokens.total)
    && nullableNumber(value.tokens.input)
    && nullableNumber(value.tokens.cachedInput)
    && nullableNumber(value.tokens.output)
    && nullableNumber(value.tokens.reasoning);
}

export function readSnapshot(snapshotPath: string): CodexUsageSnapshot | null {
  try {
    ensurePrivateDirectory(path.dirname(snapshotPath));
    fs.chmodSync(snapshotPath, 0o600);
    const value: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (!isRecord(value) || value.version !== 1 || !finiteNumber(value.checkedAt)) return null;
    if (value.usage !== null && !isCodexUsage(value.usage)) return null;
    return { version: 1, checkedAt: value.checkedAt, usage: value.usage };
  } catch {
    return null;
  }
}

function nap(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* spin */ } }
}

export function writeSnapshot(
  snapshotPath: string,
  usage: CodexUsage | null,
  { checkedAt }: { checkedAt?: number } = {},
): CodexUsage | null {
  try { ensurePrivateDirectory(path.dirname(snapshotPath)); } catch { return null; }
  const lock = `${snapshotPath}.lock`;
  let held = false;
  for (let i = 0; i < 40 && !held; i++) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); held = true; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 3000) fs.unlinkSync(lock); } catch { /* retry */ }
      nap(5);
    }
  }
  if (!held) return readSnapshot(snapshotPath)?.usage || null;

  try {
    const previous = readSnapshot(snapshotPath);
    const priorUsage = previous?.usage || null;
    const nextUsage = usage && (!priorUsage || usage.updatedAt >= priorUsage.updatedAt) ? usage : priorUsage;
    const value = {
      version: 1,
      checkedAt: typeof checkedAt === 'number' ? checkedAt : (previous?.checkedAt || 0),
      usage: nextUsage,
    };
    const tmp = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, snapshotPath);
    fs.chmodSync(snapshotPath, 0o600);
    return nextUsage;
  } catch {
    return readSnapshot(snapshotPath)?.usage || null;
  } finally {
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}
