import type {
  ConversationContentBlock,
  ConversationDelta,
  ConversationError,
  ConversationItem,
  ConversationItemDraft,
  ConversationTruncation,
  JsonValue,
} from './conversationTypes.js';
import { isIP } from 'node:net';

const ITEM_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const RESOURCE_ID_RE = /^[a-zA-Z0-9_-]{16,256}$/;
const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_BLOCK_BYTES = 256 * 1024;

export class ConversationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = MAX_BLOCK_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}

function optionalText(value: unknown, max = MAX_BLOCK_BYTES): value is string | undefined {
  return value === undefined || text(value, max);
}

function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value as Record<string, unknown>).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return false;
    if (isIP(host) === 4) {
      const octets = host.split('.').map(Number);
      if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
        || (octets[0] === 192 && octets[1] === 168)) return false;
    }
    if (isIP(host) === 6 && (host === '::' || /^fe[89ab][0-9a-f]:/i.test(host)
      || /^(fc|fd)/i.test(host) || /^::ffff:(0:)?(127\.|10\.|169\.254\.|192\.168\.)/i.test(host))) {
      return false;
    }
    return true;
  } catch { return false; }
}

function contentBlock(raw: unknown): ConversationContentBlock | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  if (raw.type === 'text') {
    return typeof raw.text === 'string' && Buffer.byteLength(raw.text) <= MAX_BLOCK_BYTES
      ? { type: 'text', text: raw.text } : null;
  }
  if (raw.type === 'json') {
    if (!jsonValue(raw.value)) return null;
    const value = cloneJson(raw.value);
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_BLOCK_BYTES ? { type: 'json', value } : null;
  }
  if (raw.type === 'resource') {
    if (typeof raw.resourceId !== 'string' || !RESOURCE_ID_RE.test(raw.resourceId)
      || !optionalText(raw.name, 1024) || !optionalText(raw.mediaType, 256)) return null;
    return {
      type: 'resource',
      resourceId: raw.resourceId,
      ...(raw.name === undefined ? {} : { name: raw.name }),
      ...(raw.mediaType === undefined ? {} : { mediaType: raw.mediaType }),
    };
  }
  if (raw.type === 'external_link') {
    if (!validExternalUrl(raw.url) || !optionalText(raw.name, 1024)) return null;
    return {
      type: 'external_link',
      url: raw.url,
      ...(raw.name === undefined ? {} : { name: raw.name }),
    };
  }
  return null;
}

function content(value: unknown): ConversationContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const blocks = value.map(contentBlock);
  return blocks.some((block) => block === null) ? null : blocks as ConversationContentBlock[];
}

function extensions(value: unknown, agentId: string): Record<string, JsonValue> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const out: Record<string, JsonValue> = {};
  for (const [key, extension] of Object.entries(value)) {
    if ((!key.startsWith(`${agentId}.`) && !key.startsWith('conversation.'))
      || key.length > 256 || !jsonValue(extension)) return null;
    out[key] = cloneJson(extension);
  }
  return out;
}

function errorValue(value: unknown): ConversationError | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !text(value.code, 256) || !text(value.message, 4096)
    || (value.retryable !== undefined && typeof value.retryable !== 'boolean')) return null;
  return {
    code: value.code,
    message: value.message,
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
  };
}

function truncationValue(value: unknown): ConversationTruncation | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || !['size_limit', 'provider_truncated', 'redacted', 'unavailable'].includes(String(value.reason))
    || (value.originalBytes !== undefined
      && (!Number.isSafeInteger(value.originalBytes) || Number(value.originalBytes) < 0))) return null;
  return {
    reason: value.reason as ConversationTruncation['reason'],
    ...(value.originalBytes === undefined ? {} : { originalBytes: value.originalBytes as number }),
  };
}

function relativePath(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (!text(value, 4096) || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)
    || value.split(/[\\/]/).includes('..')) return false;
  return true;
}

