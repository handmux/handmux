import { isIP } from 'node:net';
import type {
  ConversationContentBlock,
  ConversationItem,
  ConversationItemDraft,
  JsonValue,
} from '../agent-runtime/conversationTypes.js';

export const MAX_CONVERSATION_TEXT_BYTES = 240 * 1024;
export const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_TOOL_INPUT_STRING_BYTES = 16 * 1024;
const MAX_TOOL_DEPTH = 5;
const MAX_TOOL_ENTRIES = 100;

export interface ClippedConversationText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

export function clipConversationText(
  value: string,
  maxBytes = MAX_CONVERSATION_TEXT_BYTES,
): ClippedConversationText {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maxBytes) return { text: value, truncated: false, originalBytes };
  if (maxBytes <= 0) return { text: '', truncated: true, originalBytes };
  let text = '';
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    text += codePoint;
    bytes += nextBytes;
  }
  return { text, truncated: true, originalBytes };
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sensitiveKey(key: string): boolean {
  const value = normalizedKey(key);
  return [
    'auth', 'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password',
    'passwd', 'passphrase', 'privatekey', 'secret', 'token',
  ].includes(value)
    || value.startsWith('cookie')
    || ['credential', 'password', 'passwd', 'privatekey', 'clientsecret', 'apikey',
      'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'idtoken']
      .some((part) => value.includes(part))
    || value.endsWith('secret') || value.endsWith('token');
}

function sensitiveUrlKey(key: string): boolean {
  const value = normalizedKey(key);
  return sensitiveKey(key) || ['key', 'sig', 'signature', 'signed'].includes(value)
    || value.endsWith('signature');
}

function endpointKey(key: string): boolean {
  const value = normalizedKey(key);
  return value === 'url' || value === 'uri' || value === 'endpoint'
    || value.endsWith('url') || value.endsWith('uri') || value.endsWith('endpoint')
    || value === 'socket' || value.endsWith('socketpath');
}

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0'
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')
    || host === '::' || host === '::1') return true;
  if (isIP(host) === 0 && !host.includes('.')) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (isIP(host) !== 6) return false;
  if (/^fe[89ab][0-9a-f]:/i.test(host) || /^(fc|fd)/i.test(host)) return true;
  const mapped = host.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]+):([0-9a-f]+))$/i);
  if (!mapped) return false;
  if (mapped[1]) return privateHost(mapped[1]);
  const high = Number.parseInt(mapped[2] ?? '', 16);
  const low = Number.parseInt(mapped[3] ?? '', 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return true;
  return privateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

function pathKey(key: string): boolean {
  const value = normalizedKey(key);
  return ['cwd', 'directory', 'file', 'folder', 'path', 'root'].includes(value)
    || ['path', 'directory', 'folder', 'root'].some((suffix) => value.endsWith(suffix));
}

export function safeRelativeProviderPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
    || value.startsWith('\\') || value.startsWith('~') || /^[a-zA-Z]:/.test(value)
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(value)
    || value.split(/[\\/]/).includes('..')) return undefined;
  return value;
}

export function safeProviderPathLabel(value: unknown): string | undefined {
  const relative = safeRelativeProviderPath(value);
  if (relative !== undefined) return relative;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let path = value;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return path.split(/[\\/]/).includes('..') ? undefined : path.replaceAll('\\', '/');
  }
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return undefined;
      path = decodeURIComponent(url.pathname);
    } catch { return undefined; }
  }
  const windows = path.match(/^([a-zA-Z]:)[\\/]Users[\\/][^\\/]+(?<tail>(?:[\\/].*)?)$/i);
  if (windows) path = windows.groups?.tail ? `~${windows.groups.tail.replaceAll('\\', '/')}` : '~';
  else path = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/root(?=\/|$)/, '~');
  if (!(path === '~' || path.startsWith('~/') || path.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(path))) return undefined;
  if (path.split(/[\\/]/).includes('..')) return undefined;
  return path;
}

export function safeProviderDiffPath(value: unknown): string | undefined {
  const label = safeProviderPathLabel(value);
  if (label === undefined || label.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(label)) {
    return undefined;
  }
  return label;
}

function urlContainsPrivateData(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.protocol === 'file:' || privateHost(url.hostname)) return true;
    const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    return [...url.searchParams.keys()].some((key) => sensitiveUrlKey(key))
      || [...new URLSearchParams(fragment).keys()].some((key) => sensitiveUrlKey(key));
  } catch {
    return false;
  }
}

function privateEndpointText(value: string): boolean {
  const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
  if (/^file:/i.test(unquoted) || unquoted.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(unquoted)) {
    return true;
  }
  if (/^[^\s/@:]+:[^\s/@]+@/.test(unquoted)) return true;
  try {
    const url = new URL(unquoted);
    return urlContainsPrivateData(unquoted);
  } catch {
    const host = unquoted.replace(/^\[|\]$/g, '').split(':', 1)[0] ?? '';
    return privateHost(host);
  }
}

function safePublicEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !urlContainsPrivateData(value);
  } catch {
    return false;
  }
}

