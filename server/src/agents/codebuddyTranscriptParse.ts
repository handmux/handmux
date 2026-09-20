// Pure: a CodeBuddy jsonl session log (array of lines) → normalized chat messages. No I/O.
//
// CodeBuddy does NOT log Claude-shaped turns. Where Claude writes one `user`/`assistant` record whose
// content carries text + `tool_use`/`tool_result` blocks, CodeBuddy writes:
//
//   message              role user|assistant, content [{type: input_text|output_text, text}]  → a bubble
//   reasoning            content [] (usually) or a PUBLIC projection, rawContent = the raw chain
//   function_call        name + arguments (a JSON STRING) + callId
//   function_call_result name + output {type:text,text} + callId + status
//   summary              a context rollup (periodic | pre-compact | initial-user-message)
//   file-history-snapshot / turn-metrics / ai-title / session-meta   → metadata, never shown
//
// A call and its result are folded into ONE tool message by `callId` (the result normally lands in a later
// batch, so the fold mutates the message already emitted — the same contract as Claude's parser). An
// unmatched result is dropped: its call is in an earlier, not-yet-loaded chunk.
//
// What is dropped, and why it is dropped structurally rather than by matching text:
//   - `providerData.isMeta`        an injected block (task notifications, reminders), not a human turn
//   - `providerData.skipRun`       text prepended to a turn that did not run (e.g. a command caveat)
//   - `providerData.isPartialAborted`  an aborted partial reply
//   - `providerData.isCompactInternal` without isCompacted/isSummary: the synthetic "continue from the
//                                  summary" prompt the harness injects — not something the user typed
// A compaction IS kept, as a quiet divider rather than a wall of summary text: those records carry
// `isCompacted`/`isSummary` + `compactType`. `summary` records are rollups of context that was never a turn
// (and the compaction they describe is already visible as its own record), so they are skipped.
//
// `reasoning` contributes only its PUBLIC `content` projection, and only when the provider put something
// there (measured: 3 of 1061 records); `rawContent` — the raw chain of thought — is never read.
import type { TranscriptMessage, TranscriptParser, TranscriptTool } from '../transcriptParse.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null
);

interface ToolMessage extends TranscriptMessage {
  type: 'tool';
  tool: TranscriptTool;
}

// A bare slash command (`/compact`, `/clear`, `/model sonnet`) is logged as an ordinary user turn. It IS
// part of the conversation, so it becomes a quiet 'slash' marker instead of a prominent bubble. Anchored to
// a single leading lowercase command token followed by whitespace/EOL, so "/Users/demo/foo.js" (uppercase,
// then a path separator) and prose mentioning a path are never eaten.
const SLASH_CMD_RE = /^\s*\/([a-z][\w-]*)(?:\s+([\s\S]*?))?\s*$/i;
// The compaction summary wrapper: `<cb_summary>` / `<conversation_history_summary>` around the real text.
const SUMMARY_WRAP_RE = /^\s*<(?:cb_summary|conversation_history_summary)>([\s\S]*?)(?:<\/(?:cb_summary|conversation_history_summary)>)?\s*$/i;
const SUMMARY_LEAD_RE = /^\s*Summary(?: of the conversation so far)?:\s*/i;
const SUMMARY_CAP = 4_096;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// The record's wall-clock, in the ISO form the shared model carries. CodeBuddy logs epoch milliseconds
// (Claude logs an ISO string), and a record without a usable one simply gets no time.
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// `arguments` is a JSON STRING (measured). Parse it so the projection can sanitize a real object; an
// unparsable payload is passed through as the raw string rather than dropped — a tool call the user cannot
// see is worse than one whose arguments are opaque.
function toolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed) as unknown; } catch { return trimmed; }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(record)
    .filter((block): block is Row => block !== null)
    .map((block) => text(block.text))
    .join('');
}

export function createCodeBuddyTranscriptParser(): TranscriptParser {
  const messages: TranscriptMessage[] = [];
  const pending = new Map<string, ToolMessage>();
  let i = 0;

  function push(lines: readonly unknown[]): TranscriptMessage[] {
    for (const raw of lines) {
      const line = typeof raw === 'string' ? raw.trim() : '';
      if (!line) { i++; continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { i++; continue; }
      const row = record(parsed);
      const type = text(row?.type);
      if (!row || !type) { i++; continue; }
      const provider = record(row.providerData) ?? {};
      const ts = isoTime(row.timestamp);
      const index = i;

      if (type === 'message') {
        if (provider.isMeta === true || provider.skipRun === true || provider.isPartialAborted === true) {
          i++; continue;
        }
        const role = row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : null;
        if (!role) { i++; continue; }
        const body = contentText(row.content);
        if (provider.isCompacted === true || provider.isSummary === true) {
          // A compaction happened here. Keep the divider (the 对话 lens shows "上下文已压缩"), cap the text.
          const wrapped = SUMMARY_WRAP_RE.exec(body);
          const summary = (wrapped?.[1] ?? body).replace(SUMMARY_LEAD_RE, '').trim();
          const message: TranscriptMessage = { i, type: 'compact', ts };
          if (summary) {
            message.summary = summary.length > SUMMARY_CAP ? summary.slice(0, SUMMARY_CAP - 1) + '…' : summary;
            if (summary.length > SUMMARY_CAP) {
              message.summaryTruncated = true;
              message.summaryOriginalBytes = Buffer.byteLength(summary, 'utf8');
            }
          }
          messages.push(message);
          i++; continue;
        }
        // The synthetic "continue from the summary" prompt is not a human turn.
        if (provider.isCompactInternal === true) { i++; continue; }
        if (role === 'user') {
          const command = SLASH_CMD_RE.exec(body);
          if (command?.[1]) {
            const message: TranscriptMessage = { i, type: 'slash', name: `/${command[1]}`, ts };
            if (command[2]?.trim()) message.args = command[2].trim();
            messages.push(message);
            i++; continue;
          }
        }
        if (!body.trim()) { i++; continue; }
        const message: TranscriptMessage = { i, type: 'text', role, text: body, ts };
        messages.push(message);
        i++; continue;
      }

      if (type === 'reasoning') {
        // Only the provider's PUBLIC projection; `rawContent` is the raw chain of thought.
        const reasoning = contentText(row.content).trim();
        if (reasoning) {
          const message: TranscriptMessage = { i, type: 'thinking', role: 'assistant', text: reasoning, ts };
          messages.push(message);
        }
        i++; continue;
      }

      if (type === 'function_call') {
        const tool: TranscriptTool = {
          name: text(row.name),
          input: toolInput(row.arguments),
          result: null,
          isError: false,
        };
        const message: ToolMessage = {
          i, type: 'tool', role: 'assistant', ts, tool,
        };
        const callId = text(row.callId);
        if (callId) pending.set(callId, message);
        messages.push(message);
        i++; continue;
      }

      if (type === 'function_call_result') {
        const message = pending.get(text(row.callId));
        if (message) {
          const result = record(row.providerData);
          const toolResult = record(result?.toolResult);
          const output = record(row.output);
          const body = text(output?.text) || text(toolResult?.content);
          message.tool.result = body;
          // `status` is the provider's own verdict (measured: 'completed'); an `error` on the tool result
          // is the same fact stated a second way. Either one marks the failure.
          message.tool.isError = (text(row.status) !== 'completed' && text(row.status) !== '')
            || toolResult?.error !== undefined;
          pending.delete(text(row.callId));
        }
        i++; continue;
      }

      i++;
    }
    return messages;
  }

  return { push, messages };
}
