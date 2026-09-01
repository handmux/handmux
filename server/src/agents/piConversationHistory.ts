import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  ConversationAdapterPage,
  ConversationContentBlock,
  ConversationItem,
} from '../agent-runtime/conversationTypes.js';
import type { AgentSessionRef } from '../agent-runtime/run.js';
import {
  sanitizeToolInputWithMetadata,
  sanitizeToolResultText,
} from './conversationProjectionSafety.js';

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 240 * 1024;
const ENTRY_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type JsonRecord = Record<string, unknown>;

interface PiSessionHeader extends JsonRecord {
  type: 'session';
  id: string;
  version: number;
}

interface PiSessionEntry extends JsonRecord {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
}

interface PiLiveSnapshot {
  runId: string;
  leafId?: string;
  sourceViewId: string;
  sessionFile?: string;
  implementationVersion?: number;
  items: ConversationItem[];
}

export interface PiConversationHistoryOptions {
  sessionsRoot: string;
  resolveFile?: (root: string, sessionId: string) => Promise<string | null>;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

/** Alias Pi's command tools onto the shared Codex command presentation contract. */
export function normalizePiCommandTool(
  name: string,
  input: unknown,
): { name: string; input: unknown } {
  if (name !== 'bash' && name !== 'shell') return { name, input };
  const args = record(input);
  if (!args) return { name, input };
  const command = typeof args.command === 'string' ? args.command
    : name === 'shell' && typeof args.cmd === 'string' ? args.cmd : undefined;
  if (command === undefined) return { name, input };
  const { command: _command, ...rest } = args;
  return { name: 'exec_command', input: { ...rest, cmd: command } };
}

function time(entry: PiSessionEntry, message?: JsonRecord): number | undefined {
  if (typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof entry.timestamp !== 'string') return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cappedText(
  value: unknown,
  maxBytes = MAX_TEXT_BYTES,
): { text: string; truncated: boolean; originalBytes: number } | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maxBytes) return { text: value, truncated: false, originalBytes };
  if (maxBytes <= 0) return { text: '', truncated: true, originalBytes };
  let text = Buffer.from(value).subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true, originalBytes };
}

function content(value: unknown, sanitizeToolResult = false): {
  blocks: ConversationContentBlock[];
  imageCount: number;
  truncated: boolean;
  redacted: boolean;
  originalBytes: number;
} {
  const raw = typeof value === 'string' ? [{ type: 'text', text: value }]
    : Array.isArray(value) ? value : [];
  const blocks: ConversationContentBlock[] = [];
  let imageCount = 0;
  let truncated = false;
  let redacted = false;
  let originalBytes = 0;
  let remainingBytes = MAX_TEXT_BYTES;
  for (const candidate of raw) {
    const block = record(candidate);
    if (block?.type === 'image') { imageCount += 1; continue; }
    if (block?.type !== 'text') continue;
    const rawText = typeof block.text === 'string' ? block.text : null;
    const safe = rawText !== null && sanitizeToolResult ? sanitizeToolResultText(rawText) : null;
    const normalized = cappedText(safe?.text ?? block.text, remainingBytes);
    if (!normalized) continue;
    if (normalized.text) {
      blocks.push({ type: 'text', text: normalized.text });
      remainingBytes -= Buffer.byteLength(normalized.text);
    }
    truncated ||= normalized.truncated || safe?.truncated === true;
    redacted ||= safe?.redacted === true;
    originalBytes += safe?.originalBytes ?? normalized.originalBytes;
  }
  return { blocks, imageCount, truncated, redacted, originalBytes };
}

function base(
  entry: PiSessionEntry,
  sessionId: string,
  id = `pi:${entry.id}`,
  message?: JsonRecord,
) {
  const createdAt = time(entry, message);
  return {
    id,
    sessionId,
    status: 'complete' as const,
    ...(createdAt === undefined ? {} : { sourceCreatedAt: createdAt }),
    extensions: { 'pi.entryId': entry.id },
  };
}

function textStatus(value: { truncated: boolean; redacted?: boolean; originalBytes: number }) {
  return value.truncated ? {
    status: 'truncated' as const,
    truncation: { reason: 'size_limit' as const, originalBytes: value.originalBytes },
  } : {};
}

