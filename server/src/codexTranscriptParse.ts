import { codexPlanSnapshot } from './codexPlan.js';
import { codexGoalMessageId, codexItemMessageId } from './codexMessageIdentity.js';
import type { CodexPlanStep } from './codexPlan.js';
import type { CodexGoal } from './codexStreamProtocol.js';
import type {
  CodexDiff,
  CodexDiffHunk,
  CodexToolInput,
  CodexToolOutcome,
  CodexToolProjection,
} from './codexToolProtocol.js';

interface JsonRecord { [key: string]: unknown }
type GoalLike = Partial<CodexGoal> & JsonRecord;
interface SourceIdentity { turnId?: string; itemId?: string; id?: string }
export interface CodexTranscriptMessage extends SourceIdentity {
  [key: string]: unknown;
  i: number;
  type: string;
  ts: string | undefined;
  role?: 'user' | 'assistant';
  text?: string;
  name?: string;
  args?: string;
  event?: string;
  goal?: GoalLike;
  plan?: CodexPlanStep[];
  explanation?: string;
  tool?: CodexToolProjection;
}
interface ToolMessage extends CodexTranscriptMessage { tool: CodexToolProjection }
interface CallArgument { text: string; end: number }
interface CustomCall { name: string; input: CodexToolInput; diff?: CodexDiff }
export interface CodexTranscriptParser {
  push(lines: readonly unknown[]): CodexTranscriptMessage[];
  messages: CodexTranscriptMessage[];
}
const isRecord = (value: unknown): value is JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const asRecord = (value: unknown): JsonRecord => isRecord(value) ? value : {};

// Codex's rollout JSONL is the durable, ordered conversation log. App Server notifications drive live
// controls/status, but its thread snapshots currently omit some completed tools, so transcript rendering
// must come from this log alone. event_msg mirrors response_item content and is deliberately ignored.
const SLASH_CMD_RE = /^\/([a-z][\w-]*)(?:\s+([^\n]*))?$/i;
const OUTPUT_CAP = 100_000;
const SCRIPT_CAP = 4_000;

const cap = (value: unknown, limit: number): string => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

// Codex persists its injected context as role=user response items. Match only its reserved envelope roots:
// user prompts may legitimately begin with ordinary HTML/XML and must remain part of the conversation.
export function isCodexSyntheticUserText(value: unknown): boolean {
  const text = String(value ?? '');
  return /^\s*<(?:environment_context|permissions(?:\s+instructions)?|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins|codex_internal_context|user_action|user_shell_command|image|turn_aborted)(?:\s|>|\/)/.test(text)
    || /^\s*# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>(?:\r?\n|$)/.test(text);
}

function goalFromInternalContext(value: unknown): CodexGoal | null {
  const text = String(value ?? '');
  if (!/^\s*<codex_internal_context\s+source=["']goal["']\s*>/.test(text)) return null;
  const objective = text.match(/<objective>\s*\r?\n([\s\S]*?)\r?\n\s*<\/objective>/)?.[1]?.trim();
  if (!objective) return null;
  const tokens = text.match(/^- Tokens used:\s*([\d,]+)/mi)?.[1]?.replaceAll(',', '');
  const rawBudget = text.match(/^- Token budget:\s*([^\r\n]+)/mi)?.[1]?.trim();
  const tokenBudget = rawBudget && !/^(?:none|unbounded)$/i.test(rawBudget)
    ? Number(rawBudget.replaceAll(',', '')) : null;
  return {
    objective,
    status: 'active',
    tokensUsed: Number.isFinite(Number(tokens)) ? Number(tokens) : 0,
    tokenBudget: Number.isFinite(tokenBudget) ? tokenBudget : null,
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = asRecord(item);
      return typeof record.type === 'string'
        && ['input_text', 'output_text', 'text'].includes(record.type)
        && typeof record.text === 'string'
        ? record.text : '';
    })
    .join('');
}

function sourceIdentity(value: unknown): SourceIdentity {
  const item = asRecord(value);
  const metadata = asRecord(item.internal_chat_message_metadata_passthrough);
  const turnId = typeof metadata.turn_id === 'string' ? metadata.turn_id : null;
  const itemId = typeof item.id === 'string' && item.id ? item.id : null;
  const id = turnId && itemId ? codexItemMessageId(turnId, itemId) : null;
  return {
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(id ? { id } : {}),
  };
}

function parseInput(value: unknown): CodexToolInput {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) || isRecord(parsed) ? parsed : { value: parsed };
  } catch { return { value }; }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length < OUTPUT_CAP * 2) {
      try { return outputText(JSON.parse(trimmed)); } catch { /* keep original */ }
    }
    return cap(value, OUTPUT_CAP);
  }
  if (Array.isArray(value)) {
    return cap(value.map((item) => {
      if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
      return outputText(item);
    }).filter(Boolean).join('\n'), OUTPUT_CAP);
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return '';
    if (typeof value.output === 'string') return cap(value.output, OUTPUT_CAP);
    try { return cap(JSON.stringify(value, null, 2), OUTPUT_CAP); } catch { return ''; }
  }
  return value == null ? '' : cap(value, OUTPUT_CAP);
}

