// Persistent machine-wide Codex usage snapshot utilities. Kept as CommonJS so the ESM usage service can
// load the same bounded rollout reader without adding a second package boundary.
const fs = require('node:fs');
const path = require('node:path');

const CHUNK_BYTES = 64 * 1024;

function ensurePrivateDirectory(directory) {
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

function windowUsage(value) {
  if (!value || typeof value.used_percent !== 'number') return null;
  return {
    usedPercent: value.used_percent,
    windowMinutes: typeof value.window_minutes === 'number' ? value.window_minutes : null,
    resetsAt: typeof value.resets_at === 'number' ? value.resets_at : null,
  };
}

function normalize(record) {
  const payload = record && record.payload;
  if (!payload || payload.type !== 'token_count') return null;
  const updatedAt = Date.parse(record.timestamp);
  if (!Number.isFinite(updatedAt)) return null;
  const info = payload.info || {};
  const totals = info.total_token_usage || {};
  const limits = payload.rate_limits || {};
  return {
    updatedAt,
    rateLimits: {
      primary: windowUsage(limits.primary),
      secondary: windowUsage(limits.secondary),
    },
    tokens: {
      total: totals.total_tokens ?? null,
      input: totals.input_tokens ?? null,
      cachedInput: totals.cached_input_tokens ?? null,
      output: totals.output_tokens ?? null,
      reasoning: totals.reasoning_output_tokens ?? null,
    },
    contextWindow: typeof info.model_context_window === 'number' ? info.model_context_window : null,
  };
}

function parseLatest(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('token_count')) continue;
    try {
      const usage = normalize(JSON.parse(line));
      if (usage) return usage;
    } catch { /* damaged/incomplete line: continue toward older complete records */ }
  }
  return null;
}

function readLatestUsage(transcriptPath) {
  let fd;
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
      const usage = parseLatest(lines);
      if (usage) return usage;
      end = start;
    }
    return suffix ? parseLatest([suffix]) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function readSnapshot(snapshotPath) {
  try {
    ensurePrivateDirectory(path.dirname(snapshotPath));
    fs.chmodSync(snapshotPath, 0o600);
    const value = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (!value || value.version !== 1 || typeof value.checkedAt !== 'number') return null;
    if (value.usage !== null && (!value.usage || typeof value.usage.updatedAt !== 'number')) return null;
    return value;
  } catch {
    return null;
  }
}

function nap(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* spin */ } }
}

function writeSnapshot(snapshotPath, usage, { checkedAt } = {}) {
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

module.exports = { readLatestUsage, readSnapshot, writeSnapshot };
