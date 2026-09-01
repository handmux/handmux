import { ApiError, UnauthorizedError, parseApiErrorBody } from './apiErrors.js';
import { requestJson } from './apiRequest.js';
import { parseSseFrames } from './sse.js';
import { getToken } from './storage.js';
import type { AgentRunRef } from './agentCatalog.js';
import type {
  ConversationCapabilities,
  ConversationContentBlock,
  ConversationDelta,
  ConversationDescriptor,
  ConversationEvent,
  ConversationItem,
  ConversationItemDraft,
  ConversationPageResult,
  ConversationReason,
  ConversationSendReceipt,
  InterruptReceipt,
  JsonValue,
} from './agentConversationTypes.js';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,1023}$/;
const SEND_DELIVERIES = new Set(['prompt', 'steer', 'follow_up']);
const CONVERSATION_REASONS = new Set<ConversationReason>([
  'invalid_request', 'unsupported', 'stale_run', 'conflict',
  'provider_rejected', 'temporarily_unavailable', 'delivery_unconfirmed',
]);
const CONVERSATION_READY_TIMEOUT_MS = 20_000;
// The Server sends an SSE comment every 20 seconds. Three missed keepalives means the fetch body is no
// longer a useful live connection even when Safari still leaves reader.read() pending.
const CONVERSATION_SILENCE_TIMEOUT_MS = 60_000;

export interface ConversationCheckpoint {
  viewId: string;
  historyVersion: string;
  streamSequence: number;
}

export interface AgentConversationStreamOptions {
  signal?: AbortSignal;
  expectedViewId?: string;
  readyTimeoutMs?: number;
  silenceTimeoutMs?: number;
  onReady?: (checkpoint: ConversationCheckpoint) => void | Promise<void>;
  onEvent?: (event: ConversationEvent) => void | Promise<void>;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function withStreamDeadline<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const timer = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
      onTimeout();
    }, Math.max(0, timeoutMs));
    signal.addEventListener('abort', onAbort, { once: true });
    // Observe the operation even when the caller's signal was already aborted; fetch() otherwise rejects
    // after this wrapper returns and becomes an unhandled promise.
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function bounded(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runRef(value: unknown): AgentRunRef | null {
  const run = record(value);
  if (!run || !bounded(run.agentId, 64) || !bounded(run.paneId, 256) || !bounded(run.runId, 256)
    || (run.sessionId !== undefined && !bounded(run.sessionId, 1024))) return null;
  return {
    agentId: run.agentId, paneId: run.paneId, runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId as string }),
  };
}

function content(value: unknown): ConversationContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: ConversationContentBlock[] = [];
  for (const candidate of value) {
    const block = record(candidate);
    if (!block || typeof block.type !== 'string') return null;
    if (block.type === 'text' && bounded(block.text, 262_144, true)) {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'json' && jsonValue(block.value)) {
      blocks.push({ type: 'json', value: cloneJson(block.value) });
      continue;
    }
    if (block.type === 'resource' && bounded(block.resourceId, 256)
      && (block.name === undefined || bounded(block.name, 1024))
      && (block.mediaType === undefined || bounded(block.mediaType, 256))) {
      blocks.push({
        type: 'resource', resourceId: block.resourceId,
        ...(block.name === undefined ? {} : { name: block.name as string }),
        ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType as string }),
      });
      continue;
    }
    if (block.type === 'external_link' && bounded(block.url, 8192)
      && (block.name === undefined || bounded(block.name, 1024))) {
      try {
        const url = new URL(block.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      } catch { return null; }
      blocks.push({
        type: 'external_link', url: block.url,
        ...(block.name === undefined ? {} : { name: block.name as string }),
      });
      continue;
    }
    return null;
  }
  return blocks;
}

