// The Claude Code agent driver. Everything handmux knows that is SPECIFIC to Claude Code lives here (or, for
// the hook scripts that must run standalone under ~/.claude/hooks, in ../../hooks). A driver is a plain
// descriptor the shared engine consumes; adding another agent (see codex.js) is a second descriptor, not a
// fork of the engine.
//
//   id / label     identity
//   procName       tmux #{pane_current_command} value when this agent is the pane's foreground process
//   procMatch      argv regex for the `ps` orphan scan (anchored so "vim claude.md" won't match)
//   classify       (src, payload) → { kind, msg } | null   — normalize a hook event to an inbox state
//   sessions       cwd → session resolution + the `resume` command, for orphan takeover
import path from 'node:path';
import os from 'node:os';
import { resolveEncodedDirSession, isSessionUuid } from './scanUtils.js';
import { resolveByExecutable, executableBasename } from './processIdentity.js';

// The NATIVE installer names the real binary by version (~/.local/share/claude/versions/2.1.196 —
// ~/.local/bin/claude is only a symlink to it), and tmux #{pane_current_command} follows that basename
// ("2_1_196", dots sanitized to underscores) instead of "claude". ps can't tie it: ps `comm` shows the
// process's self-set title ("claude"), which does NOT match tmux's report (verified live on a native-
// install machine). Matching any semver-shaped name would misidentify any version-named binary, so we
// corroborate with the process's REAL executable path (`lsof -d txt` on macOS, /proc/<pid>/exe on
// Linux): a pid on the pane's tty whose exe BASENAME equals tmux's version comm, and whose path carries
// "claude" — every official install layout carries it (Caskroom/claude-code@latest, .local/share/
// claude/versions, node_modules/@anthropic-ai/claude-code, …), version- and layout-proof, while a
// foreign version-named binary's path doesn't. Only then is the pane's cmd normalized to 'claude', so
// every downstream match (identity + liveness) stays exact-name. A short executable-verdict cache still
// refreshes the cheap foreground pid signature every poll: PID/TTY reuse invalidates immediately and a
// transient negative probe retries after 3s instead of poisoning the pane until server restart.
const VERSION_COMM_RE = /^\d+[._]\d+[._]\d+$/;
const CLAUDE_PATH_RE = /claude/;

export async function resolveVersionedComms(panes, run, verdicts = new Map(), opts = {}) {
  return resolveByExecutable(panes, run, verdicts, {
    candidate: (cmd) => VERSION_COMM_RE.test(cmd),
    normalized: 'claude',
    matches: (exe, cmd) => {
      const base = executableBasename(exe);
      return (base === cmd || base === cmd.replace(/_/g, '.')) && CLAUDE_PATH_RE.test(exe);
    },
    ...opts,
  });
}

// Build the 需要你 one-liner for a PermissionRequest, from the tool it's gating on (PermissionRequest
// carries tool_name + tool_input, unlike the later permission_prompt Notification which only has an
// English message).
function permMsg(body) {
  const t = body.tool_name;
  if (t === 'AskUserQuestion') {
    const q = body.tool_input && body.tool_input.questions && body.tool_input.questions[0];
    const text = (q && (q.question || q.header)) || '';
    return text ? `需要你回答：${text}` : '需要你回答';
  }
  if (t === 'ExitPlanMode') return '需要你批准计划';
  return t ? `需要你授权：${t}` : '需要你';
}

