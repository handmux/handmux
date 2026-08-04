// Pure/stateful parser for Codex rollout JSONL. It projects Codex's response_item stream into the
// same message contract used by the chat lens for Claude. event_msg is deliberately ignored because
// it mirrors conversation text; synthetic developer/environment messages are never rendered.
const SLASH_CMD_RE = /^\/([a-z][\w-]*)(?:\s+([^\n]*))?$/i;
const OUTPUT_CAP = 100_000;
const SCRIPT_CAP = 4_000;

const cap = (value, limit) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

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
      try { return outputText(JSON.parse(trimmed)); } catch { /* keep the original string */ }
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
  return { result, isError: !!(exit && Number(exit[1]) !== 0) };
}

// Find the matching ')' while respecting strings and nested object/array literals. This is intentionally
// a bounded extractor, not a JavaScript evaluator: only the argument text of known tools.* calls is read.
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
  // Codex currently emits JSON-compatible double-quoted strings. Support simple single/backtick strings
  // without evaluating expressions; unfamiliar escaping safely falls back to the raw exec card.
  const body = raw.slice(1, -1);
  if (raw[0] === '`' && body.includes('${')) return null;
  return body.replace(/\\([\\'`nrt])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
}

function extractCustomCalls(script) {
  const calls = [];
  const re = /tools\.([A-Za-z][\w]*)\s*\(/g;
  let match;
  while ((match = re.exec(script))) {
    const arg = callArgument(script, re.lastIndex - 1);
    if (!arg) return null;
    if (match[1] === 'apply_patch') {
      const decoded = decodeJsString(arg.text);
      calls.push({ name: 'apply_patch', input: decoded == null ? { script: arg.text } : { patch: decoded } });
    } else {
      const input = parseInput(arg.text);
      // Object literals emitted by Codex are JSON. A parse failure means the shape changed; preserve the
      // exact argument in one field rather than pretending it was understood. This also covers MCP tools
      // and newer built-ins without another parser release.
      calls.push({ name: match[1], input: input.value === arg.text ? { script: arg.text } : input });
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
    // Orchestrated exec output is commonly an array of text blocks. Search from the end for the JSON
    // object produced by text(JSON.stringify({...})).
    for (let i = parsed.length - 1; i >= 0; i--) {
      const text = parsed[i] && typeof parsed[i] === 'object' ? parsed[i].text : null;
      if (typeof text !== 'string') continue;
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return Object.values(obj);
      } catch { /* try the previous text block */ }
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
      const code = result && typeof result === 'object' ? result.exit_code : null;
      message.tool.isError = typeof code === 'number' && code !== 0;
    });
    return;
  }
  const raw = outputText(value).replace(/^Script completed[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n?)?/i, '');
  messages.forEach((message, index) => { message.tool.result = index === messages.length - 1 ? raw : ''; });
}

export function createCodexTranscriptParser() {
  const messages = [];
  const pending = new Map();
  let i = 0;

  function toolMessage(line, ts, name, input) {
    return { i: line, role: 'assistant', type: 'tool', ts, tool: { name, input, result: null, isError: false } };
  }

  function push(lines) {
    for (const raw of lines) {
      const line = i++;
      const source = typeof raw === 'string' ? raw.trim() : '';
      if (!source) continue;
      let row;
      try { row = JSON.parse(source); } catch { continue; }
      const ts = typeof row.timestamp === 'string' ? row.timestamp : undefined;

      if (row.type === 'compacted') { messages.push({ i: line, type: 'compact', ts }); continue; }
      if (row.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') continue;
      const item = row.payload;

      if (item.type === 'message') {
        const text = messageText(item.content);
        if (/^\s*<turn_aborted>/.test(text)) { messages.push({ i: line, type: 'interrupt', ts }); continue; }
        if (item.role === 'developer') continue;
        if (!['user', 'assistant'].includes(item.role) || !text.trim()) continue;
        if (item.role === 'user') {
          if (/^\s*</.test(text)) continue;
          const slash = SLASH_CMD_RE.exec(text.trim());
          if (slash) {
            const marker = { i: line, type: 'slash', name: `/${slash[1]}`, ts };
            if (slash[2]?.trim()) marker.args = slash[2].trim();
            messages.push(marker);
            continue;
          }
        }
        messages.push({ i: line, role: item.role, type: 'text', text, ts });
        continue;
      }

      if (item.type === 'reasoning') {
        const text = (Array.isArray(item.summary) ? item.summary : []).map((part) => part?.text || '').filter(Boolean).join('\n');
        if (text.trim()) messages.push({ i: line, role: 'assistant', type: 'thinking', text, ts });
        continue;
      }

      if (item.type === 'function_call') {
        const message = toolMessage(line, ts, item.name || '', parseInput(item.arguments));
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
          pending.delete(item.call_id);
        }
        continue;
      }

      if (item.type === 'custom_tool_call') {
        const script = typeof item.input === 'string' ? item.input : '';
        const calls = extractCustomCalls(script);
        const targets = calls
          ? calls.map((call) => toolMessage(line, ts, call.name, call.input))
          : [toolMessage(line, ts, item.name || 'exec', { script: cap(script, SCRIPT_CAP) })];
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
