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
//   anything else              → null       (ignored: auth_success, elicitation_*, etc.)
export function classifyClaude(src, body = {}) {
  if (src === 'stop') return { kind: 'done', msg: body.last_assistant_message || '' };
  if (src === 'prompt') return { kind: 'working', msg: body.prompt || '' };
  if (src === 'resume') return { kind: 'working', msg: resumeMsg(body) };
  if (src === 'permreq') return { kind: 'permission', msg: permMsg(body) };
  if (src === 'end') return { kind: 'end' };
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
    resumeCmd: (id) => `claude --resume ${id}`,
  },
};
