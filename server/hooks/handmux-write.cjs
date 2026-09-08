#!/usr/bin/env node
// handmux hook writer. Updates one JSON latest-state file keyed by tmux pane and, when configured,
// appends the same effective lifecycle edge to a bounded durable Connector spool. Invoked by notify.sh:
//   node handmux-write.cjs <file> <pane> <src> <ts> <host> <event-dir>
//     [claude-pid] [claude-lstart] [claude-tty]
//
// .cjs (not .js): runs standalone via `node <file>`, including from ~/.claude/hooks (no package.json) —
// .cjs forces CommonJS everywhere; a bare .js under the server tree ("type":"module") would be ESM and
// break require().
//
// Why node (not pure shell): the file is a single JSON object, so each event is a read-modify-write that
// must parse JSON and not clobber other panes — shell can't do that safely. The user runs many Claude
// panes at once, so hooks fire concurrently: we take a short O_EXCL lock (stealing a stale one) around
// the read-modify-write and replace atomically (tmp + rename), so concurrent writers don't lose updates
// or corrupt the file. Best-effort throughout and silent — the hook is fire-and-forget and must never
// fail Claude (the shell wrapper swallows errors and always exits 0).
const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');

const [
  , , file, pane, src, ts, host = '', eventDirectory = '',
  claudePid = '', claudeStartedAt = '', claudeTty = '',
] = process.argv;
if (!file || !pane || !src) process.exit(0);

function processFingerprint() {
  const pid = Number(String(claudePid).trim());
  const startedAt = Date.parse(String(claudeStartedAt).trim());
  const rawTty = String(claudeTty).trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)
    || !rawTty || rawTty === '?' || rawTty === '??') return undefined;
  return {
    pid,
    startedAt,
    tty: rawTty.startsWith('/dev/') ? rawTty : `/dev/${rawTty}`,
  };
}

const sourceProcess = processFingerprint();

function sameSourceProcess(previous) {
  const prior = previous?.process;
  if (!sourceProcess || !prior) return true; // retain compatibility with rows from older Hook versions
  return prior.pid === sourceProcess.pid
    && prior.startedAt === sourceProcess.startedAt
    && prior.tty === sourceProcess.tty;
}

let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* unreadable stdin → {} */ }

// idle_prompt ("been idle ~60s") is decided in update() against the pane's PRIOR state: it either trails
// a resting state (done/needs → drop, so it can't bump ts and re-surface an already-cleared 已完成) or it
// terminates an ESC-interrupted working turn (→ clear the stuck 进行中). Flag it here; the read-modify-
// write under the lock — the only place we can read the prior state safely — makes the call.
const isIdle = src === 'notify' && payload && payload.notification_type === 'idle_prompt';

// Synchronous nap without busy-spinning (the hook runs async, so a few ms is free). SharedArrayBuffer
// may be unavailable in odd runtimes — fall back to a tiny busy loop so the lock retry still paces.
const nap = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
};

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

const MAX_EVENT_SPOOL_BYTES = 16 * 1024 * 1024;