function imageNotice(
  entry: PiSessionEntry,
  sessionId: string,
  count: number,
  suffix: string,
): ConversationItem | null {
  return count > 0 ? {
    ...base(entry, sessionId, `pi:${entry.id}:${suffix}`),
    kind: 'notice', level: 'info', code: 'image_unavailable',
    message: count === 1 ? 'Image attachment is available in the Pi terminal'
      : `${count} image attachments are available in the Pi terminal`,
  } : null;
}

function projectMessage(entry: PiSessionEntry, sessionId: string): ConversationItem[] {
  const message = record(entry.message);
  if (!message || typeof message.role !== 'string') return [];
  if (message.role === 'user') {
    const projected = content(message.content);
    const items: ConversationItem[] = projected.blocks.length ? [{
      ...base(entry, sessionId, undefined, message), ...textStatus(projected),
      kind: 'message', role: 'user', content: projected.blocks,
    }] : [];
    const notice = imageNotice(entry, sessionId, projected.imageCount, 'images');
    if (notice) items.push(notice);
    return items;
  }
  if (message.role === 'assistant') {
    const raw = Array.isArray(message.content) ? message.content : [];
    const textBlocks = content(raw);
    const items: ConversationItem[] = [];
    if (textBlocks.blocks.length) {
      const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
      const errorMessage = message.stopReason === 'aborted'
        ? 'Pi generation was interrupted' : 'Pi generation failed';
      items.push({
        ...base(entry, sessionId, undefined, message),
        ...(failed ? {
          status: 'error' as const,
          error: { code: message.stopReason === 'aborted' ? 'interrupted' : 'provider_error', message: errorMessage },
        } : textStatus(textBlocks)),
        kind: 'message', role: 'assistant', content: textBlocks.blocks,
      });
    } else if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      items.push({
        ...base(entry, sessionId, undefined, message),
        status: 'error',
        error: {
          code: message.stopReason === 'aborted' ? 'interrupted' : 'provider_error',
          message: message.stopReason === 'aborted'
            ? 'Pi generation was interrupted' : 'Pi generation failed',
        },
        kind: 'notice', level: 'error', code: 'generation_failed',
        message: message.stopReason === 'aborted'
          ? 'Pi generation was interrupted' : 'Pi generation failed',
      });
    }
    let tool = 0;
    for (const candidate of raw) {
      const block = record(candidate);
      // Pi persists raw thinking blocks without a user-visible summary marker. They are deliberately
      // omitted rather than relabelled as reasoning_summary.
      if (block?.type === 'toolCall' && typeof block.id === 'string'
        && ENTRY_ID_RE.test(block.id) && typeof block.name === 'string' && block.name) {
        const normalizedTool = normalizePiCommandTool(block.name, block.arguments);
        const inputProjection = sanitizeToolInputWithMetadata(normalizedTool.input);
        const input = inputProjection.value;
        items.push({
          ...base(entry, sessionId, `pi:${entry.id}:tool-${tool++}`, message),
          kind: 'tool_call', callId: `pi:${block.id}`, name: normalizedTool.name,
          ...(input === undefined ? {} : { input }),
          ...(inputProjection.truncated ? {
            status: 'truncated' as const,
            truncation: { reason: 'size_limit' as const, originalBytes: inputProjection.originalBytes },
          } : {}),
        });
      }
    }
    const notice = imageNotice(entry, sessionId, textBlocks.imageCount, 'images');
    if (notice) items.push(notice);
    return items;
  }
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    const projected = content(message.content, true);
    const items: ConversationItem[] = [{
      ...base(entry, sessionId, undefined, message), ...textStatus(projected),
      kind: 'tool_result', callId: `pi:${message.toolCallId}`, content: projected.blocks,
      ...(message.isError === true ? { isError: true } : {}),
    }];
    const notice = imageNotice(entry, sessionId, projected.imageCount, 'images');
    if (notice) items.push(notice);
    return items;
  }
  if (message.role === 'bashExecution') {
    const callId = `pi:${entry.id}:bash`;
    const safeOutput = sanitizeToolResultText(String(message.output ?? ''));
    const output = safeOutput.text ? safeOutput
      : {
        text: '', truncated: safeOutput.truncated, redacted: safeOutput.redacted,
        originalBytes: safeOutput.originalBytes,
      };
    const normalizedTool = normalizePiCommandTool(
      'bash', { command: String(message.command ?? '') },
    );
    const inputProjection = sanitizeToolInputWithMetadata(normalizedTool.input);
    const input = inputProjection.value;
    return [{
      ...base(entry, sessionId, `pi:${entry.id}:bash-call`, message),
      kind: 'tool_call', callId, name: normalizedTool.name,
      ...(input === undefined ? {} : { input }),
      ...(inputProjection.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: inputProjection.originalBytes },
      } : {}),
    }, {
      ...base(entry, sessionId, `pi:${entry.id}:bash-result`, message), ...textStatus(output),
      kind: 'tool_result', callId, content: output.text ? [{ type: 'text', text: output.text }] : [],
      ...((typeof message.exitCode === 'number' && message.exitCode !== 0) || message.cancelled === true
        ? { isError: true } : {}),
    }];
  }
  if (message.role === 'custom' && message.display === true) {
    const projected = content(message.content);
    const text = projected.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    return text ? [{
      ...base(entry, sessionId, undefined, message), ...textStatus(projected),
      kind: 'notice', level: 'info', code: typeof message.customType === 'string'
        && message.customType.length <= 256 ? message.customType : 'custom_message', message: text,
    }] : [];
  }
  if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
    const summary = cappedText(message.summary);
    return summary ? [{
      ...base(entry, sessionId, undefined, message), ...textStatus(summary),
      kind: 'compaction', summary: summary.text,
    }] : [];
  }
  return [];
}