function draft(
  raw: Record<string, unknown>,
  agentId: string,
): ConversationItemDraft | null {
  const ext = extensions(raw.extensions, agentId);
  if (ext === null || !optionalText(raw.groupingId, 256)
    || !optionalText(raw.correlationId, 256)) return null;
  const base = {
    ...(raw.groupingId === undefined ? {} : { groupingId: raw.groupingId }),
    ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId }),
    ...(ext === undefined ? {} : { extensions: ext }),
  };
  if (raw.kind === 'message') {
    const blocks = content(raw.content);
    if (!blocks || !['user', 'assistant', 'system'].includes(String(raw.role))) return null;
    return {
      kind: 'message', ...base,
      role: raw.role as 'user' | 'assistant' | 'system', content: blocks,
    };
  }
  if (raw.kind === 'reasoning_summary') {
    return typeof raw.text === 'string' && Buffer.byteLength(raw.text) <= MAX_BLOCK_BYTES
      ? { kind: 'reasoning_summary', ...base, text: raw.text } : null;
  }
  if (raw.kind === 'tool_call') {
    if (!text(raw.callId, 256) || !text(raw.name, 512) || !optionalText(raw.summary, 4096)
      || (raw.input !== undefined && !jsonValue(raw.input))) return null;
    return {
      kind: 'tool_call', ...base, callId: raw.callId, name: raw.name,
      ...(raw.input === undefined ? {} : { input: cloneJson(raw.input) }),
      ...(raw.summary === undefined ? {} : { summary: raw.summary }),
    };
  }
  if (raw.kind === 'tool_result') {
    const blocks = content(raw.content);
    if (!text(raw.callId, 256) || !blocks
      || (raw.isError !== undefined && typeof raw.isError !== 'boolean')) return null;
    return {
      kind: 'tool_result', ...base, callId: raw.callId, content: blocks,
      ...(raw.isError === undefined ? {} : { isError: raw.isError }),
    };
  }
  if (raw.kind === 'diff') {
    if (!relativePath(raw.path) || !optionalText(raw.patch, MAX_BLOCK_BYTES)
      || !optionalText(raw.summary, 4096)) return null;
    return {
      kind: 'diff', ...base,
      ...(raw.path === undefined ? {} : { path: raw.path }),
      ...(raw.patch === undefined ? {} : { patch: raw.patch }),
      ...(raw.summary === undefined ? {} : { summary: raw.summary }),
    };
  }
  if (raw.kind === 'compaction') {
    return optionalText(raw.summary, MAX_BLOCK_BYTES)
      ? { kind: 'compaction', ...base, ...(raw.summary === undefined ? {} : { summary: raw.summary }) }
      : null;
  }
  if (raw.kind === 'interrupt') {
    if (!['user', 'agent', 'system'].includes(String(raw.actor)) || !optionalText(raw.reason, 1024)) return null;
    return {
      kind: 'interrupt', ...base, actor: raw.actor as 'user' | 'agent' | 'system',
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
    };
  }
  if (raw.kind === 'notice') {
    if (!['info', 'warning', 'error'].includes(String(raw.level))
      || !optionalText(raw.code, 256) || !text(raw.message, 4096)) return null;
    return {
      kind: 'notice', ...base, level: raw.level as 'info' | 'warning' | 'error',
      ...(raw.code === undefined ? {} : { code: raw.code }),
      message: raw.message,
    };
  }
  return null;
}

export function normalizeConversationDraft(
  raw: unknown,
  agentId: string,
): ConversationItemDraft {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    throw new ConversationValidationError('Invalid Conversation item draft');
  }
  const normalized = draft(raw, agentId);
  if (!normalized) throw new ConversationValidationError('Invalid Conversation item draft');
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_ITEM_BYTES) {
    throw new ConversationValidationError('Conversation item draft exceeds the size limit');
  }
  return normalized;
}

