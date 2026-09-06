import { describe, expect, it } from 'vitest';
import { ApiError, parseApiErrorBody, parseApiRecovery } from '../src/apiErrors.js';

describe('API error contract', () => {
  it('accepts the current envelope and remains compatible with an older error-only server', () => {
    expect(parseApiErrorBody({
      error: 'internal server error', code: 'internal_error', requestId: 'request-1',
    })).toEqual({
      error: 'internal server error', code: 'internal_error', requestId: 'request-1',
    });
    expect(parseApiErrorBody({ error: 'exists' })).toEqual({
      error: 'exists', code: null, requestId: null,
    });
  });

  it('rejects malformed transport data before it reaches UI error handling', () => {
    expect(parseApiErrorBody(null)).toBeNull();
    expect(parseApiErrorBody({ error: 500, code: 'internal_error' })).toBeNull();
  });

  it('accepts only an exact UUID-bound Codex recovery command', () => {
    const recovery = {
      kind: 'codex_resume',
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    expect(parseApiRecovery(recovery)).toEqual(recovery);
    expect(parseApiRecovery({ ...recovery, command: `${recovery.command}; rm -rf /tmp/x` })).toBeNull();
    expect(parseApiRecovery({ ...recovery, sessionId: 'not-a-uuid' })).toBeNull();
  });

  it('keeps correlation fields on the structured client error', () => {
    const error = new ApiError('failed', 500, 'failed', 'internal_error', 'request-1');
    expect(error).toMatchObject({
      name: 'ApiError', message: 'failed', status: 500, serverError: 'failed',
      code: 'internal_error', requestId: 'request-1',
    });
  });
});