function projectEntry(entry: PiSessionEntry, sessionId: string): ConversationItem[] {
  if (entry.type === 'message') return projectMessage(entry, sessionId);
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    const summary = cappedText(entry.summary);
    return [{
      ...base(entry, sessionId), ...(summary ? textStatus(summary) : {}),
      kind: 'compaction', ...(summary ? { summary: summary.text } : {}),
    }];
  }
  if (entry.type === 'custom_message' && entry.display === true) {
    return projectMessage({ ...entry, type: 'message', message: {
      role: 'custom', customType: entry.customType, content: entry.content,
      display: true, timestamp: Date.parse(entry.timestamp ?? ''),
    } }, sessionId);
  }
  if (entry.type === 'model_change' && typeof entry.provider === 'string'
    && typeof entry.modelId === 'string') {
    return [{
      ...base(entry, sessionId), kind: 'notice', level: 'info', code: 'model_changed',
      message: `Model changed to ${entry.provider}/${entry.modelId}`,
    }];
  }
  if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') {
    return [{
      ...base(entry, sessionId), kind: 'notice', level: 'info', code: 'thinking_level_changed',
      message: `Thinking level changed to ${entry.thinkingLevel}`,
    }];
  }
  return [];
}

function visibleText(item: ConversationItem): string | undefined {
  if (item.kind !== 'message' || item.role !== 'user') return undefined;
  const value = item.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  return value || undefined;
}

function mergeLiveItems(
  durable: ConversationItem[],
  live: ConversationItem[],
): ConversationItem[] {
  const ids = new Set(durable.map((item) => item.id));
  const merged = [...durable];
  const unmatchedDurableUsers = new Set(durable.flatMap((item, index) => (
    item.kind === 'message' && item.role === 'user' ? [index] : []
  )));
  for (const item of live) {
    if (ids.has(item.id)) continue;
    const pendingRequest = item.extensions?.['pi.pendingClientRequestId'];
    const pendingNativeText = item.extensions?.['pi.pendingNativeText'];
    const duplicateIndex = typeof pendingRequest === 'string' && item.sourceCreatedAt !== undefined
      ? [...unmatchedDurableUsers].find((index) => {
        const candidate = durable[index];
        return candidate !== undefined
        && candidate.kind === 'message' && candidate.role === 'user'
        && candidate.sourceCreatedAt === item.sourceCreatedAt
        && visibleText(candidate) === (typeof pendingNativeText === 'string'
          ? pendingNativeText : visibleText(item));
      }) : undefined;
    if (duplicateIndex !== undefined) {
      unmatchedDurableUsers.delete(duplicateIndex);
      continue;
    }
    ids.add(item.id);
    merged.push(structuredClone(item));
  }
  return merged;
}

