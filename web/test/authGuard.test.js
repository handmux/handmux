import { describe, it, expect, vi } from 'vitest';
import { authHandled, authPromptAfterFailure } from '../src/authGuard.js';
import { ApiError, UnauthorizedError } from '../src/api.js';

describe('authHandled', () => {
  it('an UnauthorizedError fires onAuthFail and reports true', () => {
    const onAuthFail = vi.fn();
    expect(authHandled(new UnauthorizedError(), onAuthFail)).toBe(true);
    expect(onAuthFail).toHaveBeenCalledOnce();
  });

  it('any other error does NOT fire onAuthFail and reports false', () => {
    const onAuthFail = vi.fn();
    expect(authHandled(new Error('boom'), onAuthFail)).toBe(false);
    expect(authHandled({ status: 500 }, onAuthFail)).toBe(false);
    expect(onAuthFail).not.toHaveBeenCalled();
  });

  it('tolerates a missing callback', () => {
    expect(authHandled(new UnauthorizedError())).toBe(true);
    expect(authHandled(new Error('x'))).toBe(false);
  });

  it('passes origin rejection through so the caller can show address guidance', () => {
    const onAuthFail = vi.fn();
    const error = new ApiError('untrusted request origin', 403, 'untrusted request origin', 'origin_rejected');
    expect(authHandled(error, onAuthFail)).toBe(true);
    expect(onAuthFail).toHaveBeenCalledWith(error);
  });

  it('keeps the explicit device authorization page when a stale request fails', () => {
    const error = new ApiError('untrusted request origin', 403, 'untrusted request origin', 'origin_rejected');
    expect(authPromptAfterFailure('device', error)).toBe('device');
    expect(authPromptAfterFailure('token', error)).toBe('origin');
  });
});