function draftBase(value: Record<string, unknown>): {
  correlationId?: string;
  groupingId?: string;
  extensions?: Record<string, JsonValue>;
} | null {
  if (value.correlationId !== undefined && !bounded(value.correlationId, 256)) return null;
  if (value.groupingId !== undefined && !bounded(value.groupingId, 256)) return null;
  if (value.extensions !== undefined && (!record(value.extensions) || !jsonValue(value.extensions))) return null;
  return {
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(value.groupingId === undefined ? {} : { groupingId: value.groupingId as string }),
    ...(value.extensions === undefined ? {} : {
      extensions: cloneJson(value.extensions) as Record<string, JsonValue>,
    }),
  };
}

export function parseConversationDraft(value: unknown): ConversationItemDraft | null {
  const item = record(value);
  if (!item || typeof item.kind !== 'string') return null;
  const base = draftBase(item);
  if (!base) return null;
  if (item.kind === 'message') {
    const blocks = content(item.content);
    return blocks && ['user', 'assistant', 'system'].includes(String(item.role))
      ? { kind: item.kind, ...base, role: item.role as 'user' | 'assistant' | 'system', content: blocks }
      : null;
  }
  if (item.kind === 'reasoning_summary') {
    return bounded(item.text, 262_144, true) ? { kind: item.kind, ...base, text: item.text } : null;
  }
  if (item.kind === 'tool_call') {
    if (!bounded(item.callId, 256) || !bounded(item.name, 512)
      || (item.input !== undefined && !jsonValue(item.input))
      || (item.summary !== undefined && !bounded(item.summary, 4096))) return null;
    return {
      kind: item.kind, ...base, callId: item.callId, name: item.name,
      ...(item.input === undefined ? {} : { input: cloneJson(item.input) }),
      ...(item.summary === undefined ? {} : { summary: item.summary as string }),
    };
  }
  if (item.kind === 'tool_result') {
    const blocks = content(item.content);
    if (!bounded(item.callId, 256) || !blocks
      || (item.isError !== undefined && typeof item.isError !== 'boolean')) return null;
    return {
      kind: item.kind, ...base, callId: item.callId, content: blocks,
      ...(item.isError === undefined ? {} : { isError: item.isError }),
    };
  }
  if (item.kind === 'diff') {
    if ((item.path !== undefined && !bounded(item.path, 4096))
      || (item.patch !== undefined && !bounded(item.patch, 262_144))
      || (item.summary !== undefined && !bounded(item.summary, 4096))) return null;
    return {
      kind: item.kind, ...base,
      ...(item.path === undefined ? {} : { path: item.path as string }),
      ...(item.patch === undefined ? {} : { patch: item.patch as string }),
      ...(item.summary === undefined ? {} : { summary: item.summary as string }),
    };
  }
  if (item.kind === 'compaction') {
    // A retained summary is conversation content, not a short UI label. Match the Server's standard
    // content bound so one valid long compaction cannot invalidate the entire page.
    return item.summary === undefined || bounded(item.summary, 262_144)
      ? { kind: item.kind, ...base, ...(item.summary === undefined ? {} : { summary: item.summary }) }
      : null;
  }
  if (item.kind === 'interrupt') {
    if (!['user', 'agent', 'system'].includes(String(item.actor))
      || (item.reason !== undefined && !bounded(item.reason, 1024))) return null;
    return {
      kind: item.kind, ...base, actor: item.actor as 'user' | 'agent' | 'system',
      ...(item.reason === undefined ? {} : { reason: item.reason as string }),
    };
  }
  if (item.kind === 'notice') {
    if (!['info', 'warning', 'error'].includes(String(item.level))
      || !bounded(item.message, 4096)
      || (item.code !== undefined && !bounded(item.code, 256))) return null;
    return {
      kind: item.kind, ...base, level: item.level as 'info' | 'warning' | 'error',
      ...(item.code === undefined ? {} : { code: item.code as string }), message: item.message,
    };
  }
  return null;
}