export function projectPiLiveItems(values: readonly unknown[], sessionId: string): ConversationItem[] {
  const seen = new Set<string>();
  return values.flatMap((candidate) => {
    const value = record(candidate);
    if (!value || typeof value.type !== 'string' || typeof value.id !== 'string'
      || !ENTRY_ID_RE.test(value.id) || seen.has(value.id)) return [];
    const parentId = value.parentId;
    if (parentId !== null && (typeof parentId !== 'string' || !ENTRY_ID_RE.test(parentId))) return [];
    seen.add(value.id);
    return projectEntry({ ...value, type: value.type, id: value.id, parentId }, sessionId);
  });
}

export async function resolvePiSessionFile(root: string, sessionId: string): Promise<string | null> {
  const suffix = `_${sessionId}.jsonl`;
  let found: string | null = null;
  async function scan(directory: string, depth: number): Promise<void> {
    if (found || depth > 2) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(candidate, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(suffix)) found = candidate;
    }
  }
  await scan(root, 0);
  return found;
}

async function loadBranch(file: string, sessionId: string, requestedLeaf?: string): Promise<{
  leafId: string;
  entries: PiSessionEntry[];
}> {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) throw new Error('Pi session file is invalid or too large');
  const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
  const header = record(JSON.parse(lines.shift() ?? 'null')) as PiSessionHeader | null;
  if (!header || header.type !== 'session' || header.id !== sessionId
    || !Number.isSafeInteger(header.version) || header.version < 1 || header.version > 3) {
    throw new Error('Pi session header is invalid');
  }
  const entries: PiSessionEntry[] = [];
  const byId = new Map<string, PiSessionEntry>();
  let previousId: string | null = null;
  for (const line of lines) {
    const value = record(JSON.parse(line));
    if (!value || typeof value.type !== 'string' || typeof value.id !== 'string'
      || !ENTRY_ID_RE.test(value.id) || byId.has(value.id)) throw new Error('Pi session entry is invalid');
    const parentId = header.version === 1 ? previousId : value.parentId;
    if (parentId !== null && (typeof parentId !== 'string' || !ENTRY_ID_RE.test(parentId))) {
      throw new Error('Pi session parent is invalid');
    }
    const entry = { ...value, type: value.type, id: value.id, parentId } as PiSessionEntry;
    entries.push(entry);
    byId.set(entry.id, entry);
    previousId = entry.id;
  }
  if (requestedLeaf && requestedLeaf !== 'root' && !byId.has(requestedLeaf)) {
    throw new Error('Pi active leaf is not readable yet');
  }
  const leafId = requestedLeaf ?? entries.at(-1)?.id ?? 'root';
  if (leafId === 'root') return { leafId, entries: [] };
  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let current: PiSessionEntry | undefined = byId.get(leafId);
  while (current) {
    if (visited.has(current.id)) throw new Error('Pi session tree contains a cycle');
    visited.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error('Pi session tree contains a missing parent');
  }
  branch.reverse();
  return { leafId, entries: branch };
}

export class PiConversationHistory {
  readonly #sessionsRoot: string;
  readonly #resolveFile: (root: string, sessionId: string) => Promise<string | null>;
  readonly #activeLeaves = new Map<string, string>();
  readonly #activeViews = new Map<string, string>();
  readonly #liveSnapshots = new Map<string, PiLiveSnapshot>();

  constructor({ sessionsRoot, resolveFile = resolvePiSessionFile }: PiConversationHistoryOptions) {
    this.#sessionsRoot = sessionsRoot;
    this.#resolveFile = resolveFile;
  }

  setActiveLeaf(sessionId: string, leafId: string): void {
    if (!ENTRY_ID_RE.test(leafId)) throw new Error('Invalid Pi active leaf');
    this.#activeLeaves.set(sessionId, leafId);
    this.#activeViews.delete(sessionId);
  }

  setActiveView(sessionId: string, leafId: string, sourceViewId: string): void {
    if (!ENTRY_ID_RE.test(leafId) || typeof sourceViewId !== 'string'
      || sourceViewId.length === 0 || sourceViewId.length > 256) {
      throw new Error('Invalid Pi active view');
    }
    this.#activeLeaves.set(sessionId, leafId);
    this.#activeViews.set(sessionId, sourceViewId);
  }

