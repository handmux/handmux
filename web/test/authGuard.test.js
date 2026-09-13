import { describe, it, expect, vi } from 'vitest';
import { authHandled } from '../src/authGuard.js';
import { UnauthorizedError } from '../src/api.js';

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
});
