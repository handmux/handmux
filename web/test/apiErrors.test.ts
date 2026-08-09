import { describe, expect, it } from 'vitest';
import { ApiError, parseApiErrorBody } from '../src/apiErrors.js';

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

  it('keeps correlation fields on the structured client error', () => {
    const error = new ApiError('failed', 500, 'failed', 'internal_error', 'request-1');
    expect(error).toMatchObject({
      name: 'ApiError', message: 'failed', status: 500, serverError: 'failed',
      code: 'internal_error', requestId: 'request-1',
    });
  });
});