/**
 * Redacts credentials and private endpoints from otherwise useful command output. Local paths stay
 * readable because this authenticated self-hosted UI exposes the same workspace through its terminal;
 * conventional user-home prefixes are abbreviated to avoid repeating account names.
 */
export function sanitizeToolText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  const replace = (_match: string, prefix = ''): string => {
    redacted = true;
    return `${prefix}[redacted]`;
  };
  const keepPath = (match: string, prefix: string, path: string): string => {
    const safe = safeProviderPathLabel(path);
    if (safe === undefined) return replace(match, prefix);
    if (safe !== path) redacted = true;
    return `${prefix}${safe}`;
  };
  let text = value
    .replace(/\b(?:file):\/\/[^\s<>'"`]+/gi, (match) => keepPath(match, '', match))
    .replace(/\b(?:https?|wss?):\/\/[^\s<>'"`]+/gi, (match) => (
      urlContainsPrivateData(match) ? replace(match) : match
    ))
    .replace(/(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)(?:bearer\s+)?[^\s,;}]+/gi,
      (match, prefix: string) => replace(match, prefix))
    .replace(/(\b(?:cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|credential|client[_-]?secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (match, prefix: string) => replace(match, prefix))
    .replace(/(\b(?:endpoint|base[_-]?url|server[_-]?url|socket(?:[_-]?path)?)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (match, prefix: string, endpoint: string) => (
        privateEndpointText(endpoint) ? replace(match, prefix) : match
      ))
    .replace(/(^|[\s"'=(+\-])([a-zA-Z]:[\\/][^\s"'`,;)\]}]+)/g,
      (match, prefix: string, path: string) => keepPath(match, prefix, path))
    .replace(/(^|[\s"'=(+\-])(\/(?!\/)[^\s"'`,;)\]}]+)/g,
      (match, prefix: string, path: string) => keepPath(match, prefix, path));
  return { text, redacted };
}

interface ToolInputState { redacted: boolean; truncated: boolean }

function safeToolValue(
  value: unknown,
  key: string,
  depth: number,
  state: ToolInputState,
): JsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    let text = value;
    if (pathKey(key)) {
      const path = safeProviderPathLabel(text);
      if (path === undefined) {
        state.redacted = true;
        return undefined;
      }
      if (path !== text) state.redacted = true;
      text = path;
    }
    const sanitized = sanitizeToolText(text);
    const clipped = clipConversationText(sanitized.text, MAX_TOOL_INPUT_STRING_BYTES);
    state.redacted ||= sanitized.redacted;
    state.truncated ||= clipped.truncated;
    return clipped.text;
  }
  if (depth >= MAX_TOOL_DEPTH || typeof value !== 'object') {
    if (value !== undefined) state.truncated = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_TOOL_ENTRIES) state.truncated = true;
    return value.slice(0, MAX_TOOL_ENTRIES).flatMap((item) => {
      const safe = safeToolValue(item, key, depth + 1, state);
      return safe === undefined ? [] : [safe];
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    state.redacted = true;
    return undefined;
  }
  const output: Record<string, JsonValue> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_TOOL_ENTRIES) state.truncated = true;
  for (const [childKey, childValue] of entries.slice(0, MAX_TOOL_ENTRIES)) {
    if (!childKey || childKey.length > 256 || sensitiveKey(childKey)) {
      state.redacted = true;
      continue;
    }
    if (endpointKey(childKey) && !safePublicEndpoint(childValue)) {
      state.redacted = true;
      continue;
    }
    const safe = safeToolValue(childValue, childKey, depth + 1, state);
    if (safe !== undefined) output[childKey] = safe;
  }
  return output;
}

function fitToolJson(value: JsonValue, maxBytes: number): JsonValue {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const child of value) {
      output.push(child);
      if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) output.pop();
    }
    return output;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = child;
    if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) delete output[key];
  }
  return output;
}

export interface SanitizedToolInput {
  value: JsonValue | undefined;
  redacted: boolean;
  truncated: boolean;
  originalBytes: number;
}

export function sanitizeToolInputWithMetadata(value: unknown): SanitizedToolInput {
  if (value === undefined) {
    return { value: undefined, redacted: false, truncated: false, originalBytes: 0 };
  }
  const state: ToolInputState = { redacted: false, truncated: false };
  let originalBytes = 0;
  try { originalBytes = Buffer.byteLength(JSON.stringify(value)); } catch { state.redacted = true; }
  const safe = safeToolValue(value, '', 0, state);
  if (safe === undefined) return { value: undefined, ...state, originalBytes };
  const fitted = fitToolJson(safe, MAX_TOOL_INPUT_BYTES);
  if (JSON.stringify(fitted) !== JSON.stringify(safe)) state.truncated = true;
  return { value: fitted, ...state, originalBytes };
}

export function sanitizeToolInput(value: unknown): JsonValue | undefined {
  return sanitizeToolInputWithMetadata(value).value;
}

export function sanitizeToolResultText(value: string): ClippedConversationText & { redacted: boolean } {
  const originalBytes = Buffer.byteLength(value);
  let safeText: string;
  let redacted = false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') {
      const safe = sanitizeToolInput(parsed);
      safeText = JSON.stringify(safe ?? {}, null, 2);
      redacted = JSON.stringify(safe ?? {}) !== JSON.stringify(parsed);
    } else {
      const safe = sanitizeToolText(value);
      safeText = safe.text;
      redacted = safe.redacted;
    }
  } catch {
    const safe = sanitizeToolText(value);
    safeText = safe.text;
    redacted = safe.redacted;
  }
  const clipped = clipConversationText(safeText);
  return {
    ...clipped,
    truncated: clipped.truncated || originalBytes > MAX_CONVERSATION_TEXT_BYTES,
    originalBytes,
    redacted,
  };
}

