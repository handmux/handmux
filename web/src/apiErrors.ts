export interface ApiErrorBody {
  error: string;
  code: string | null;
  requestId: string | null;
  recovery?: ApiRecovery;
}

export interface ApiRecovery {
  kind: 'codex_resume';
  sessionId: string;
  command: string;
}

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseApiRecovery(value: unknown): ApiRecovery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recovery = value as Record<string, unknown>;
  if (recovery.kind !== 'codex_resume' || typeof recovery.sessionId !== 'string'
    || !CODEX_SESSION_ID_RE.test(recovery.sessionId)
    || recovery.command !== `handmux codex resume ${recovery.sessionId}`) return null;
  return {
    kind: 'codex_resume',
    sessionId: recovery.sessionId,
    command: recovery.command,
  };
}

export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error !== 'string' || !record.error) return null;
  const recovery = parseApiRecovery(record.recovery);
  return {
    error: record.error,
    code: typeof record.code === 'string' && record.code ? record.code : null,
    requestId: typeof record.requestId === 'string' && record.requestId ? record.requestId : null,
    ...(recovery ? { recovery } : {}),
  };
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly serverError: string | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly recovery: ApiRecovery | null;

  constructor(
    message: string,
    status: number,
    serverError?: string | null,
    code?: string | null,
    requestId?: string | null,
    recovery?: ApiRecovery | null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.serverError = serverError ?? null;
    this.code = code ?? null;
    this.requestId = requestId ?? null;
    this.recovery = recovery ?? null;
  }
}

export class SpeechNotRecognizedError extends ApiError {
  constructor() {
    super(
      'Sentence ASR returned no recognized speech',
      502,
      'Sentence ASR returned no recognized speech',
      'speech_not_recognized',
    );
    this.name = 'SpeechNotRecognizedError';
  }
}