function classicOutput(value: unknown): { result: string; isError: boolean; outcome: CodexToolOutcome } {
  const raw = outputText(value);
  const exit = raw.match(/Process exited with code\s+(-?\d+)/i);
  const marker = raw.match(/(?:^|\n)Output:\n?/i);
  const result = marker ? raw.slice((marker.index ?? 0) + marker[0].length) : raw;
  const declined = /^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(result.trim());
  const isError = !!(exit && Number(exit[1]) !== 0);
  return {
    result,
    isError,
    outcome: declined ? 'declined' : isError ? 'failed' : 'success',
  };
}

function resultOutcome(value: unknown, result: string): CodexToolOutcome {
  if (/^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(String(result).trim())) return 'declined';
  if (isRecord(value)) {
    if (value.success === false) return 'failed';
    if (typeof value.exit_code === 'number') return value.exit_code === 0 ? 'success' : 'failed';
  }
  return 'success';
}

// Bounded extraction only: find known tools.* calls without evaluating generated JavaScript.
function callArgument(script: string, open: number): CallArgument | null {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let i = open + 1; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return { text: script.slice(open + 1, i).trim(), end: i + 1 };
    }
  }
  return null;
}

function decodeJsString(raw: string): string | null {
  if (!raw || !['"', "'", '`'].includes(raw[0]) || raw.at(-1) !== raw[0]) return null;
  if (raw[0] === '"') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : null;
    } catch { return null; }
  }
  const body = raw.slice(1, -1);
  if (raw[0] === '`' && body.includes('${')) return null;
  return body.replace(/\\([\\'`nrt])/g, (_match: string, char: string) => (
    ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] ?? char
  ));
}

function stringTokenAt(script: string, start: number): string | null {
  const quote = script[start];
  if (!['"', "'", '`'].includes(quote)) return null;
  let escaped = false;
  for (let i = start + 1; i < script.length; i++) {
    const ch = script[i];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === quote) return script.slice(start, i + 1);
  }
  return null;
}

