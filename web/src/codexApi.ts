import { getToken } from './storage.js';
import { ApiError, UnauthorizedError, parseApiErrorBody } from './apiErrors.js';
import { requestJson } from './apiRequest.js';
import type { JsonRequestOptions, UnchangedResponse } from './apiRequest.js';
import {
  parseCodexGoal,
  parseCodexProjectedStreamEvent,
  parseCodexStreamEvent,
} from '../../server/src/codexStreamProtocol.js';
import type {
  CodexGoal,
  CodexStreamEvent,
} from '../../server/src/codexStreamProtocol.js';
import {
  parseCodexQueueItem,
  parseCodexSendResult,
} from '../../server/src/codexQueueProtocol.js';
import type { CodexSendResult } from '../../server/src/codexQueueProtocol.js';

export interface CodexGoalResponse extends Record<string, unknown> {
  goal?: CodexGoal | null;
}

export interface CodexStreamOptions {
  signal?: AbortSignal;
  onEvent?: (event: CodexStreamEvent) => void;
  after?: number | null;
}

export interface ParsedSseFrames {
  frames: string[];
  rest: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUnchangedResponse(value: unknown): value is UnchangedResponse {
  const record = recordOf(value);
  return record?.unchanged === true;
}

async function codexJson<T>(
  path: string,
  options: JsonRequestOptions = {},
): Promise<T> {
  const value = await requestJson<T>(path, options);
  if (isUnchangedResponse(value)) throw new Error(`${path} returned no content`);
  return value as T;
}

function parseGoalResponse(value: unknown): CodexGoalResponse {
  const response = recordOf(value);
  if (!response) throw new Error('Codex goal returned an invalid response');
  if (!Object.hasOwn(response, 'goal')) return response;
  if (response.goal == null) return { ...response, goal: null };
  const goal = parseCodexGoal(response.goal);
  if (!goal) throw new Error('Codex goal returned an invalid response');
  return { ...response, goal };
}

export async function getCodexSession(pane: string): Promise<unknown> {
  const session = await codexJson<unknown>(
    `/api/codex/session?pane=${encodeURIComponent(pane)}`,
    { timeoutMs: 8_000 },
  );
  const response = recordOf(session);
  if (!response || !Array.isArray(response.queue)) return session;
  return {
    ...response,
    queue: response.queue.map(parseCodexQueueItem).filter((item) => item !== null),
  };
}

export function parseSseFrames(buffer: unknown): ParsedSseFrames {
  const frames: string[] = [];
  let rest = String(buffer || '');
  while (true) {
    const boundary = /\r?\n\r?\n/.exec(rest);
    if (!boundary) break;
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary[0].length);
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) frames.push(data);
  }
  return { frames, rest };
}

