#!/usr/bin/env node
// handmux hook writer. Updates ONE JSON state file keyed by tmux pane id with this pane's latest
// Claude event:  { "%pane": { ts, src, host, payload }, ... }.  Invoked by handmux-notify.sh:
//   node handmux-write.cjs <file> <pane> <src> <ts> <host>     (stdin = Claude's raw hook payload JSON)
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

const [, , file, pane, src, ts, host = '', agent = ''] = process.argv;
if (!file || !pane || !src) process.exit(0);
// Increment whenever the pane→Codex transcript contract changes. Server readers reject older Codex rows
// instead of trusting a potentially stale pre-/clear binding; the next hook event rewrites it at this version.
const CODEX_BINDING_VERSION = 2;

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

try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }

function update() {
  let obj = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) obj = j; }
  catch { /* fresh / corrupt / half-written → start clean */ }
  const prevSrc = obj[pane] && obj[pane].src;
  if (isIdle) {
    // idle after a resting state (done/needs/nothing) is just the "still waiting" reminder → drop and
    // leave the file as it was (recording it would bump ts and re-surface an already-cleared 已完成).
    // idle after a WORKING turn (prompt/resume) that never got a Stop = an ESC interrupt / walk-away —
    // no Stop hook fires there, so idle is the only signal the turn ended. Without this the pane would
    // stay latched at 进行中 forever; treat it as a soft end and clear the pane.
    if (prevSrc === 'prompt' || prevSrc === 'resume') { delete obj[pane]; }
    else return;                                             // resting → drop without writing
  } else if (src === 'end') {
    // SessionEnd drops the pane on a clean exit. But /clear (and /resume) END the old session AND START a
    // new one — SessionEnd(old) + SessionStart(new) fire as two async hooks, in either order. A late end for
    // the OLD session must NOT wipe the NEW session's binding: only drop when what we currently hold IS the
    // ending session (or neither side carries a session_id to compare — preserve the plain clean-exit drop).
    const curSid = obj[pane] && obj[pane].payload && obj[pane].payload.session_id;
    const endSid = payload && payload.session_id;
    if (!curSid || !endSid || curSid === endSid) delete obj[pane];
  } else if (src === 'resume' && agent === 'codex') {
    // Codex fires PostToolUse on EVERY tool call, so its resume exists purely to un-stick a pane from 需要你
    // back to 进行中 after the user approved a PermissionRequest. Apply it ONLY as that transition — a mid-
    // turn tool call (pane already 进行中 / 已完成) is a no-op, so we don't rewrite the entry on every
    // command (the load Claude's matcher avoids). Claude's resume — no agent arg — is unaffected.
    const prev = obj[pane];
    const prevPerm = prev && (prev.src === 'permreq'
      || (prev.src === 'notify' && (prev.payload || {}).notification_type === 'permission_prompt'));
    if (!prevPerm) { return; }
    obj[pane] = { ts: Number(ts) || 0, src, host, payload, agent, bindingVersion: CODEX_BINDING_VERSION };
  } else {
    // agent tag lets the server dispatch classify + liveness per agent (Codex passes 'codex'); omitted for
    // Claude so legacy entries stay byte-identical and default to claude server-side.
    obj[pane] = {
      ts: Number(ts) || 0, src, host, payload,
      ...(agent ? { agent, ...(agent === 'codex' ? { bindingVersion: CODEX_BINDING_VERSION } : {}) } : {}),
    };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);                                   // atomic: a torn write can't corrupt the file
}

const lock = `${file}.lock`;
let held = false;
for (let i = 0; i < 60 && !held; i++) {                       // ~0.9s budget, then write lockless (best-effort)
  try { fs.closeSync(fs.openSync(lock, 'wx')); held = true; } // O_EXCL → atomic "I hold it"
  catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 3000) fs.unlinkSync(lock); } catch { /* steal a stale lock */ }
    nap(15);
  }
}
try { update(); } catch { /* best effort */ }
if (held) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }

// Codex hook payloads include the exact rollout transcript_path. Capture its latest token_count into a
// machine-wide snapshot after the inbox update; failures are isolated so usage can never break the hook.
if (agent === 'codex' && typeof payload.transcript_path === 'string') {
  try {
    const { captureTranscript } = require('./handmux-codex-usage.cjs');
    captureTranscript(payload.transcript_path, path.join(path.dirname(file), 'codex-usage.json'));
  } catch { /* best effort */ }
}
