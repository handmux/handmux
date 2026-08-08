// Codex's rollout JSONL is the durable, ordered conversation log. App Server notifications drive live
// controls/status, but its thread snapshots currently omit some completed tools, so transcript rendering
// must come from this log alone. event_msg mirrors response_item content and is deliberately ignored.
const SLASH_CMD_RE = /^\/([a-z][\w-]*)(?:\s+([^\n]*))?$/i;
const OUTPUT_CAP = 100_000;
const SCRIPT_CAP = 4_000;

const cap = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

// Codex persists its injected context as role=user response items. Most begin with an XML wrapper, but
// repository instructions begin with this Markdown header before their <INSTRUCTIONS> body. Match the full
// generated envelope so an ordinary user message that merely mentions "instructions" remains visible.
export function isCodexSyntheticUserText(value) {
  const text = String(value ?? '');
  return /^\s*</.test(text)
    || /^\s*# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>(?:\r?\n|$)/.test(text);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && ['input_text', 'output_text', 'text'].includes(item.type)) ? (item.text || '') : '')
    .join('');
}

function parseInput(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch { return { value }; }
}

function outputText(value) {
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
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 0) return '';
    if (typeof value.output === 'string') return cap(value.output, OUTPUT_CAP);
    try { return cap(JSON.stringify(value, null, 2), OUTPUT_CAP); } catch { return ''; }
  }
  return value == null ? '' : cap(value, OUTPUT_CAP);
}

function classicOutput(value) {
  const raw = outputText(value);
  const exit = raw.match(/Process exited with code\s+(-?\d+)/i);
  const marker = raw.match(/(?:^|\n)Output:\n?/i);
  const result = marker ? raw.slice(marker.index + marker[0].length) : raw;
  const declined = /^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(result.trim());
  const isError = !!(exit && Number(exit[1]) !== 0);
  return {
    result,
    isError,
    outcome: declined ? 'declined' : isError ? 'failed' : 'success',
  };
}

function resultOutcome(value, result) {
  if (/^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(String(result).trim())) return 'declined';
  if (value && typeof value === 'object') {
    if (value.success === false) return 'failed';
    if (typeof value.exit_code === 'number') return value.exit_code === 0 ? 'success' : 'failed';
  }
  return 'success';
}