function resolveStringArgument(script: string, raw: string, before: number): string | null {
  const direct = decodeJsString(raw);
  if (direct != null || !/^[A-Za-z_$][\w$]*$/.test(raw)) return direct;
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*`, 'g');
  let match;
  let token = null;
  while ((match = declaration.exec(script)) && match.index < before) {
    token = stringTokenAt(script, declaration.lastIndex);
  }
  return token ? decodeJsString(token) : null;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseJsLiteral(script: string, raw: string, before: number): unknown {
  const value = raw.trim();
  const decoded = decodeJsString(value);
  if (decoded != null) return decoded;
  try { return JSON.parse(value); } catch { /* JavaScript object syntax is not strict JSON. */ }
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    return body ? splitTopLevel(body, ',').map((item) => parseJsLiteral(script, item, before)) : [];
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const object = parseJsObjectInput(script, value, before);
    if (object) return object;
  }
  const resolved = resolveStringArgument(script, value, before);
  return resolved == null ? value : resolved;
}

// Orchestrated tool calls are stored as JavaScript source, and their arguments commonly use object-literal
// keys (`{ cmd: "pwd" }`) rather than strict JSON (`{"cmd":"pwd"}`). Parse only top-level literal fields;
// never evaluate generated code. Unknown expressions stay as source text so the detail view loses nothing.
function parseJsObjectInput(script: string, raw: string, before: number): JsonRecord | null {
  const value = raw.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const input: JsonRecord = {};
  for (const field of splitTopLevel(value.slice(1, -1), ',')) {
    const colon = splitTopLevel(field, ':');
    if (colon.length < 2) continue;
    const rawKey = colon.shift()?.trim() || '';
    const key = decodeJsString(rawKey) ?? (/^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : null);
    if (!key) continue;
    input[key] = parseJsLiteral(script, colon.join(':').trim(), before);
  }
  return Object.keys(input).length ? input : null;
}

function parseToolInput(script: string, raw: string, before: number): CodexToolInput {
  const parsed = parseInput(raw);
  if (Array.isArray(parsed) || (isRecord(parsed) && parsed.value !== raw)) return parsed;
  return parseJsObjectInput(script, raw, before) || { script: raw };
}

function applyPatchDiff(body: string): CodexDiff {
  let added = 0;
  let removed = 0;
  const hunks: CodexDiffHunk[] = [];
  let current: CodexDiffHunk | null = null;
  const flush = () => {
    if (current?.lines.length) hunks.push(current);
    current = null;
  };
  for (const line of body.split('\n').slice(1)) {
    if (line.startsWith('@@')) {
      flush();
      current = { oldStart: null, newStart: null, lines: [] };
      continue;
    }
    if (!/^[+\- ]/.test(line)) continue;
    if (!current) current = { oldStart: null, newStart: null, lines: [] };
    current.lines.push(line);
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  flush();
  return { added, removed, hunks: hunks.length ? hunks : null };
}

function applyPatchCalls(patch: string): CustomCall[] {
  const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  const sections: Array<{ kind: string; path: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = header.exec(patch))) {
    const kind = match[1];
    const filePath = match[2];
    if (!kind || !filePath) continue;
    sections.push({ kind, path: filePath.trim(), start: match.index });
  }
  if (!sections.length) return [{ name: 'apply_patch', input: { patch } }];
  return sections.map((section, index) => {
    const end = sections[index + 1]?.start ?? patch.indexOf('\n*** End Patch', section.start);
    const body = patch.slice(section.start, end < 0 ? patch.length : end);
    const diff = applyPatchDiff(body);
    return {
      name: 'apply_patch',
      input: { file_path: section.path, patch },
      diff: {
        // Persisted apply_patch input normally has bare `@@` markers. Preserve its lines as unnumbered
        // hunks; the transcript route replaces them with positioned App Server hunks when available.
        ...diff,
        ...(section.kind === 'Add' ? { created: true } : {}),
      },
    };
  });
}

function extractCustomCalls(script: string): CustomCall[] | null {
  const calls: CustomCall[] = [];
  const re = /tools\.([A-Za-z][\w]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(script))) {
    const arg = callArgument(script, re.lastIndex - 1);
    if (!arg) return null;
    const name = match[1];
    if (!name) continue;
    if (name === 'apply_patch') {
      const decoded = resolveStringArgument(script, arg.text, match.index);
      calls.push(...(decoded == null
        ? [{ name: 'apply_patch', input: { script: arg.text } }]
        : applyPatchCalls(decoded)));
    } else {
      calls.push({ name, input: parseToolInput(script, arg.text, match.index) });
    }
    re.lastIndex = arg.end;
  }
  return calls.length ? calls : null;
}

function structuredResults(value: unknown): unknown[] | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const text = parsed[i] && typeof parsed[i] === 'object' ? parsed[i].text : null;
      if (typeof text !== 'string') continue;
      try {
        const object = JSON.parse(text);
        if (object && typeof object === 'object' && !Array.isArray(object)) return Object.values(object);
      } catch { /* try previous block */ }
    }
    return null;
  }
  return parsed && typeof parsed === 'object' ? Object.values(parsed) : null;
}

function goalResult(value: unknown): GoalLike | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try { return goalResult(JSON.parse(trimmed)); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const candidate = goalResult(value[i]?.text ?? value[i]);
      if (candidate) return candidate;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (isRecord(value.goal)) return value.goal as GoalLike;
  if (typeof value.objective === 'string' && typeof value.status === 'string') return value as GoalLike;
  if (value.structuredContent) return goalResult(value.structuredContent);
  if (value.output) return goalResult(value.output);
  return null;
}

function applyGoalOutput(message: CodexTranscriptMessage, value: unknown): boolean {
  const goal = goalResult(value);
  if (!goal) return false;
  message.goal = { ...(message.goal || {}), ...goal };
  message.event = goal.status === 'complete' ? 'complete'
    : goal.status === 'blocked' ? 'blocked' : message.event;
  message.id = codexGoalMessageId(message.goal, message.event) || message.id;
  return true;
}

function applyCustomOutput(messages: CodexTranscriptMessage[], value: unknown): void {
  if (messages.length === 1 && messages[0].type === 'goal' && applyGoalOutput(messages[0], value)) return;
  const values = structuredResults(value);
  if (values && values.length === messages.length) {
    messages.forEach((message, index) => {
      if (message.type === 'goal') { applyGoalOutput(message, values[index]); return; }
      if (!message.tool) return;
      const result = values[index];
      message.tool.result = outputText(result);
      message.tool.outcome = resultOutcome(result, message.tool.result);
      message.tool.isError = message.tool.outcome === 'failed';
    });
    return;
  }
  const raw = outputText(value).replace(/^Script completed[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n?)?/i, '');
  const declined = /^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(raw.trim());
  const tools = messages.filter((message): message is ToolMessage => Boolean(message.tool));
  tools.forEach((message, index) => {
    message.tool.result = index === tools.length - 1 ? raw : '';
    // A single extracted call has an exact persisted outcome. With several calls and one unstructured
    // wrapper result, the rollout cannot identify which nested call produced it, so keep every card neutral.
    message.tool.outcome = declined && tools.length === 1 ? 'declined'
      : tools.length === 1 ? 'success' : 'completed';
  });
}

export function createCodexTranscriptParser(): CodexTranscriptParser {
  const messages: CodexTranscriptMessage[] = [];
  const pending = new Map<string, CodexTranscriptMessage[]>();
  let lineIndex = 0;
  let activeGoalObjective: string | null = null;

  const toolMessage = (
    i: number,
    ts: string | undefined,
    name: string,
    input: CodexToolInput,
    diff: CodexDiff | null | undefined,
    item: unknown,
  ): ToolMessage => ({
    i,
    role: 'assistant',
    type: 'tool',
    ts,
    ...sourceIdentity(item),
    tool: { name, input, result: null, isError: false, ...(diff ? { diff } : {}) },
  });

  const callMessage = (
    i: number,
    ts: string | undefined,
    name: string,
    input: CodexToolInput,
    diff: CodexDiff | null | undefined,
    item: unknown,
  ): CodexTranscriptMessage => {
    const identity = sourceIdentity(item);
    const { turnId } = identity;
    const inputRecord = asRecord(input);
    if (name === 'create_goal' && typeof inputRecord.objective === 'string') {
      activeGoalObjective = inputRecord.objective.trim() || null;
      return {
        i, role: 'assistant', type: 'goal', event: 'set', ts,
        goal: {
          objective: inputRecord.objective,
          status: 'active',
          ...(inputRecord.token_budget != null && Number.isFinite(Number(inputRecord.token_budget))
            ? { tokenBudget: Number(inputRecord.token_budget) } : {}),
        },
        ...identity,
      };
    }
    const goalStatus = inputRecord.status === 'complete' || inputRecord.status === 'blocked'
      ? inputRecord.status : null;
    if (name === 'update_goal' && goalStatus) {
      activeGoalObjective = null;
      return {
        i, role: 'assistant', type: 'goal', event: goalStatus, ts,
        goal: { status: goalStatus },
        ...identity,
      };
    }
    const plan = name === 'update_plan'
      ? codexPlanSnapshot(turnId, inputRecord.plan, inputRecord.explanation)
      : null;
    if (plan) {
      const { steps, ...snapshot } = plan;
      return { i, role: 'assistant', type: 'plan', ts, ...identity, ...snapshot, plan: steps };
    }
    return toolMessage(i, ts, name, input, diff, item);
  };

  function push(lines: readonly unknown[]): CodexTranscriptMessage[] {
    for (const raw of lines) {
      const i = lineIndex++;
      const source = typeof raw === 'string' ? raw.trim() : '';
      if (!source) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { continue; }
      const row = asRecord(parsed);
      const ts = typeof row.timestamp === 'string' ? row.timestamp : undefined;

      if (row.type === 'compacted') { messages.push({ i, type: 'compact', ts }); continue; }
      if (row.type !== 'response_item' || !isRecord(row.payload)) continue;
      const item = row.payload;

      if (item.type === 'message') {
        const text = messageText(item.content);
        if (/^\s*<turn_aborted>/.test(text)) { messages.push({ i, type: 'interrupt', ts }); continue; }
        if (item.role === 'developer') continue;
        if ((item.role !== 'user' && item.role !== 'assistant') || !text.trim()) continue;
        if (item.role === 'user') {
          const goal = goalFromInternalContext(text);
          if (goal) {
            if (goal.objective !== activeGoalObjective) {
              const goalId = codexGoalMessageId(goal, 'set');
              messages.push({
                i, role: 'assistant', type: 'goal', event: 'set', goal, ts,
                ...sourceIdentity(item),
                ...(goalId ? { id: goalId } : {}),
              });
              activeGoalObjective = goal.objective;
            }
            continue;
          }
          if (isCodexSyntheticUserText(text)) continue;
          const slash = SLASH_CMD_RE.exec(text.trim());
          if (slash) {
            const command = slash[1];
            if (!command) continue;
            const marker: CodexTranscriptMessage = { i, type: 'slash', name: `/${command}`, ts };
            if (slash[2]?.trim()) marker.args = slash[2].trim();
            messages.push(marker);
            continue;
          }
        }
        messages.push({
          i, role: item.role as 'user' | 'assistant', type: 'text', text, ts, ...sourceIdentity(item),
        });
        continue;
      }

      if (item.type === 'reasoning') {
        const text = (Array.isArray(item.summary) ? item.summary : [])
          .map((part) => {
            const record = asRecord(part);
            return typeof record.text === 'string' ? record.text : '';
          }).filter(Boolean).join('\n');
        if (text.trim()) messages.push({
          i, role: 'assistant', type: 'thinking', text, ts, ...sourceIdentity(item),
        });
        continue;
      }

      if (item.type === 'function_call') {
        const message = callMessage(i, ts, typeof item.name === 'string' ? item.name : '', parseInput(item.arguments), null, item);
        messages.push(message);
        if (typeof item.call_id === 'string' && item.call_id) pending.set(item.call_id, [message]);
        continue;
      }
      if (item.type === 'function_call_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : null;
        if (!callId) continue;
        const targets = pending.get(callId);
        if (targets?.length === 1) {
          const target = targets[0];
          if (!target) continue;
          if (target.type === 'goal') {
            applyGoalOutput(target, item.output);
            pending.delete(callId);
            continue;
          }
          if (!target.tool) { pending.delete(callId); continue; }
          const output = classicOutput(item.output);
          target.tool.result = output.result;
          target.tool.isError = output.isError;
          target.tool.outcome = output.outcome;
          pending.delete(callId);
        }
        continue;
      }

      if (item.type === 'tool_search_call') {
        const message = toolMessage(i, ts, 'tool_search', parseInput(item.arguments), null, item);
        if (item.status && item.status !== 'in_progress') {
          message.tool.result = '';
          message.tool.isError = item.status === 'failed';
          message.tool.outcome = item.status === 'failed' ? 'failed' : 'success';
        }
        messages.push(message);
        if (typeof item.call_id === 'string' && item.call_id) pending.set(item.call_id, [message]);
        continue;
      }
      if (item.type === 'tool_search_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : null;
        if (!callId) continue;
        const targets = pending.get(callId);
        if (targets?.length === 1) {
          const target = targets[0];
          if (!target?.tool) continue;
          target.tool.result = outputText(item.tools);
          target.tool.isError = item.status === 'failed';
          target.tool.outcome = item.status === 'failed' ? 'failed' : 'success';
          pending.delete(callId);
        }
        continue;
      }

      if (item.type === 'custom_tool_call') {
        const script = typeof item.input === 'string' ? item.input : '';
        const calls = extractCustomCalls(script);
        const targets = calls
          ? calls.map((call) => callMessage(i, ts, call.name, call.input, call.diff, item))
          : [toolMessage(i, ts, typeof item.name === 'string' ? item.name : 'exec', { script: cap(script, SCRIPT_CAP) }, null, item)];
        if (targets.length > 1) {
          targets.forEach((message, index) => {
            const childId = codexItemMessageId(message.turnId, message.itemId, index);
            if (childId) message.id = childId;
          });
        }
        messages.push(...targets);
        if (typeof item.call_id === 'string' && item.call_id) pending.set(item.call_id, targets);
        continue;
      }
      if (item.type === 'custom_tool_call_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : null;
        if (!callId) continue;
        const targets = pending.get(callId);
        if (targets) {
          applyCustomOutput(targets, item.output);
          pending.delete(callId);
        }
      }
    }
    return messages;
  }

  return { push, messages };
}

export function parseCodexTranscript(lines: readonly unknown[]): CodexTranscriptMessage[] {
  return createCodexTranscriptParser().push(lines);
}