function parseConversationItem(value: unknown, sessionId: string): ConversationItem | null {
  const item = record(value);
  const draft = parseConversationDraft(value);
  if (!item || !draft || !bounded(item.id, 256) || !ID_RE.test(item.id)
    || item.sessionId !== sessionId
    || !['complete', 'error', 'truncated'].includes(String(item.status))
    || (item.sourceCreatedAt !== undefined
      && (typeof item.sourceCreatedAt !== 'number' || !Number.isFinite(item.sourceCreatedAt)))) return null;
  const error = record(item.error);
  const truncation = record(item.truncation);
  if (item.error !== undefined && (!error || !bounded(error.code, 256) || !bounded(error.message, 4096)
    || (error.retryable !== undefined && typeof error.retryable !== 'boolean'))) return null;
  if (item.truncation !== undefined && (!truncation
    || !['size_limit', 'provider_truncated', 'redacted', 'unavailable'].includes(String(truncation.reason))
    || (truncation.originalBytes !== undefined
      && (!Number.isSafeInteger(truncation.originalBytes) || Number(truncation.originalBytes) < 0)))) return null;
  if (item.status === 'error' && (!error || !bounded(error.code, 256) || !bounded(error.message, 4096))) return null;
  if (item.status === 'truncated' && (!truncation
    || !['size_limit', 'provider_truncated', 'redacted', 'unavailable'].includes(String(truncation.reason)))) return null;
  return {
    id: item.id, sessionId, status: item.status as ConversationItem['status'], ...draft,
    ...(item.sourceCreatedAt === undefined ? {} : { sourceCreatedAt: item.sourceCreatedAt as number }),
    ...(error ? { error: {
      code: error.code as string, message: error.message as string,
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    } } : {}),
    ...(truncation ? { truncation: {
      reason: truncation.reason as 'size_limit' | 'provider_truncated' | 'redacted' | 'unavailable',
      ...(Number.isSafeInteger(truncation.originalBytes)
        ? { originalBytes: truncation.originalBytes as number } : {}),
    } } : {}),
  } as ConversationItem;
}

function capabilities(value: unknown): ConversationCapabilities | null {
  const item = record(value);
  if (!item || item.history !== true || !['delta', 'settled', 'poll'].includes(String(item.live))) return null;
  if (item.send !== undefined && (!Array.isArray(item.send)
    || item.send.some((delivery) => !SEND_DELIVERIES.has(String(delivery)))
    || new Set(item.send).size !== item.send.length)) return null;
  if (item.interrupt !== undefined && item.interrupt !== true) return null;
  if (item.branching !== undefined && item.branching !== true) return null;
  if (item.sendable !== undefined && item.sendable !== true) return null;
  if (item.steer !== undefined && item.steer !== true) return null;
  return {
    history: true, live: item.live as ConversationCapabilities['live'],
    ...(item.sendable === true ? { sendable: true as const } : {}),
    ...(item.steer === true ? { steer: true as const } : {}),
    ...(item.send === undefined ? {} : { send: [...item.send] as NonNullable<ConversationCapabilities['send']> }),
    ...(item.interrupt === true ? { interrupt: true } : {}),
    ...(item.branching === true ? { branching: true } : {}),
  };
}

function parseDescriptor(value: unknown, agentId: string): ConversationDescriptor | null {
  const descriptor = record(value);
  const session = record(descriptor?.session);
  const caps = capabilities(descriptor?.capabilities);
  const run = descriptor?.run === undefined ? undefined : runRef(descriptor.run);
  const rawImplementation = descriptor?.implementation === undefined
    ? undefined : record(descriptor.implementation);
  const implementation = rawImplementation === undefined ? undefined
    : rawImplementation !== null
      && Number.isSafeInteger(rawImplementation.version)
      && Number(rawImplementation.version) > 0
      && (rawImplementation.reloadRequired === undefined
        || rawImplementation.reloadRequired === true)
      ? {
        version: Number(rawImplementation.version),
        ...(rawImplementation.reloadRequired === true ? { reloadRequired: true as const } : {}),
      }
      : null;
  if (!descriptor || !session || session.agentId !== agentId || !bounded(session.sessionId, 1024)
    || !bounded(descriptor.viewId, 1024) || !bounded(descriptor.historyVersion, 1024) || !caps
    || (descriptor.run !== undefined && !run) || implementation === null) return null;
  return {
    session: { agentId, sessionId: session.sessionId },
    viewId: descriptor.viewId,
    historyVersion: descriptor.historyVersion,
    capabilities: caps,
    ...(run ? { run } : {}),
    ...(implementation === undefined ? {} : { implementation }),
  };
}