function safeToolExtensions(
  extensions: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (!extensions) return undefined;
  const output = { ...extensions };
  delete output['conversation.tool'];
  return Object.keys(output).length ? output : undefined;
}

function safeToolContent(content: readonly ConversationContentBlock[]): {
  content: ConversationContentBlock[];
  truncated: boolean;
  redacted: boolean;
  originalBytes: number;
} {
  const output: ConversationContentBlock[] = [];
  let remaining = MAX_CONVERSATION_TEXT_BYTES;
  let truncated = false;
  let redacted = false;
  let originalBytes = 0;
  for (const block of content.slice(0, MAX_TOOL_ENTRIES)) {
    if (block.type === 'text') {
      const safe = sanitizeToolResultText(block.text);
      const clipped = clipConversationText(safe.text, remaining);
      originalBytes += safe.originalBytes;
      truncated ||= safe.truncated || clipped.truncated;
      redacted ||= safe.redacted;
      if (clipped.text) {
        output.push({ type: 'text', text: clipped.text });
        remaining -= Buffer.byteLength(clipped.text);
      }
      continue;
    }
    if (block.type === 'json') {
      const safe = sanitizeToolInputWithMetadata(block.value);
      originalBytes += safe.originalBytes;
      truncated ||= safe.truncated;
      redacted ||= safe.redacted;
      if (safe.value !== undefined) output.push({ type: 'json', value: safe.value });
      continue;
    }
    if (block.type === 'external_link') {
      originalBytes += Buffer.byteLength(JSON.stringify(block));
      if (safePublicEndpoint(block.url)) output.push({ ...block });
      else redacted = true;
      continue;
    }
    output.push({ ...block });
  }
  if (content.length > MAX_TOOL_ENTRIES) truncated = true;
  return { content: output, truncated, redacted, originalBytes };
}

export function sanitizeConversationToolDraft(draft: ConversationItemDraft): ConversationItemDraft {
  const extensions = safeToolExtensions(draft.extensions);
  if (draft.kind === 'tool_call') {
    if (typeof draft.name !== 'string') return draft;
    const input = sanitizeToolInputWithMetadata(draft.input).value;
    const { input: _input, extensions: _extensions, ...base } = draft;
    return {
      ...base,
      name: clipConversationText(draft.name, 512).text || 'tool',
      ...(input === undefined ? {} : { input }),
      ...(extensions === undefined ? {} : { extensions }),
    };
  }
  if (draft.kind === 'tool_result') {
    if (!Array.isArray(draft.content)) return draft;
    const safe = safeToolContent(draft.content);
    const { extensions: _extensions, ...base } = draft;
    return {
      ...base, content: safe.content,
      ...(extensions === undefined ? {} : { extensions }),
    };
  }
  return draft;
}

export function sanitizeConversationToolItem(item: ConversationItem): ConversationItem {
  if (item.kind !== 'tool_call' && item.kind !== 'tool_result') return item;
  if (item.kind === 'tool_result') {
    if (!Array.isArray(item.content)) return item;
    const normalizedItem = item.status === 'truncated' && item.truncation?.reason === 'redacted'
      ? (({ truncation: _truncation, ...base }) => ({ ...base, status: 'complete' as const }))(item)
      : item;
    const safe = safeToolContent(item.content);
    const extensions = safeToolExtensions(item.extensions);
    const { content: _content, extensions: _extensions, ...base } = normalizedItem;
    return {
      ...base, content: safe.content,
      ...(extensions === undefined ? {} : { extensions }),
      ...(safe.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: safe.originalBytes },
      } : {}),
    } as ConversationItem;
  }
  const normalizedItem = item.status === 'truncated' && item.truncation?.reason === 'redacted'
    ? (({ truncation: _truncation, ...base }) => ({ ...base, status: 'complete' as const }))(item)
    : item;
  const input = sanitizeToolInputWithMetadata(item.input);
  const extensions = safeToolExtensions(item.extensions);
  const { input: _input, extensions: _extensions, ...base } = normalizedItem;
  return {
    ...base,
    name: clipConversationText(item.name, 512).text || 'tool',
    ...(input.value === undefined ? {} : { input: input.value }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(input.truncated ? {
      status: 'truncated' as const,
      truncation: { reason: 'size_limit' as const, originalBytes: input.originalBytes },
    } : {}),
  } as ConversationItem;
}