  beginLive(sessionId: string, runId: string): void {
    const current = this.#liveSnapshots.get(sessionId);
    if (current?.runId === runId) return;
    const sourceViewId = `pi-live:${runId}`;
    this.#liveSnapshots.set(sessionId, {
      runId, sourceViewId, items: [],
    });
    this.#activeLeaves.delete(sessionId);
    this.#activeViews.delete(sessionId);
  }

  setLiveSnapshot(
    sessionId: string,
    runId: string,
    leafId: string,
    snapshot: { sessionFile?: string; implementationVersion?: number; items?: ConversationItem[] },
    sourceViewId?: string,
  ): void {
    const current = this.#liveSnapshots.get(sessionId);
    if (!current || current.runId !== runId || !ENTRY_ID_RE.test(leafId)
      || (sourceViewId !== undefined && (sourceViewId.length === 0 || sourceViewId.length > 256))
      || (snapshot.sessionFile !== undefined && (!path.isAbsolute(snapshot.sessionFile)
        || snapshot.sessionFile.length > 4096))
      || (snapshot.implementationVersion !== undefined
        && (!Number.isSafeInteger(snapshot.implementationVersion)
          || snapshot.implementationVersion <= 0))) {
      throw new Error('Invalid Pi live snapshot');
    }
    this.#liveSnapshots.set(sessionId, {
      runId,
      leafId,
      sourceViewId: sourceViewId ?? current.sourceViewId,
      ...(snapshot.sessionFile === undefined ? {} : { sessionFile: snapshot.sessionFile }),
      ...(snapshot.implementationVersion === undefined
        ? (current.implementationVersion === undefined
          ? {} : { implementationVersion: current.implementationVersion })
        : { implementationVersion: snapshot.implementationVersion }),
      items: snapshot.items ? structuredClone(snapshot.items) : current.items,
    });
  }

  async discover(sessionId: string): Promise<{
    sourceViewId: string;
    implementationVersion?: number;
  } | null> {
    const snapshot = await this.#snapshot(sessionId);
    if (!snapshot) return null;
    const live = this.#liveSnapshots.get(sessionId);
    return {
      sourceViewId: this.#sourceViewId(sessionId, snapshot.leafId),
      ...(live?.implementationVersion === undefined
        ? {} : { implementationVersion: live.implementationVersion }),
    };
  }

  async readPage(
    session: AgentSessionRef,
    request: { beforeSourceCursor?: string; limit: number },
  ): Promise<ConversationAdapterPage> {
    const snapshot = await this.#snapshot(session.sessionId);
    if (!snapshot) throw new Error('Pi session is unavailable');
    const all = snapshot.items;
    let end = all.length;
    if (request.beforeSourceCursor !== undefined) {
      if (!/^\d+$/.test(request.beforeSourceCursor)) throw new Error('Invalid Pi source cursor');
      const cursor = Number(request.beforeSourceCursor);
      if (!Number.isSafeInteger(cursor)) throw new Error('Invalid Pi source cursor');
      end = Math.min(cursor, all.length);
    }
    const start = Math.max(0, end - request.limit);
    return {
      sessionId: session.sessionId,
      sourceViewId: this.#sourceViewId(session.sessionId, snapshot.leafId),
      sourceHistoryToken: createHash('sha256').update(JSON.stringify(all)).digest('hex'),
      items: all.slice(start, end),
      ...(start > 0 ? { previousSourceCursor: String(start) } : {}),
      hasMore: start > 0,
    };
  }

  async #snapshot(sessionId: string): Promise<{ leafId: string; items: ConversationItem[] } | null> {
    const live = this.#liveSnapshots.get(sessionId);
    const file = live?.sessionFile ?? await this.#resolveFile(this.#sessionsRoot, sessionId);
    if (file) {
      try {
        const branch = await loadBranch(file, sessionId, live?.leafId ?? this.#activeLeaves.get(sessionId));
        return {
          leafId: branch.leafId,
          items: mergeLiveItems(
            branch.entries.flatMap((entry) => projectEntry(entry, sessionId)),
            live?.items ?? [],
          ),
        };
      } catch (error) {
        const code = error !== null && typeof error === 'object'
          ? (error as { code?: unknown }).code : undefined;
        if (!live || code !== 'ENOENT') throw error;
      }
    }
    return live ? { leafId: live.leafId ?? 'root', items: structuredClone(live.items) } : null;
  }

  #sourceViewId(sessionId: string, leafId: string): string {
    return this.#liveSnapshots.get(sessionId)?.sourceViewId
      ?? this.#activeViews.get(sessionId) ?? `pi-leaf:${leafId}`;
  }
}