// Fetch-based SSE retains the bearer header that native EventSource cannot set. Durable transcript
// polling remains authoritative; this stream only projects ordered, runtime-validated Codex events.
export async function streamCodexMessages(
  pane: string,
  { signal, onEvent, after = null }: CodexStreamOptions = {},
): Promise<void> {
  const cursor = Number.isSafeInteger(after) && Number(after) >= 0 ? `&after=${after}` : '';
  const path = `/api/codex/stream?pane=${encodeURIComponent(pane)}${cursor}`;
  const response = await fetch(path, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, Accept: 'text/event-stream' },
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    let errorBody = null;
    try { errorBody = parseApiErrorBody(await response.json()); } catch { /* not json */ }
    throw new ApiError(
      errorBody?.error || `${path} -> ${response.status}`,
      response.status,
      errorBody?.error,
      errorBody?.code,
      errorBody?.requestId,
    );
  }
  if (!response.body?.getReader) throw new Error('Codex message stream is unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        let payload: unknown;
        try { payload = JSON.parse(frame) as unknown; } catch { continue; }
        const payloadRecord = recordOf(payload);
        const events = payloadRecord?.type === 'events' && Array.isArray(payloadRecord.events)
          ? payloadRecord.events
          : [payload];
        for (const candidate of events) {
          const control = parseCodexStreamEvent(candidate);
          const event = parseCodexProjectedStreamEvent(candidate)
            || (control && ['ready', 'cursorReset', 'conversationSnapshot', 'disconnected', 'error']
              .includes(control.type) ? control : null);
          if (!event) continue;
          if (event.type === 'error') throw new Error(event.message || 'Codex message stream failed');
          onEvent?.(event);
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

const post = <T = unknown>(path: string, body: object, timeoutMs = 8_000): Promise<T> => (
  codexJson<T>(path, { method: 'POST', body: JSON.stringify(body), timeoutMs })
);

export const takeoverCodexSession = (pane: string): Promise<unknown> => (
  post('/api/codex/takeover', { pane }, 30_000)
);

export async function sendCodexMessage(
  pane: string,
  text: string,
  requestId: string | null = null,
): Promise<CodexSendResult> {
  const result = await post('/api/codex/send', {
    pane,
    text,
    ...(requestId ? { requestId } : {}),
  });
  const parsed = parseCodexSendResult(result);
  if (!parsed) throw new Error('Codex send returned an invalid response');
  return parsed;
}

export const steerCodexQueuedMessage = (pane: string, id: string): Promise<Record<string, unknown>> => (
  post('/api/codex/queue/steer', { pane, id })
);
export const removeCodexQueuedMessage = (pane: string, id: string): Promise<Record<string, unknown>> => (
  post('/api/codex/queue/remove', { pane, id })
);
export const beginCodexQueuedEdit = (pane: string, id: string): Promise<unknown> => (
  post('/api/codex/queue/edit/begin', { pane, id })
);
export const renewCodexQueuedEdit = (pane: string, id: string, token: string): Promise<unknown> => (
  post('/api/codex/queue/edit/renew', { pane, id, token })
);
export const commitCodexQueuedEdit = (
  pane: string,
  id: string,
  token: string,
  text: string,
): Promise<unknown> => post('/api/codex/queue/edit/commit', { pane, id, token, text });
export const cancelCodexQueuedEdit = (pane: string, id: string, token: string): Promise<unknown> => (
  post('/api/codex/queue/edit/cancel', { pane, id, token })
);
export const compactCodexSession = (pane: string): Promise<unknown> => (
  post('/api/codex/compact', { pane })
);
export const clearCodexSession = (pane: string): Promise<unknown> => (
  post('/api/codex/clear', { pane })
);
export const getCodexModels = (pane: string): Promise<unknown> => (
  codexJson(`/api/codex/models?pane=${encodeURIComponent(pane)}`, { timeoutMs: 8_000 })
);
export async function getCodexGoal(pane: string): Promise<CodexGoalResponse> {
  return parseGoalResponse(await codexJson(
    `/api/codex/goal?pane=${encodeURIComponent(pane)}`,
    { timeoutMs: 8_000 },
  ));
}
export async function updateCodexGoal(
  pane: string,
  updates: object,
): Promise<CodexGoalResponse> {
  return parseGoalResponse(await post('/api/codex/goal', { pane, ...updates }));
}
export const clearCodexGoal = (pane: string): Promise<unknown> => (
  post('/api/codex/goal/clear', { pane })
);
export const updateCodexSettings = (pane: string, settings: object): Promise<unknown> => (
  post('/api/codex/settings', { pane, ...settings })
);
export const interruptCodexSession = (pane: string): Promise<unknown> => (
  post('/api/codex/interrupt', { pane })
);
export const answerCodexApproval = (
  pane: string,
  requestId: string,
  decision: unknown,
): Promise<unknown> => post('/api/codex/approval', { pane, requestId, decision });
export const answerCodexInput = (
  pane: string,
  requestId: string,
  answers: Record<string, string[]>,
): Promise<unknown> => post('/api/codex/input', { pane, requestId, answers });
