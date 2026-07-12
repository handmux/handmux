import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent } from './agents/index.js';
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
//   commands.listLivePanes() → [{ id, cmd, session, window, windowName }]  (one tmux call: liveness+location)
//   push.sendToSession(session, payload, {ttl, urgency, topic})
//   file: the hook-maintained JSON state file (DEFAULT_STATE_FILE).
// The hook is the sole writer; the server reads the file fresh on every getStates and on every file
// change (the watcher, for push). No persisted state of our own — the file IS the persistence.
export function createClaudeEvents({ commands, push, file = DEFAULT_STATE_FILE, now = () => Date.now() } = {}) {
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
  async function getStates(allowedSessions = null) {
    const allow = allowedSessions == null ? null : new Set(allowedSessions);
    const recorded = readStateFile(file);
    let live = null;
    try { live = new Map((await commands.listLivePanes()).map((p) => [p.id, p])); } catch { /* tmux down */ }

    const out = {};
    for (const [pane, rec] of Object.entries(recorded)) {
      const agent = getAgent(rec && rec.agent);
      const c = rec && typeof rec.src === 'string' ? agent.classify(rec.src, rec.payload || {}) : null;
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
      const loc = lp ? { session: lp.session, window: lp.window, windowName: lp.windowName } : {};
      if (allow && !allow.has(loc.session)) continue;
      out[pane] = { ...loc, kind: c.kind, msg: c.msg || '', ts: rec.ts || 0, agent: agent.id };
    }
    return out;
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

  return { getStates, start, stop };
}