async function post<T>(path: string, body: object, timeoutMs = 8_000): Promise<T> {
  return await requestJson<T>(path, {
    method: 'POST', body: JSON.stringify(body), timeoutMs,
  }) as T;
}

export async function discoverAgentConversation(run: AgentRunRef): Promise<ConversationDescriptor | null> {
  const response = record(await post<unknown>(
    '/api/agents/conversation/discover',
    { target: run },
    20_000,
  ));
  if (!response || response.descriptor === null) return null;
  const descriptor = parseDescriptor(response.descriptor, run.agentId);
  if (!descriptor || descriptor.session.sessionId !== run.sessionId) {
    throw new Error('Agent Conversation discovery returned an invalid descriptor');
  }
  if (descriptor.run && (descriptor.run.agentId !== run.agentId || descriptor.run.paneId !== run.paneId
    || descriptor.run.runId !== run.runId || descriptor.run.sessionId !== run.sessionId)) {
    throw new Error('Agent Conversation discovery returned a different run');
  }
  return descriptor;
}

export async function readAgentConversationPage(
  run: AgentRunRef,
  request: { before?: string; limit: number; expectedViewId?: string; expectedHistoryVersion?: string },
): Promise<ConversationPageResult> {
  if (!run.sessionId) throw new TypeError('Agent Conversation page requires a session-backed run');
  const sessionId = run.sessionId;
  const value = record(await post<unknown>('/api/agents/conversation/page', {
    run, request,
  }, 20_000));
  if (value?.status === 'stale' && bounded(value.currentViewId, 1024)
    && bounded(value.currentHistoryVersion, 1024)) {
    return {
      status: 'stale', currentViewId: value.currentViewId,
      currentHistoryVersion: value.currentHistoryVersion,
    };
  }
  const page = record(value?.page);
  if (value?.status !== 'ok' || !page || page.sessionId !== sessionId
    || !bounded(page.viewId, 1024) || !bounded(page.historyVersion, 1024)
    || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean'
    || (page.previousCursor !== undefined && !bounded(page.previousCursor, 1024))) {
    throw new Error('Agent Conversation page returned an invalid response');
  }
  const items = page.items.map((item) => parseConversationItem(item, sessionId));
  if (items.some((item) => item === null)) throw new Error('Agent Conversation page contains an invalid item');
  return {
    status: 'ok',
    page: {
      sessionId, viewId: page.viewId, historyVersion: page.historyVersion,
      items: items as ConversationItem[], hasMore: page.hasMore,
      ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
    },
  };
}

function parseDelta(value: unknown): ConversationDelta | null {
  const delta = record(value);
  if (delta?.op === 'item.replace') {
    const next = parseConversationDraft(delta.draft);
    return next ? { op: 'item.replace', draft: next } : null;
  }
  if (delta?.op !== 'text.append' || !bounded(delta.text, 262_144)
    || !['message.content', 'reasoning_summary.text', 'tool_result.content'].includes(String(delta.target))
    || (delta.blockIndex !== undefined
      && (!Number.isSafeInteger(delta.blockIndex) || Number(delta.blockIndex) < 0))) return null;
  return {
    op: 'text.append', target: delta.target as 'message.content' | 'reasoning_summary.text' | 'tool_result.content',
    ...(delta.blockIndex === undefined ? {} : { blockIndex: Number(delta.blockIndex) }), text: delta.text,
  };
}