// Bounded extraction only: find known tools.* calls without evaluating generated JavaScript.
function callArgument(script, open) {
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

function decodeJsString(raw) {
  if (!raw || !['"', "'", '`'].includes(raw[0]) || raw.at(-1) !== raw[0]) return null;
  if (raw[0] === '"') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const body = raw.slice(1, -1);
  if (raw[0] === '`' && body.includes('${')) return null;
  return body.replace(/\\([\\'`nrt])/g, (_match, char) => ({ n: '\n', r: '\r', t: '\t' }[char] ?? char));
}

function stringTokenAt(script, start) {
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

function resolveStringArgument(script, raw, before) {
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

function splitTopLevel(value, separator) {
  const parts = [];
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

function parseJsLiteral(script, raw, before) {
  const value = raw.trim();
  const decoded = decodeJsString(value);
  if (decoded != null) return decoded;
  try { return JSON.parse(value); } catch { /* JavaScript object syntax is not strict JSON. */ }
  const resolved = resolveStringArgument(script, value, before);
  return resolved == null ? value : resolved;
}

// Orchestrated tool calls are stored as JavaScript source, and their arguments commonly use object-literal
// keys (`{ cmd: "pwd" }`) rather than strict JSON (`{"cmd":"pwd"}`). Parse only top-level literal fields;
// never evaluate generated code. Unknown expressions stay as source text so the detail view loses nothing.
function parseJsObjectInput(script, raw, before) {
  const value = raw.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const input = {};
  for (const field of splitTopLevel(value.slice(1, -1), ',')) {
    const colon = splitTopLevel(field, ':');
    if (colon.length < 2) continue;
    const rawKey = colon.shift().trim();
    const key = decodeJsString(rawKey) ?? (/^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : null);
    if (!key) continue;
    input[key] = parseJsLiteral(script, colon.join(':').trim(), before);
  }
  return Object.keys(input).length ? input : null;
}

function parseToolInput(script, raw, before) {
  const parsed = parseInput(raw);
  if (parsed.value !== raw) return parsed;
  return parseJsObjectInput(script, raw, before) || { script: raw };
}

function applyPatchCalls(patch) {
  const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  const sections = [];
  let match;
  while ((match = header.exec(patch))) {
    sections.push({ kind: match[1], path: match[2].trim(), start: match.index });
  }
  if (!sections.length) return [{ name: 'apply_patch', input: { patch } }];
  return sections.map((section, index) => {
    const end = sections[index + 1]?.start ?? patch.indexOf('\n*** End Patch', section.start);
    const body = patch.slice(section.start, end < 0 ? patch.length : end);
    let added = 0;
    let removed = 0;
    const hunks = [];
    let lines = [];
    const flush = () => {
      if (lines.length) hunks.push({ oldStart: 0, newStart: 0, lines });
      lines = [];
    };
    for (const line of body.split('\n').slice(1)) {
      if (line.startsWith('@@')) { flush(); continue; }
      if (!/^[+\- ]/.test(line)) continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      lines.push(line);
    }
    flush();
    return {
      name: 'apply_patch',
      input: { file_path: section.path, patch },
      diff: {
        added, removed, hunks: hunks.length ? hunks : null,
        ...(section.kind === 'Add' ? { created: true } : {}),
      },
    };
  });
}

function extractCustomCalls(script) {
  const calls = [];
  const re = /tools\.([A-Za-z][\w]*)\s*\(/g;
  let match;
  while ((match = re.exec(script))) {
    const arg = callArgument(script, re.lastIndex - 1);
    if (!arg) return null;
    if (match[1] === 'apply_patch') {
      const decoded = resolveStringArgument(script, arg.text, match.index);
      calls.push(...(decoded == null
        ? [{ name: 'apply_patch', input: { script: arg.text } }]
        : applyPatchCalls(decoded)));
    } else {
      calls.push({ name: match[1], input: parseToolInput(script, arg.text, match.index) });
    }
    re.lastIndex = arg.end;
  }
  return calls.length ? calls : null;
}

function structuredResults(value) {
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

function applyCustomOutput(messages, value) {
  const values = structuredResults(value);
  if (values && values.length === messages.length) {
    messages.forEach((message, index) => {
      const result = values[index];
      message.tool.result = outputText(result);
      message.tool.outcome = resultOutcome(result, message.tool.result);
      message.tool.isError = message.tool.outcome === 'failed';
    });
    return;
  }
  const raw = outputText(value).replace(/^Script completed[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n?)?/i, '');
  const declined = /^aborted by user(?:\s+after\s+[\d.]+s)?\s*$/i.test(raw.trim());
  messages.forEach((message, index) => {
    message.tool.result = index === messages.length - 1 ? raw : '';
    // A single extracted call has an exact persisted outcome. With several calls and one unstructured
    // wrapper result, the rollout cannot identify which nested call produced it, so keep every card neutral.
    message.tool.outcome = declined && messages.length === 1 ? 'declined'
      : messages.length === 1 ? 'success' : 'completed';
  });
}

export function createCodexTranscriptParser() {
  const messages = [];
  const pending = new Map();
  let lineIndex = 0;

  const toolMessage = (i, ts, name, input, diff) => ({
    i, role: 'assistant', type: 'tool', ts,
    tool: { name, input, result: null, isError: false, ...(diff ? { diff } : {}) },
  });

  function push(lines) {
    for (const raw of lines) {
      const i = lineIndex++;
      const source = typeof raw === 'string' ? raw.trim() : '';
      if (!source) continue;
      let row;
      try { row = JSON.parse(source); } catch { continue; }
      const ts = typeof row.timestamp === 'string' ? row.timestamp : undefined;

      if (row.type === 'compacted') { messages.push({ i, type: 'compact', ts }); continue; }
      if (row.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') continue;
      const item = row.payload;

      if (item.type === 'message') {
        const text = messageText(item.content);
        if (/^\s*<turn_aborted>/.test(text)) { messages.push({ i, type: 'interrupt', ts }); continue; }
        if (item.role === 'developer') continue;
        if (!['user', 'assistant'].includes(item.role) || !text.trim()) continue;
        if (item.role === 'user') {
          if (isCodexSyntheticUserText(text)) continue;
          const slash = SLASH_CMD_RE.exec(text.trim());
          if (slash) {
            const marker = { i, type: 'slash', name: `/${slash[1]}`, ts };
            if (slash[2]?.trim()) marker.args = slash[2].trim();
            messages.push(marker);
            continue;
          }
        }
        messages.push({ i, role: item.role, type: 'text', text, ts });
        continue;
      }

      if (item.type === 'reasoning') {
        const text = (Array.isArray(item.summary) ? item.summary : [])
          .map((part) => part?.text || '').filter(Boolean).join('\n');
        if (text.trim()) messages.push({ i, role: 'assistant', type: 'thinking', text, ts });
        continue;
      }

      if (item.type === 'function_call') {
        const message = toolMessage(i, ts, item.name || '', parseInput(item.arguments));
        messages.push(message);
        if (item.call_id) pending.set(item.call_id, [message]);
        continue;
      }
      if (item.type === 'function_call_output') {
        const targets = item.call_id && pending.get(item.call_id);
        if (targets?.length === 1) {
          const output = classicOutput(item.output);
          targets[0].tool.result = output.result;
          targets[0].tool.isError = output.isError;
          targets[0].tool.outcome = output.outcome;
          pending.delete(item.call_id);
        }
        continue;
      }

      if (item.type === 'custom_tool_call') {
        const script = typeof item.input === 'string' ? item.input : '';
        const calls = extractCustomCalls(script);
        const targets = calls
          ? calls.map((call) => toolMessage(i, ts, call.name, call.input, call.diff))
          : [toolMessage(i, ts, item.name || 'exec', { script: cap(script, SCRIPT_CAP) })];
        messages.push(...targets);
        if (item.call_id) pending.set(item.call_id, targets);
        continue;
      }
      if (item.type === 'custom_tool_call_output') {
        const targets = item.call_id && pending.get(item.call_id);
        if (targets) {
          applyCustomOutput(targets, item.output);
          pending.delete(item.call_id);
        }
      }
    }
    return messages;
  }

  return { push, messages };
}

export function parseCodexTranscript(lines) {
  return createCodexTranscriptParser().push(lines);
}
