import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent, agentForProc } from './agents/index.js';
import { resolveVersionedComms } from './agents/claude.js';
import { defaultRun } from './agents/scanUtils.js';
import { claude } from './agents/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The hook-maintained state file: ONE JSON object keyed by tmux pane id, each value the pane's latest
// event { ts, src, host, payload }. The hook writes it (handmux-write.js); the server only reads it.
// Default lives under server/data (gitignored runtime data); override with CLAUDE_STATE_FILE.
export const DEFAULT_STATE_FILE = process.env.CLAUDE_STATE_FILE || path.resolve(here, '../data/claude-state.json');

// Classify a Claude hook event → inbox kind. The logic now lives in the Claude driver (agents/claude.js);
// re-exported here because tests and callers import it by this path. Per-pane classification in getStates
// dispatches through getAgent(entry.agent) so Codex (and future agents) classify with their own driver.
export const classifyEvent = claude.classify;

// Which display VIEW a kind pushes as — and so what the device notification fires for. permission→需要你,
// done→已完成. 已完成 fires at the COMPLETION MOMENT (done) only. The trailing idle reminder (~60s "still
// waiting") is dropped UPSTREAM at the hook (handmux-write.cjs), so neither push nor the inbox ever sees
// it — that's the single source of truth. The idle NO-OP in the loop below is defense-in-depth for one
// that ever slips through. working / end / unclassifiable map to undefined → no push + re-arm the dedup.
const PUSH_VIEW = { permission: 'needs', done: 'done' };
const VIEW_LABEL = { needs: '需要你', done: '已完成' };

// The dedup key for a pane's current push view. `needs` is view-only: Claude signals one permission gate via
// TWO hooks (permreq then permission_prompt) at different ts, and both must collapse to a SINGLE 需要你. But
// `done` is ts-sensitive: each finished turn is a fresh "已完成 / 该你了". For Claude, two dones are always
// separated by a 进行中 that re-arms the dedup anyway, so keying done by ts is equivalent; for Codex — whose
// ONLY event is turn-complete, with no working/prompt event in between — it's what makes turn 2, 3, … push
// instead of latching on turn 1's done forever.
function pushKey(view, ts) { return view === 'done' ? `done:${ts}` : view; }

// A 进行中 (working) is a LATCHED state: set by UserPromptSubmit, normally closed by Stop. But an ESC
// interrupt / walk-away fires NO hook at all (verified across all 26 hook event types), so working never
// gets closed and the blue dot would stick forever. There's no event signal for the interrupt — so we
// expire working purely by age: latched longer than this with no done/needs ⇒ no-longer-working, drop it.
// Generous (2h) so a genuinely long-running task keeps its dot for its whole run; a real turn re-lights on
// its next event, and a new prompt resets the clock.
const WORKING_TTL_MS = 2 * 60 * 60 * 1000;

// 压缩中 (compacting) clears three ways: a SUCCESSFUL compaction fires PostCompact (src 'compact' → cleared
// the instant it finishes); a NO-OP /compact ("Not enough messages to compact") fires no PostCompact but
// writes its <local-command-stdout> immediately, which the transcript-tail check below catches within a poll;
// and this TTL is the ultimate backstop for a genuine crash/abort mid-compaction where neither signal comes.
// It must stay WELL above a real compaction's duration (routinely 1-2min) so it never truncates the animation
// of a compaction that's actually still running — real ones are cleared by PostCompact, not by this timer.
const COMPACTING_TTL_MS = 5 * 60 * 1000;

