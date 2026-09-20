// The CodeBuddy Code hook-event layer: what Handmux knows that is SPECIFIC to CodeBuddy's hook events.
//
// CodeBuddy's hook protocol is Claude Code's (same lifecycle event names, same raw payload on stdin, same
// shared writer + state/spool format), so this file deliberately does NOT re-implement the generic parts:
//   - the lifecycle vocabulary and the on-disk record format come from agents/hookEvents.ts;
//   - the state row / spool event reading is shared by the generic Connector (connectors/hookBridge.ts);
//   - the Inbox operation/snapshot projection is the shared projectHookInbox, parameterized below.
// What stays here is the mapping from CodeBuddy's `src` names and payload fields to the shared kind
// language — the one thing no other provider can answer for CodeBuddy.
//
// There is also no legacy reader service here (unlike src/claudeEvents.ts): Claude needed one because it
// predates Inbox Core, and a fresh Agent must NOT create a second state store — the Connector + ordered
// projector are the only authority for CodeBuddy from day one. A `createCodebuddyEvents` service that
// serves the conversation lens (pane → session binding, activity) is added by that slice, not this one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookErrorMessage, readHookStateRows } from './agents/hookEvents.js';
import type { AgentHookClassification, AgentHookKind } from './agents/hookEvents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The hook-maintained state file: ONE JSON object keyed by tmux pane id, each value the pane's latest
// event { ts, src, host, payload } — the same format Claude uses, in CodeBuddy's own file. The hook writes
// it (the shared handmux-write.cjs); the server only reads it. Default lives under server/data (gitignored
// runtime data); override with CODEBUDDY_STATE_FILE — the CLI sets that for the server child and writes the
// same path into the hook's env, exactly like CLAUDE_STATE_FILE.
export const DEFAULT_STATE_FILE = process.env.CODEBUDDY_STATE_FILE
  || path.resolve(here, '../data/codebuddy-state.json');

type CodeBuddyBody = Record<string, unknown>;

const record = (value: unknown): CodeBuddyBody | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CodeBuddyBody
    : null
);
const text = (value: unknown): string => typeof value === 'string' ? value : '';

// Build the 需要你 one-liner from the tool the gate is blocking on. CodeBuddy's PermissionRequest payload is
// Claude-shaped, but its interactive tool set is NOT verified, so this reads only the generic tool name
// instead of borrowing Claude's AskUserQuestion/ExitPlanMode wording — a wrong assumption there would put a
// confident, wrong label in front of the user.
function permissionMessage(body: CodeBuddyBody): string {
  const tool = text(body.tool_name);
  return tool ? `需要你授权：${tool}` : '需要你';
}