function readEvent(fileName) {
  try {
    const value = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function allocateSequence(minimum = 0) {
  if (!eventDirectory) return null;
  ensurePrivateDirectory(eventDirectory);
  const sequenceFile = path.join(eventDirectory, '.sequence');
  let current = Number.isSafeInteger(minimum) && minimum > 0 ? minimum : 0;
  try {
    const parsed = Number(fs.readFileSync(sequenceFile, 'utf8'));
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = Math.max(current, parsed);
  } catch { /* first event */ }
  if (current === 0) {
    try {
      for (const name of fs.readdirSync(eventDirectory)) {
        const match = /^event-(\d+)-/.exec(name);
        if (match) current = Math.max(current, Number(match[1]) || 0);
      }
    } catch { /* empty spool */ }
  }
  const next = current + 1;
  const temporary = `${sequenceFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, String(next), { mode: 0o600 });
  fs.renameSync(temporary, sequenceFile);
  fs.chmodSync(sequenceFile, 0o600);
  return next;
}

function safeSequence(minimum = 0) {
  try { return allocateSequence(minimum); } catch { return null; }
}

function writeGapMarker(value) {
  if (!value || !value.paneId) return;
  const paneKey = crypto.createHash('sha256').update(String(value.paneId)).digest('hex').slice(0, 16);
  const marker = path.join(eventDirectory, `gap-${paneKey}.json`);
  const temporary = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    version: 1,
    type: 'gap',
    agent: 'claude',
    eventId: `claude-gap-${Date.now()}-${process.pid}`,
    paneId: value.paneId,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    ...(value.process ? { process: value.process } : {}),
  }), { mode: 0o600 });
  fs.renameSync(temporary, marker);
  fs.chmodSync(marker, 0o600);
}

function pruneEventSpool() {
  const entries = [];
  let total = 0;
  for (const name of fs.readdirSync(eventDirectory)) {
    if (!/^event-\d+-\d+\.json$/.test(name)) continue;
    const eventFile = path.join(eventDirectory, name);
    try {
      const size = fs.statSync(eventFile).size;
      entries.push({ name, file: eventFile, size });
      total += size;
    } catch { /* concurrently consumed */ }
  }
  entries.sort((first, second) => first.name.localeCompare(second.name));
  const gaps = new Map();
  for (const entry of entries) {
    if (total <= MAX_EVENT_SPOOL_BYTES) break;
    const dropped = readEvent(entry.file);
    if (dropped?.paneId) gaps.set(dropped.paneId, {
      paneId: dropped.paneId,
      sessionId: dropped.sessionId,
      process: dropped.process,
    });
    try { fs.unlinkSync(entry.file); total -= entry.size; } catch { /* already consumed */ }
  }
  for (const gap of gaps.values()) writeGapMarker(gap);
}

function writeBridgeEvent(sequence, rawTs, payload) {
  if (!eventDirectory || !Number.isSafeInteger(sequence)) return;
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
  const event = {
    version: 1,
    type: 'event',
    agent: 'claude',
    eventId: `claude-hook-${sequence}`,
    sequence,
    paneId: pane,
    src,
    sourceOccurredAt: Number(rawTs) || 0,
    ...(sessionId ? { sessionId } : {}),
    ...(sourceProcess ? { process: sourceProcess } : {}),
    payload,
  };
  const final = path.join(
    eventDirectory,
    `event-${String(sequence).padStart(16, '0')}-${process.pid}.json`,
  );
  const temporary = `${final}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(event), { mode: 0o600 });
  fs.renameSync(temporary, final);
  fs.chmodSync(final, 0o600);
  pruneEventSpool();
}

try {
  ensurePrivateDirectory(path.dirname(file));
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
} catch { /* ignore */ }

function update() {
  let obj = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) obj = j; }
  catch { /* fresh / corrupt / half-written → start clean */ }
  const previous = obj[pane];
  const prevSrc = previous && previous.src;
  const sequenceFloor = Object.values(obj).reduce((maximum, value) => (
    Number.isSafeInteger(value?.sequence) ? Math.max(maximum, value.sequence) : maximum
  ), 0);
  let applied = true;
  if (isIdle) {
    // idle after a resting state (done/needs/nothing) is just the "still waiting" reminder → drop and
    // leave the file as it was (recording it would bump ts and re-surface an already-cleared 已完成).
    // idle after a WORKING turn (prompt/resume) that never got a Stop = an ESC interrupt / walk-away —
    // no Stop hook fires there, so idle is the only signal the turn ended. Without this the pane would
    // stay latched at 进行中 forever; treat it as a soft end and clear the pane.
    if (prevSrc === 'prompt' || prevSrc === 'resume') { delete obj[pane]; }
    else applied = false;                                    // resting → drop without writing
  } else if (src === 'notify' && payload?.notification_type === 'permission_prompt'
    && prevSrc === 'permreq'
    && sameSourceProcess(previous)
    && (!previous?.payload?.session_id || !payload?.session_id
      || previous.payload.session_id === payload.session_id)) {
    // PermissionRequest is the authoritative opening edge. Claude later emits a generic Notification for
    // the same blocked gate; retaining the earlier detailed row also prevents a second canonical unread.
    applied = false;
  } else if (src === 'end') {
    // SessionEnd drops the pane on a clean exit. But /clear (and /resume) END the old session AND START a
    // new one — SessionEnd(old) + SessionStart(new) fire as two async hooks, in either order. A late end for
    // the OLD session must NOT wipe the NEW session's binding: only drop when what we currently hold IS the
    // ending session (or neither side carries a session_id to compare — preserve the plain clean-exit drop).
    const curSid = obj[pane] && obj[pane].payload && obj[pane].payload.session_id;
    const endSid = payload && payload.session_id;
    if (!curSid || !endSid || curSid === endSid) delete obj[pane];
    else applied = false;
  } else {
    // sequence is allocated under the same pane-state lock, so independently spawned async hooks share
    // one durable source order. Existing readers ignore the additive field.
    const sequence = safeSequence(sequenceFloor);
    obj[pane] = {
      ts: Number(ts) || 0, src, host, payload, agent: 'claude',
      ...(sourceProcess ? { process: sourceProcess } : {}),
      ...(sequence === null ? {} : { sequence }),
    };
  }
  if (!applied) return;
  const sequence = src === 'end' || isIdle ? safeSequence(sequenceFloor) : obj[pane]?.sequence;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);                                   // atomic: a torn write can't corrupt the file
  fs.chmodSync(file, 0o600);
  try { writeBridgeEvent(sequence, ts, payload); } catch { /* latest snapshot still recovers */ }
}

const lock = `${file}.lock`;
let held = false;
for (let i = 0; i < 60 && !held; i++) {                       // ~0.9s budget; never corrupt order locklessly
  try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); held = true; } // O_EXCL → atomic "I hold it"
  catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 3000) fs.unlinkSync(lock); } catch { /* steal a stale lock */ }
    nap(15);
  }
}
if (held) {
  try { update(); } catch { /* best effort */ }
  try { fs.unlinkSync(lock); } catch { /* ignore */ }
}
