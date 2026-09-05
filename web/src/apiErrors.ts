export interface ApiErrorBody {
  error: string;
  code: string | null;
  requestId: string | null;
}

export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error !== 'string' || !record.error) return null;
  return {
    error: record.error,
    code: typeof record.code === 'string' && record.code ? record.code : null,
    requestId: typeof record.requestId === 'string' && record.requestId ? record.requestId : null,
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

  constructor(
    message: string,
    status: number,
    serverError?: string | null,
    code?: string | null,
    requestId?: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.serverError = serverError ?? null;
    this.code = code ?? null;
    this.requestId = requestId ?? null;
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