// Friendly Chinese for the StopFailure error type (matcher values, see the hooks doc). The payload shape
// isn't verified against a live rate-limit yet, so read the type defensively from several likely fields and
// always fall back to a bare 本轮出错 — a wrong field name degrades to the generic label, never throws.
const STOPFAIL_LABEL = {
  rate_limit: '触发限流', overloaded: '服务过载', authentication_failed: '认证失败',
  oauth_org_not_allowed: '组织未授权', billing_error: '额度/账单问题', invalid_request: '请求无效',
  model_not_found: '模型不可用', server_error: '服务端错误', max_output_tokens: '输出超长', unknown: '未知错误',
};
function stopFailMsg(body = {}) {
  const type = body.error_type || body.reason || body.type
    || (body.error && (typeof body.error === 'string' ? body.error : body.error.type)) || '';
  if (STOPFAIL_LABEL[type]) return STOPFAIL_LABEL[type];
  const raw = typeof body.error === 'string' ? body.error : (body.message || '');
  return raw ? String(raw).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

// Build the 进行中 one-liner for a resume (PostToolUse after the user answered/approved), surfacing the
// choice they just made — AskUserQuestion stores it in tool_input.answers, keyed by question.
function resumeMsg(body) {
  const a = (body.tool_input && body.tool_input.answers) || (body.tool_response && body.tool_response.answers);
  if (a && typeof a === 'object') {
    const picks = Object.values(a).flat().filter(Boolean).join('、');
    if (picks) return `已答：${picks}`;
  }
  if (body.tool_name === 'ExitPlanMode') return '已批准计划';
  return '';
}

// Map a hook event (src + raw Claude payload) to a notification "kind". Pure — no I/O, easy to test.
//   stop                       → done       (turn finished; carries last message)
//   prompt                     → working    (UserPromptSubmit; carries the prompt)
//   end                        → end        (SessionEnd; the pane's claude is gone)
//   start                      → null       (SessionStart startup/clear/resume: (re)binds pane→session to
//                                             the NEW transcript_path — the whole point on /clear, which
//                                             starts a fresh session file. Neutral: a fresh/just-cleared
//                                             session reads as present, not 进行中, until its first prompt)
//   notify + idle_prompt       → idle       (waited ~60s; carries the notification message)
//   notify + permission_prompt → permission (blocked on a permission/选择 gate; carries the message)
//   resume                     → working    (PostToolUse on AskUserQuestion/ExitPlanMode: the user just
//                                             answered/approved → Claude is working again; un-sticks the
//                                             pane from the `permission` state its prompt left behind, and
//                                             carries the choice the user made, e.g. 已答：Red)
//   permreq                    → permission (PermissionRequest: a real prompt just appeared — fires ~6s
//                                             before the permission_prompt Notification and names the tool,
//                                             so 需要你 shows faster and says what's being asked. Verified
//                                             NOT to fire for auto-approved tools → no false 需要你 in auto)
//   compacting                 → compacting (PreCompact: context compaction started — a slow op, shown as
//                                             「压缩中」; version-gated, only paired with the clearing event)
//   compact                    → null       (PostCompact: compaction finished → clear 压缩中/进行中. null
//                                             drops the roster entry; the pane falls back to neutral present)
//   stopfail                   → error      (StopFailure: the turn ended on an API error — no Stop fires, so
//                                             this is the only signal that un-sticks the pane from 进行中)
//   anything else              → null       (ignored: auth_success, elicitation_*, etc.)
export function classifyClaude(src, body = {}) {
  if (src === 'stop') return { kind: 'done', msg: body.last_assistant_message || '' };
  if (src === 'prompt') return { kind: 'working', msg: body.prompt || '' };
  if (src === 'resume') return { kind: 'working', msg: resumeMsg(body) };
  if (src === 'permreq') return { kind: 'permission', msg: permMsg(body) };
  if (src === 'compacting') return { kind: 'compacting', msg: '' };   // PreCompact: 压缩上下文进行中
  if (src === 'compact') return null;                                 // PostCompact: done → clear 压缩中/进行中
  if (src === 'stopfail') return { kind: 'error', msg: stopFailMsg(body) }; // turn died on an API error
  if (src === 'end') return { kind: 'end' };
  if (src === 'start') return null;                                   // SessionStart: only (re)binds pane→session
  if (src === 'notify') {
    if (body.notification_type === 'idle_prompt') return { kind: 'idle', msg: body.message || '' };
    if (body.notification_type === 'permission_prompt') return { kind: 'permission', msg: body.message || '' };
  }
  return null;
}

export const projectsDir = (home = os.homedir()) => path.join(home, '.claude', 'projects');

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  procName: 'claude',
  // Which tmux #{pane_current_command} values mean "this agent is still the pane's foreground app" (inbox
  // liveness). Claude sets its process title to "claude", so an exact single-name match is right — for
  // native-install machines (whose comm is the VERSION string) resolveVersionedComms below normalizes the
  // cmd back to 'claude' at ingest, keeping every match here exact-name.
  procNames: ['claude'],
  // The `claude` CLI sets its process title to "claude" (verified via ps): match the program token at the
  // start of argv — bare "claude", "claude --continue", or an absolute path ending in /claude. Anchored so
  // "vim claude.js" / "node build/claude.js" don't match.
  procMatch: /^(\S*\/)?claude(\s|$)/,
  takeoverPrefix: 'cc', // tmux session name prefix for a takeover (cc-<label>-<n>)
  classify: classifyClaude,
  sessions: {
    isId: isSessionUuid,
    dirOptKey: 'projectsDir', // scanOrphans option that overrides `dir` (back-compat + tests)
    dir: projectsDir,
    // Resolve a cwd to its Claude session within `dir`: newest jsonl in the encoded project dir whose
    // recorded cwd matches. Layout: ~/.claude/projects/<enc-cwd>/<uuid>.jsonl.
    resolve: (dir, cwd, opts = {}) => resolveEncodedDirSession(dir, cwd, opts),
    // `claude --resume <uuid>` appends to the SAME jsonl with no OS lock, so the takeover kills the original
    // to guarantee a single writer (see orphans.js).
    resumeArgs: (id) => ['claude', '--resume', id],
    resumeCmd: (id) => `claude --resume ${id}`,
  },
};
