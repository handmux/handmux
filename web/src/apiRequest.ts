import { authenticationHeaders, authenticationError } from './authSession.js';
import { ApiError, parseApiErrorBody } from './apiErrors.js';
export type { AsrSessionResponse } from './voice/providerRegistry.js';

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

export async function requestJson<T = unknown>(
  path: string,
  opts: JsonRequestOptions = {},
): Promise<T | UnchangedResponse> {
  const { timeoutMs, signal: externalSignal, ...rest } = opts;
  const headers = authenticationHeaders(rest.headers);
  if (rest.body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
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
    let response = await fetch(path, {
      cache: 'no-store', credentials: 'same-origin', ...rest, headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    // During a service restart the proxy can briefly answer 401 while adjacent
    // requests are returning 502. Do not turn that transient response into a
    // full-page Token prompt; retry once, while a persistent 401 remains a real
    // authentication failure.
    if (response.status === 401 && headers.Authorization && !path.startsWith('/api/auth/')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      response = await fetch(path, {
        cache: 'no-store', credentials: 'same-origin', ...rest, headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
    }
    if (response.status === 401) throw await authenticationError();
    if (!response.ok) {
      let errorBody = null;
      try { errorBody = parseApiErrorBody(await response.json()); } catch { /* not json */ }
      throw new ApiError(
        errorBody?.error || `${path} -> ${response.status}`,
        response.status,
        errorBody?.error,
        errorBody?.code,
        errorBody?.requestId,
        errorBody?.recovery,
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