// A pane latched in `permission` (需要你) has NO hook event to close it when the user resolves the prompt:
// approving a normal tool (Bash/Edit/…) doesn't hit our PostToolUse matcher (only AskUserQuestion|ExitPlanMode
// do), and DENYING or ESC-interrupting fires no hook at all (verified across all hook events). So the prompt
// would read 需要你 until the turn's eventual Stop — or FOREVER after an ESC, which never Stops. Detect the
// resolution out-of-band: while the prompt is pending Claude is blocked and appends nothing to its session
// transcript, so the transcript's mtime sits at (or before) the permission event's ts; the instant the user
// resolves it — approve → tool_result, deny → denial result, ESC → a `[Request interrupted by user]` line —
// the transcript grows and its mtime jumps past it. mtime beyond the event ts (+ a guard for the near-
// simultaneous permreq/tool-write case) ⇒ resolved ⇒ drop the stale 需要你 (the pane falls back to neutral
// process-presence). The guard must clear the gap between the tool_use write and the permreq/notification
// firing; a real resolution always lands well beyond it (the user takes seconds to answer).
const PERM_RESOLVED_GUARD_MS = 1500;

// Read a transcript file's mtime in ms, or null if it's missing/unreadable (→ can't tell, keep 需要你).
function defaultStatMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }

// Read the LAST complete JSON line of a (possibly multi-MB) transcript, or null if unreadable. Reads only a
// bounded tail so cost is one small read regardless of transcript size; a last line longer than the window
// won't parse cleanly, but the only line we care to recognise (the interrupt marker) is tiny.
function defaultReadTail(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 65536);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      return lines.length ? lines[lines.length - 1] : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Pure: has the user resolved the permission prompt recorded by `rec`, judged by its transcript mtime?
// True only once the transcript has grown past the event ts by more than the guard. Exported for testing.
export function permissionResolved(rec, mtimeMs, guard = PERM_RESOLVED_GUARD_MS) {
  return typeof mtimeMs === 'number' && mtimeMs > (rec.ts || 0) + guard;
}

// Pure: once resolved, the transcript's last line tells a RESUME from an INTERRUPT. Approving (yes) or
// denying-with-feedback appends a tool_result / Claude's next message → Claude is working again → 进行中.
// Pressing ESC appends a `[Request interrupted by user…]` marker → the turn ended, back to idle → drop the
// pane to neutral (null). An unparseable/absent tail is treated as a resume (clears the stale 需要你 and
// shows active — a truncated huge last line is a big tool_result, never the tiny interrupt marker).
export function resolvedPermissionKind(lastLine) {
  if (isInterruptTail(lastLine)) return null;       // ESC → neutral
  return { kind: 'working', msg: '' };              // approve / deny → 进行中
}

// Pure: does a transcript's last line mark a user ESC-interrupt? Matches both the plain and the
// "…for tool use" forms. Used to un-stick a 进行中 pane the instant the user aborts a turn.
export function isInterruptTail(lastLine) {
  return !!(lastLine && /Request interrupted by user/.test(lastLine));
}

// Pure: does a transcript's last line mark a /compact having RESOLVED — i.e. Claude wrote the command's
// <local-command-stdout>? A NO-OP /compact ("Not enough messages to compact") writes it IMMEDIATELY, whereas
// a real compaction stays silent for its whole (often 1-2min) run and writes it only at the very end — the
// same moment PostCompact already clears us. So a fresh stdout tail while still 压缩中 ⇒ the compaction is
// over (nothing to do / done) ⇒ drop the stuck state. Recognised by the system entry's subtype or the tag.
export function isLocalCommandStdout(lastLine) {
  if (!lastLine) return false;
  try {
    const o = JSON.parse(lastLine);
    if (o && o.subtype === 'local_command') return true;
    const c = o && o.message && o.message.content;
    if (typeof c === 'string' && /<local-command-stdout>/.test(c)) return true;
  } catch { /* not JSON → fall through to a raw tag match */ }
  return /<local-command-stdout>/.test(lastLine);
}