export function normalizeConversationItem(
  raw: unknown,
  agentId: string,
  sessionId: string,
): ConversationItem {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ITEM_ID_RE.test(raw.id)
    || raw.sessionId !== sessionId
    || !['complete', 'error', 'truncated'].includes(String(raw.status))
    || (raw.sourceCreatedAt !== undefined
      && (typeof raw.sourceCreatedAt !== 'number' || !Number.isFinite(raw.sourceCreatedAt)))) {
    throw new ConversationValidationError('Invalid durable Conversation item');
  }
  const draft = normalizeConversationDraft(raw, agentId);
  if ((draft.kind === 'reasoning_summary' && draft.text.length === 0)
    || ((draft.kind === 'message' || draft.kind === 'tool_result')
      && draft.content.some((block) => block.type === 'text' && block.text.length === 0))) {
    throw new ConversationValidationError('Durable Conversation items cannot contain empty text blocks');
  }
  const error = errorValue(raw.error);
  const truncation = truncationValue(raw.truncation);
  if (error === null || truncation === null || (raw.status === 'error' && error === undefined)
    || (raw.status === 'truncated' && truncation === undefined)) {
    throw new ConversationValidationError('Conversation item status metadata is invalid');
  }
  const item = {
    id: raw.id,
    sessionId,
    status: raw.status as ConversationItem['status'],
    ...(raw.sourceCreatedAt === undefined ? {} : { sourceCreatedAt: raw.sourceCreatedAt }),
    ...draft,
    ...(error === undefined ? {} : { error }),
    ...(truncation === undefined ? {} : { truncation }),
  } as ConversationItem;
  if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) {
    throw new ConversationValidationError('Conversation item exceeds the size limit');
  }
  return item;
}

function sameIdentity(first: ConversationItemDraft, second: ConversationItemDraft): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'message' && second.kind === 'message') return first.role === second.role;
  if (first.kind === 'tool_call' && second.kind === 'tool_call') return first.callId === second.callId;
  if (first.kind === 'tool_result' && second.kind === 'tool_result') return first.callId === second.callId;
  if (first.kind === 'interrupt' && second.kind === 'interrupt') return first.actor === second.actor;
  return true;
}

export function normalizeConversationDelta(
  raw: unknown,
  agentId: string,
  current: ConversationItemDraft,
): { delta: ConversationDelta; next: ConversationItemDraft } {
  if (!isRecord(raw) || (raw.op !== 'text.append' && raw.op !== 'item.replace')) {
    throw new ConversationValidationError('Invalid Conversation delta');
  }
  if (raw.op === 'item.replace') {
    const next = normalizeConversationDraft(raw.draft, agentId);
    if (!sameIdentity(current, next)) {
      throw new ConversationValidationError('Conversation delta cannot change provisional identity');
    }
    return { delta: { op: 'item.replace', draft: next }, next };
  }
  if (!text(raw.text) || !['message.content', 'reasoning_summary.text', 'tool_result.content']
    .includes(String(raw.target))
    || (raw.blockIndex !== undefined
      && (!Number.isSafeInteger(raw.blockIndex) || Number(raw.blockIndex) < 0))) {
    throw new ConversationValidationError('Invalid Conversation text delta');
  }
  const next = cloneJson(current);
  if (raw.target === 'reasoning_summary.text' && next.kind === 'reasoning_summary') {
    next.text += raw.text;
  } else if ((raw.target === 'message.content' && next.kind === 'message')
    || (raw.target === 'tool_result.content' && next.kind === 'tool_result')) {
    const index = raw.blockIndex === undefined ? next.content.length - 1 : Number(raw.blockIndex);
    const block = next.content[index];
    if (!block || block.type !== 'text') {
      throw new ConversationValidationError('Conversation text delta target is not a text block');
    }
    block.text += raw.text;
  } else {
    throw new ConversationValidationError('Conversation text delta target does not match its item');
  }
  const normalized = normalizeConversationDraft(next, agentId);
  return {
    delta: {
      op: 'text.append',
      target: raw.target,
      ...(raw.blockIndex === undefined ? {} : { blockIndex: Number(raw.blockIndex) }),
      text: raw.text as string,
    },
    next: normalized,
  };
}

export function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID_RE.test(value);
}
