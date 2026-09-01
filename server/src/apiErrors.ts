import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';

export type ApiErrorCode = 'internal_error' | 'invalid_json' | 'not_found' | (string & {});

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  requestId: string;
  retryAfterSeconds?: number;
}

export interface ApiErrorLog {
  error(message: string, fields: Record<string, unknown>): void;
}

export interface ApiErrorOptions {
  idFactory?: () => string;
  log?: ApiErrorLog;
}

export class PublicApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PublicApiError';
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function requestIdFor(locals: Record<string, unknown>, idFactory: () => string): string {
  if (typeof locals.requestId === 'string' && locals.requestId) return locals.requestId;
  const requestId = idFactory();
  locals.requestId = requestId;
  return requestId;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  return { name: error.name, message: error.message, stack: error.stack };
}

function isInvalidJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError) || !error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 400 && candidate.type === 'entity.parse.failed';
}

export function apiRequestContext({ idFactory = randomUUID }: ApiErrorOptions = {}): RequestHandler {
  return (_req, res, next) => {
    const requestId = requestIdFor(res.locals, idFactory);
    res.setHeader('X-Request-Id', requestId);
    next();
  };
}

export function apiNotFound({ idFactory = randomUUID }: ApiErrorOptions = {}): RequestHandler {
  return (_req, res) => {
    const requestId = requestIdFor(res.locals, idFactory);
    res.setHeader('X-Request-Id', requestId);
    const body: ApiErrorBody = { error: 'not found', code: 'not_found', requestId };
    res.status(404).json(body);
  };
}

export function apiErrorBoundary({
  idFactory = randomUUID,
  log = console,
}: ApiErrorOptions = {}): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = requestIdFor(res.locals, idFactory);
    res.setHeader('X-Request-Id', requestId);
    let status = 500;
    let code: ApiErrorCode = 'internal_error';
    let message = 'internal server error';
    if (error instanceof PublicApiError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (isInvalidJson(error)) {
      status = 400;
      code = 'invalid_json';
      message = 'invalid json';
    }

    if (status >= 500) {
      log.error('[handmux] api error', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        error: errorFields(error),
      });
    }
    const retryAfterSeconds = error instanceof PublicApiError ? error.retryAfterSeconds : undefined;
    if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(retryAfterSeconds));
    const body: ApiErrorBody = {
      error: message, code, requestId,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
    res.status(status).json(body);
  };
}