// Truncate a Claude message to a notification-friendly one-liner.
function summarize(msg) {
  const oneLine = (msg || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

// Read the hook's JSON state file. Tolerant of a missing / corrupt / half-written file (returns {}),
// never throws — the hook replaces it atomically, but a read can still land on a transient state.
function readStateFile(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

// Per-process event reader. Deps injected for testability:
//   commands.listLivePanes() → [{ id, cmd, tty, session, window, windowName }]  (one tmux call)
//   run(cmd, args) → stdout   (only used by the version-named-comm corroboration; default defaultRun)
//   push.sendToSession(session, payload, {ttl, urgency, topic})
//   file: the hook-maintained JSON state file (DEFAULT_STATE_FILE).
// The hook is the sole writer; the server reads the file fresh on every getStates and on every file
// change (the watcher, for push). No persisted state of our own — the file IS the persistence.
export function createClaudeEvents({ commands, push, file = DEFAULT_STATE_FILE, now = () => Date.now(), statMtime = defaultStatMtime, readTail = defaultReadTail, run = defaultRun } = {}) {
  const lastPushed = {}; // pane → 'needs' | 'done' | null  (in-process push-transition dedup, by display view)
  // The dedup above is in-process ONLY: a restart (e.g. ./deploy.sh) wipes it while the hook's state
  // file on disk keeps every pane's latest 需要你/已完成. Without priming, the first read after boot
  // would see an empty dedup and re-push every resting pane — a flood of "historical" notifications on
  // every redeploy. prime() (run from start(), before any request is served) adopts the file's current
  // resting states as already-notified, so only transitions that happen AFTER boot push.
  function prime() {
    const recorded = readStateFile(file);
    for (const [pane, r] of Object.entries(recorded)) {
      const c = r && typeof r.src === 'string' ? getAgent(r.agent).classify(r.src, r.payload || {}) : null;
      const view = c ? PUSH_VIEW[c.kind] : undefined;
      if (view) lastPushed[pane] = pushKey(view, r.ts); // resting 需要你/已完成 → treat as seen, don't replay
    }
  }

  // Notify the device that a pane entered 需要你 / 已完成. Title carries the state label + session so the
  // user can tell the two apart at a glance (the inbox shows the same label as a chip); body is the
  // pane's one-line message, falling back to the bare label. 需要你 is high-urgency (wake the phone).
  async function sendPush(pane, view, c, lp) {
    const label = VIEW_LABEL[view];
    const body = summarize(c.msg) || label;
    const payload = { title: `${label} · ${lp.session}`, body, tag: `pane-${pane}`, data: { session: lp.session, window: lp.window, pane } };
    // 可靠优先 TTL: a phone in Doze / briefly offline still gets the LATEST per pane when it wakes (the
    // pane-topic collapses older ones, so no pileup). 需要你 holds for hours (you're being waited on);
    // 已完成 ~30min (a stale "done" is less useful). A force-stopped app still can't be reached at all —
    // that's an OS limit, not a TTL one.
    const opts = { topic: `pane-${pane}`, ttl: view === 'needs' ? 14400 : 1800, urgency: view === 'needs' ? 'high' : 'normal' };
    try { await push.sendToSession(lp.session, payload, opts); } catch { /* best effort */ }
  }

  // Read the state file, reconcile every recorded pane against live tmux, and in ONE pass: (1) fire push
  // for 需要你/已完成 transitions (deduped, global — independent of any caller's session filter), and
  // (2) build the pane→state roster the inbox shows. A pane is dropped from the roster when its latest
  // event is `end`/unclassifiable, or when tmux says it's gone or no longer running claude (hard kill /
  // crash / Ctrl-C-out with no SessionEnd). `allowedSessions` (session NAMES, or null) scopes only the
  // OUTPUT — push and reconciliation run over every pane. On a tmux failure we degrade: no location, no
  // reconciliation, no push (we'd have no session name to route to), roster returned best-effort.
  async function _getStates(allowedSessions = null) {
    const allow = allowedSessions == null ? null : new Set(allowedSessions);
    const recorded = readStateFile(file);
    let live = null;
    try {
      const panes = await commands.listLivePanes();
      // Native-install Claude binaries report a version string as pane_current_command — corroborate via
      // ps and normalize to 'claude' BEFORE any identity/liveness match (see agents/claude.js).
      await resolveVersionedComms(panes, run);
      live = new Map(panes.map((p) => [p.id, p]));
    } catch { /* tmux down */ }

    const out = {};
    for (const [pane, rec] of Object.entries(recorded)) {
      const agent = getAgent(rec && rec.agent);
      let c = rec && typeof rec.src === 'string' ? agent.classify(rec.src, rec.payload || {}) : null;
      // A 需要你 the user already resolved leaves no closing hook (see PERM_RESOLVED_GUARD_MS). statMtime
      // gates the cheap "still pending" path; only once the transcript has grown past the event do we pay the
      // bounded tail read to tell a RESUME (approve/deny → 进行中) from an INTERRUPT (ESC → neutral present).
      if (c && c.kind === 'permission') {
        const tp = rec.payload && rec.payload.transcript_path;
        if (tp && permissionResolved(rec, statMtime(tp))) c = resolvedPermissionKind(readTail(tp));
      } else if (c && c.kind === 'working') {
        // ESC-interrupt during a turn leaves the last hook as the stale 'prompt' (working) — no Stop fires,
        // so working would otherwise stick until WORKING_TTL_MS (2h), pinning the composer's send→stop toggle.
        // Once the transcript has grown past the prompt event, a bounded tail read settles it: an interrupt
        // marker → neutral (un-stick now); any other line → Claude is still producing, stay 进行中. Content is
        // definitive so no guard window is needed; an unreadable stat/tail can't tell → keep working.
        const tp = rec.payload && rec.payload.transcript_path;
        if (tp && statMtime(tp) > (rec.ts || 0) && isInterruptTail(readTail(tp))) c = null;
      } else if (c && c.kind === 'compacting') {
        // A no-op /compact fires no PostCompact; it writes its <local-command-stdout> at once. Once the
        // transcript has grown past the PreCompact event and its tail is that stdout, the /compact is done
        // (nothing to compact) → drop 压缩中. A real compaction stays silent until PostCompact, so it keeps
        // showing for its whole run. Unreadable stat/tail → can't tell → keep 压缩中 (the TTL is the backstop).
        const tp = rec.payload && rec.payload.transcript_path;
        if (tp && statMtime(tp) > (rec.ts || 0) && isLocalCommandStdout(readTail(tp))) c = null;
      }
      const lp = live ? live.get(pane) : null;
      // Dropped when tmux says the pane is gone or no longer running THIS agent (hard kill / crash /
      // Ctrl-C-out with no clean-exit event). A pane keyed by a legacy entry (no agent field) → Claude.
      const gone = live ? (!lp || !agent.procNames.includes(lp.cmd)) : false;

      // (1) push side-effect — runs for every pane regardless of the output filter. Push fires on entry
      // into a 需要你 (permission) / 已完成 (done) view, deduped so a stay-put doesn't re-push. The idle
      // reminder that trails a done is a NO-OP: 已完成 pings at the completion moment (done) only, so the
      // 60s "still waiting" idle neither pushes nor disturbs the dedup (the pane is still in the same
      // resting state). working / end / gone / unclassifiable re-arm the dedup for the next entry.
      if (live) {
        const kind = c ? c.kind : null;
        const view = PUSH_VIEW[kind]; // 'needs' | 'done' | undefined
        const key = view ? pushKey(view, rec.ts) : undefined;
        if (kind === 'idle') {
          /* trailing idle reminder — no push, keep the dedup as the preceding done left it */
        } else if (gone || !view) {
          lastPushed[pane] = null; // 进行中 / 结束 / gone → re-arm for the next 需要你 / 已完成
        } else if (lastPushed[pane] !== key && lp.session) {
          lastPushed[pane] = key;
          await sendPush(pane, view, c, lp);
        }
      }

      // (2) roster — drop ended / dead / claude-exited panes; resolve location from the live tmux row.
      if (!c || c.kind === 'end' || gone) continue;
      // Expire a 进行中 latched past the TTL (an ESC-interrupt / walk-away that never got a Stop): drop it
      // from the roster so the stuck working pane goes away. See WORKING_TTL_MS.
      if (c.kind === 'working' && now() - (rec.ts || 0) > WORKING_TTL_MS) continue;
      if (c.kind === 'compacting' && now() - (rec.ts || 0) > COMPACTING_TTL_MS) continue;
      const loc = lp ? { session: lp.session, window: lp.window, windowName: lp.windowName } : {};
      if (allow && !allow.has(loc.session)) continue;
      out[pane] = { ...loc, kind: c.kind, msg: c.msg || '', ts: rec.ts || 0, agent: agent.id };
    }

    // (3) process presence — a pane whose FOREGROUND program IS a coding agent reads as "agent here" even
    // with no active turn on record: a fresh session that hasn't prompted yet, or one right after `/clear`
    // (whose SessionEnd dropped its roster entry above though the agent is still running). This is what the
    // phone's per-window agent icon and the dock's default mode key off — process liveness, not the volatile
    // activity roster. Emitted with kind:null so the inbox (inboxRows keys off VIEW[kind]) skips it and no
    // push fires, and with NO ts so it stays inert to the done/read high-water marks (maxTs, the seen-mark
    // effect). An active roster entry from (2) always wins (out[id] set → skip). agentForProc matches the
    // canonical procName (never the ambiguous 'node'), so a plain node process is not mistaken for an agent.
    if (live) {
      for (const lp of live.values()) {
        if (out[lp.id]) continue;
        const a = agentForProc(lp.cmd);
        if (!a) continue;
        if (allow && !allow.has(lp.session)) continue;
        out[lp.id] = { session: lp.session, window: lp.window, windowName: lp.windowName, kind: null, msg: '', agent: a.id };
      }
    }
    return out;
  }

  // Run getStates run-to-completion: the /states poll and the file-watcher both call it, and it mutates the
  // shared `lastPushed` dedup and `await sendPush` mid-loop — overlapping runs could interleave on that state.
  // Serialize on a tail promise so calls queue instead of racing; each caller still gets its own filtered
  // roster (allowedSessions differs per call), and the tmux read isn't duplicated concurrently.
  let tail = Promise.resolve();
  function getStates(allowedSessions = null) {
    const run = tail.then(() => _getStates(allowedSessions), () => _getStates(allowedSessions));
    tail = run.catch(() => {});
    return run;
  }

  // Watch the state file's directory (the hook replaces the file via rename, which changes the inode, so
  // watching the file itself would go deaf after the first write — watch the dir and filter by name).
  // On a change, re-run getStates so 需要你/已完成 push fires even when NO client is polling — that's
  // the whole point of push (notify you while you're away). Debounced so a burst of writes pumps once.
  let watcher = null;
  let deb = null;
  function start() {
    if (watcher) return;
    prime(); // boot baseline: don't replay the file's resting 需要你/已完成 as fresh push (see prime())
    const dir = path.dirname(file);
    const base = path.basename(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    try {
      watcher = fs.watch(dir, (_evt, fname) => {
        if (fname && fname !== base) return;
        clearTimeout(deb);
        deb = setTimeout(() => { getStates().catch(() => {}); }, 120);
      });
    } catch { /* fs.watch unsupported → push falls back to evaluation on each /states poll */ }
  }
  function stop() { if (watcher) { watcher.close(); watcher = null; } clearTimeout(deb); }

  // The chat lens's pane→session bind: the hook state file records THIS pane's exact session (session_id +
  // transcript_path), authoritative over the terminal-side cwd→newest-jsonl guess (which collapses distinct
  // sessions that happen to share a cwd — see transcript.js). Returns null when hooks are off / the pane
  // isn't a Claude pane / the recorded payload carries no session info, so callers can fall back cleanly.
  function paneSession(pane) {
    const rec = readStateFile(file)[pane];
    const p = rec && rec.payload;
    if (!p || typeof p !== 'object') return null;
    const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : null;
    const sessionId = typeof p.session_id === 'string' ? p.session_id : null;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
    if (!transcriptPath && !sessionId) return null;
    return { sessionId, transcriptPath, cwd };
  }

  return { getStates, start, stop, paneSession };
}
