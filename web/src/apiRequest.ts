import { getToken } from './storage.js';
import { ApiError, UnauthorizedError, parseApiErrorBody } from './apiErrors.js';

export interface JsonRequestOptions extends Omit<RequestInit, 'headers'> {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface UnchangedResponse {
  unchanged: true;
}

export type TerminalHistoryResponse = UnchangedResponse | {
  unchanged?: false;
  hash: string;
  ansi: string;
  alt: boolean;
  mouseAware?: boolean;
  width?: number;
  height?: number;
  historyLines?: number;
  cur?: { row: number; col: number; vis: boolean } | null;
};

export interface AsrSignResponse {
  url: string;
  appId: string;
}

export interface GoalResponse {
  goal?: import('../../server/src/codexStreamProtocol.js').CodexGoal | null;
}

export type JsonObjectResponse = Record<string, unknown>;

export async function requestJson<T = unknown>(
  path: string,
  opts: JsonRequestOptions = {},
): Promise<T | UnchangedResponse> {
  const token = getToken();
  const { timeoutMs, signal: externalSignal, ...rest } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ''}`,
    ...(rest.headers || {}),
  };
  if (rest.body) headers['Content-Type'] = 'application/json';
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const forwardAbort = (): void => controller?.abort();
  if (timeoutMs || externalSignal) {
    controller = new AbortController();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    if (timeoutMs) timer = setTimeout(() => controller?.abort(), timeoutMs);
  }
  try {
    const response = await fetch(path, {
      cache: 'no-store', ...rest, headers, signal: controller?.signal,
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
    if (response.status === 204) return { unchanged: true };
    return await response.json() as T;
  } catch (error: unknown) {
    if (controller?.signal.aborted && !externalSignal?.aborted) {
      throw new Error(`${path} -> timeout`);
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