// Map a CodeBuddy hook event (src + raw payload) to a notification kind. Pure — no I/O, easy to test.
//   stop       → done       (Stop: the turn finished; carries the last assistant message)
//   prompt     → working    (UserPromptSubmit: carries the submitted prompt)
//   end        → end        (SessionEnd: the pane's CodeBuddy session is over → clear its projection)
//   start      → null       (SessionStart: neutral by design — it (re)binds pane→session, including the
//                            NEW transcript_path after /clear. A fresh/just-cleared session reads as
//                            present, not 进行中, until its first prompt)
//   permreq    → permission (PermissionRequest: a real gate just appeared, named by its tool)
//   permdenied → working    (PermissionDenied: the gate is CLOSED. Like Claude's deny→tool_result→resume
//                            path, the agent continues the turn with the denial; if the turn then ends,
//                            Stop overrides this with done. Unverified against a live payload — the
//                            alternative (neutral) would silently drop a running turn's card)
//   compacting → compacting (PreCompact: a slow operation, shown as 压缩中)
//   compact    → null       (PostCompact: compaction finished → clear 压缩中. It must not fabricate done;
//                            Claude's equivalent clears here too, and the next real edge re-states)
//   stopfail   → error      (StopFailure: the turn ended on an API error, so no Stop fires — this is the
//                            only signal that closes 进行中 with a failure)
//   notify     → permission / idle by notification_type; anything else is null (ignored noise:
//                auth_success, elicitation_*, …) — it must never create or keep an Inbox card
export function classifyCodeBuddy(src: unknown, rawBody: unknown = {}): AgentHookClassification | null {
  const body = record(rawBody) || {};
  if (src === 'stop') return { kind: 'done', msg: text(body.last_assistant_message) };
  if (src === 'prompt') return { kind: 'working', msg: text(body.prompt) };
  if (src === 'permreq') return { kind: 'permission', msg: permissionMessage(body) };
  // Answered or approved: back to working, carrying what the user picked so the card stops asking.
  if (src === 'resume') return { kind: 'working', msg: text(body.tool_response) };
  if (src === 'permdenied') return { kind: 'working', msg: '' };
  if (src === 'compacting') return { kind: 'compacting', msg: '' };
  if (src === 'compact') return null;
  if (src === 'stopfail') return { kind: 'error', msg: hookErrorMessage(body) };
  if (src === 'end') return { kind: 'end' };
  if (src === 'start') return null;
  if (src === 'notify') {
    if (body.notification_type === 'permission_prompt') return { kind: 'permission', msg: text(body.message) };
    if (body.notification_type === 'idle_prompt') return { kind: 'idle', msg: text(body.message) };
  }
  return null;
}

// Which record markings are CodeBuddy's self same pipeline may read. The shared writer stamps the Agent's
// own id on every spool file and state row, so a row carrying another provider's mark must fail closed
// rather than be projected as CodeBuddy state. Exported here, next to the event vocabulary, because both
// the Inbox Connector and the conversation lens's pane binding must answer it the same way.
export function acceptsCodeBuddyAgent(agent: unknown): boolean {
  return agent === 'codebuddy';
}

// The conversation lens's pane → session bind. The hook state file records THIS pane's own session id (and
// its transcript path, when the payload carried one), which is authoritative over any cwd→newest-file
// guess. Returns null when hooks are off, the pane is not CodeBuddy's, or the row carries no session to
// bind — so a lens can never open onto a session the pane was not actually running.
export function createCodebuddyEvents({ stateFile = DEFAULT_STATE_FILE }: { stateFile?: string } = {}): {
  paneSession(paneId: string): {
    sessionId: string | null;
    transcriptPath: string | null;
    cwd: string | null;
    agent: string | null;
  } | null;
  paneKind(paneId: string, process?: { pid: number; startedAt?: number }): AgentHookKind | null;
  paneSubmittedPrompt(paneId: string): string | null;
} {
  const read = () => readHookStateRows(stateFile, acceptsCodeBuddyAgent);
  return {
    paneSession(paneId) {
      const row = read().get(paneId);
      const payload = row?.payload;
      if (!payload) return null;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
      const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
      if (!sessionId && !transcriptPath) return null;
      return {
        sessionId,
        transcriptPath,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        agent: row?.agent ?? null,
      };
    },
    // The activity the 对话 lens shows while a turn runs: the SAME classification the Inbox projects, so the
    // typing wave and the roster row can never disagree about what the pane is doing. A caller holding a
    // process generation gets the row only when it is still that generation's.
    paneKind(paneId: string, process?: { pid: number; startedAt?: number }): AgentHookKind | null {
      const row = read().get(paneId);
      if (!row) return null;
      if (process && row.process
        && (process.pid !== row.process.pid || process.startedAt !== row.process.startedAt)) return null;
      return classifyCodeBuddy(row.src, row.payload)?.kind ?? null;
    },
    // The prompt this pane last submitted, used only to recognize OUR OWN leftover in the native editor:
    // the composer may replace that, never a draft a human typed.
    paneSubmittedPrompt(paneId: string): string | null {
      const row = read().get(paneId);
      if (!row || row.src !== 'prompt') return null;
      const prompt = row.payload.prompt;
      return typeof prompt === 'string' && prompt ? prompt : null;
    },
  };
}