function parseEvent(value: unknown, sessionId: string | undefined): ConversationEvent | null {
  const event = record(value);
  if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.sequence)
    || Number(event.sequence) < 0) return null;
  const sequence = Number(event.sequence);
  if (event.type === 'item.opened' && bounded(event.provisionalId, 256)) {
    const draft = parseConversationDraft(event.draft);
    return draft ? { type: event.type, sequence, provisionalId: event.provisionalId, draft } : null;
  }
  if (event.type === 'item.delta' && bounded(event.provisionalId, 256)) {
    const delta = parseDelta(event.delta);
    return delta ? { type: event.type, sequence, provisionalId: event.provisionalId, delta } : null;
  }
  if (event.type === 'item.settled' && bounded(event.provisionalId, 256)
    && (event.durableItemId === undefined || bounded(event.durableItemId, 256))) {
    const item = event.item === undefined || sessionId === undefined
      ? undefined : parseConversationItem(event.item, sessionId);
    if (event.item !== undefined && !item) return null;
    return {
      type: event.type, sequence, provisionalId: event.provisionalId,
      ...(event.durableItemId === undefined ? {} : { durableItemId: event.durableItemId as string }),
      ...(item ? { item } : {}),
    };
  }
  if (event.type === 'item.cancelled' && bounded(event.provisionalId, 256)
    && (event.reason === undefined
      || ['interrupted', 'superseded', 'provider_error', 'stream_reset'].includes(String(event.reason)))) {
    return {
      type: event.type, sequence, provisionalId: event.provisionalId,
      ...(event.reason === undefined ? {} : { reason: event.reason as 'interrupted' }),
    };
  }
  if (event.type === 'history.changed' && bounded(event.historyVersion, 1024)
    && bounded(event.viewId, 1024)) {
    return { type: event.type, sequence, historyVersion: event.historyVersion, viewId: event.viewId };
  }
  if (event.type === 'stream.gap' && Number.isSafeInteger(event.afterSequence)
    && Number(event.afterSequence) >= 0) {
    return { type: event.type, sequence, afterSequence: Number(event.afterSequence) };
  }
  return null;
}

function parseCheckpoint(value: unknown): ConversationCheckpoint | null {
  const checkpoint = record(value);
  return checkpoint && bounded(checkpoint.viewId, 1024) && bounded(checkpoint.historyVersion, 1024)
    && Number.isSafeInteger(checkpoint.streamSequence) && Number(checkpoint.streamSequence) >= 0
    ? {
      viewId: checkpoint.viewId, historyVersion: checkpoint.historyVersion,
      streamSequence: Number(checkpoint.streamSequence),
    } : null;
}

export async function streamAgentConversation(
  run: AgentRunRef,
  {
    signal,
    expectedViewId,
    readyTimeoutMs,
    silenceTimeoutMs,
    onReady,
    onEvent,
  }: AgentConversationStreamOptions = {},
): Promise<void> {
  const readyTimeout = positiveTimeout(readyTimeoutMs, CONVERSATION_READY_TIMEOUT_MS);
  const silenceTimeout = positiveTimeout(silenceTimeoutMs, CONVERSATION_SILENCE_TIMEOUT_MS);
  const readyDeadline = Date.now() + readyTimeout;
  const requestController = new AbortController();
  const abortRequest = (): void => requestController.abort();
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener('abort', abortRequest, { once: true });
  const query = new URLSearchParams({
    agentId: run.agentId, paneId: run.paneId, runId: run.runId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(expectedViewId ? { expectedViewId } : {}),
  });
  const path = `/api/agents/conversation/live?${query}`;
  try {
    const response = await withStreamDeadline(fetch(path, {
      cache: 'no-store', signal: requestController.signal,
      headers: { Authorization: `Bearer ${getToken() ?? ''}`, Accept: 'text/event-stream' },
    }), Math.max(0, readyDeadline - Date.now()), requestController.signal,
    'Agent Conversation live stream did not become ready', abortRequest);
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) {
      let body = null;
      try {
        body = parseApiErrorBody(await withStreamDeadline(
          response.json(),
          Math.max(0, readyDeadline - Date.now()),
          requestController.signal,
          'Agent Conversation live stream did not become ready',
          abortRequest,
        ));
      } catch { /* not json, aborted, or timed out */ }
      throw new ApiError(body?.error || `${path} -> ${response.status}`, response.status,
        body?.error, body?.code, body?.requestId);
    }
    if (!response.body?.getReader) throw new Error('Agent Conversation live stream is unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ready = false;
    let completed = false;
    try {
      while (true) {
        const timeout = ready ? silenceTimeout : Math.max(0, readyDeadline - Date.now());
        const { done, value } = await withStreamDeadline(
          reader.read(),
          timeout,
          requestController.signal,
          ready
            ? 'Agent Conversation live stream went silent'
            : 'Agent Conversation live stream did not become ready',
          abortRequest,
        );
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          let raw: unknown;
          try { raw = JSON.parse(frame) as unknown; } catch { throw new Error('Agent Conversation stream returned invalid JSON'); }
          const envelope = record(raw);
          if (envelope?.type === 'ready') {
            const checkpoint = parseCheckpoint(envelope.checkpoint);
            if (!checkpoint) throw new Error('Agent Conversation stream returned an invalid checkpoint');
            ready = true;
            await onReady?.(checkpoint);
            continue;
          }
          if (envelope?.type === 'event') {
            const event = parseEvent(envelope.event, run.sessionId);
            if (!event) throw new Error('Agent Conversation stream returned an invalid event');
            await onEvent?.(event);
            continue;
          }
          if (envelope?.type === 'error') throw new Error('Agent Conversation live stream became unavailable');
          throw new Error('Agent Conversation stream returned an unknown envelope');
        }
        if (done) {
          completed = true;
          break;
        }
      }
    } finally {
      if (!completed) {
        // Do not await cancel: the same WebKit half-open bug can leave that promise pending too. The fetch
        // controller is already aborted; cancellation here is best-effort resource cleanup.
        try { void reader.cancel().catch(() => {}); } catch { /* transport already closed */ }
      }
      try { reader.releaseLock(); } catch { /* a frozen pending read still owns the lock */ }
    }
  } finally {
    signal?.removeEventListener('abort', abortRequest);
  }
}

function sendReceipt(value: unknown): ConversationSendReceipt {
  const receipt = record(value);
  const submission = receipt?.submission === undefined ? undefined : record(receipt.submission);
  const submissionState = submission === undefined ? undefined
    : ['queued', 'dispatching', 'steering', 'unknown']
      .find((state) => state === submission?.state);
  const dispatchOrigin = submission?.dispatchOrigin === undefined ? undefined
    : ['direct', 'queue', 'steer'].find((origin) => origin === submission.dispatchOrigin);
  const steerAnchor = submission?.steerAnchor === undefined ? undefined : record(submission.steerAnchor);
  const baseline = submission?.baseline === undefined ? undefined : record(submission.baseline);
  if (!receipt || !['accepted', 'queued', 'rejected', 'unknown'].includes(String(receipt.status))
    || (receipt.nativeId !== undefined && !bounded(receipt.nativeId, 1024))
    || (receipt.nativeMutation !== undefined
      && receipt.nativeMutation !== false && receipt.nativeMutation !== 'unknown')
    || (receipt.reason !== undefined
      && (!bounded(receipt.reason, 64) || !CONVERSATION_REASONS.has(receipt.reason as ConversationReason)))
    || (receipt.submission !== undefined && (!submission
      || !bounded(submission.id, 256) || !bounded(submission.text, 262_144, true)
      || !submissionState || !Number.isSafeInteger(submission.revision) || Number(submission.revision) < 0
      || (submission.dispatchOrigin !== undefined && !dispatchOrigin)
      || (submission.nativeId !== undefined && !bounded(submission.nativeId, 1024))
      || (submission.baseline !== undefined && (!baseline
        || !bounded(baseline.viewId, 1024) || !bounded(baseline.historyVersion, 1024)
        || (baseline.tailItemId !== undefined && !bounded(baseline.tailItemId, 256))))
      || (submission.autoDispatchBlockedReason !== undefined
        && submission.autoDispatchBlockedReason !== 'provider_rejected')
      || (submission.steerActionId !== undefined && !bounded(submission.steerActionId, 256))
      || (submission.steerAnchor !== undefined && (!steerAnchor
        || !bounded(steerAnchor.viewId, 1024)
        || (steerAnchor.afterItemId !== undefined && !bounded(steerAnchor.afterItemId, 1024))))
      || (submission.queueOrderKey !== undefined && !bounded(submission.queueOrderKey, 256))
      || typeof submission.createdAt !== 'number' || !Number.isFinite(submission.createdAt)
      || typeof submission.updatedAt !== 'number' || !Number.isFinite(submission.updatedAt)))) {
    throw new Error('Agent Conversation send returned an invalid receipt');
  }
  return cloneJson(receipt) as unknown as ConversationSendReceipt;
}

export async function sendAgentConversationMessage(
  run: AgentRunRef,
  request: { clientRequestId: string; text: string; delivery: 'prompt' | 'steer' | 'follow_up' },
): Promise<ConversationSendReceipt> {
  return sendReceipt(await post('/api/agents/conversation/send', { run, request }));
}

export async function queryAgentConversationSubmission(
  run: AgentRunRef,
  request: { submissionId: string; actionId?: string },
): Promise<ConversationSendReceipt> {
  return sendReceipt(await post('/api/agents/conversation/submission/query', { run, ...request }));
}

export async function interruptAgentConversation(run: AgentRunRef): Promise<InterruptReceipt> {
  const receipt = record(await post('/api/agents/conversation/interrupt', { run }));
  if (!receipt || !['accepted', 'rejected', 'unknown'].includes(String(receipt.status))
    || (receipt.reason !== undefined
      && (!bounded(receipt.reason, 64) || !CONVERSATION_REASONS.has(receipt.reason as ConversationReason)))) {
    throw new Error('Agent Conversation interrupt returned an invalid receipt');
  }
  return cloneJson(receipt) as unknown as InterruptReceipt;
}

export async function downloadAgentConversationResource(
  agentId: string,
  sessionId: string,
  resource: { resourceId: string; name?: string; mediaType?: string },
): Promise<void> {
  if (!bounded(agentId, 64) || !bounded(sessionId, 1024)
    || !/^[a-zA-Z0-9_-]{16,256}$/.test(resource.resourceId)
    || (resource.name !== undefined && !bounded(resource.name, 1024))
    || (resource.mediaType !== undefined && !bounded(resource.mediaType, 256))) {
    throw new TypeError('Invalid Agent Conversation resource');
  }
  const query = new URLSearchParams({ agentId, sessionId, resourceId: resource.resourceId });
  const path = `/api/agents/conversation/resource?${query}`;
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, Accept: 'application/octet-stream' },
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    let body = null;
    try { body = parseApiErrorBody(await response.json()); } catch { /* not json */ }
    throw new ApiError(body?.error || `${path} -> ${response.status}`, response.status,
      body?.error, body?.code, body?.requestId);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  // Conversation metadata is display-only; keep provider slashes/control bytes out of the browser's
  // suggested filename even though the authenticated response independently forces attachment.
  anchor.download = resource.name?.replace(/[\\/\0-\x1f\x7f]/g, '_') || 'agent-resource';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
