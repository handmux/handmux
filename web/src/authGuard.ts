import { UnauthorizedError, ApiError } from './api.js';

// The ~15 App handlers all begin their catch with the same check: if the error is an auth failure, bounce
// to the auth prompt (onAuthFail). Their NON-auth behaviour differs (swallow / return / rethrow / cleanup),
// so this factors ONLY the shared detection: fire onAuthFail and report whether it WAS an auth failure, so
// each caller keeps its own control flow —
//   catch (e) { if (authHandled(e, onAuthFail)) return; ...non-auth... }
//   catch (e) { if (authHandled(e, onAuthFail)) throw e; throw new Error(friendly); }
//   catch (e) { authHandled(e, onAuthFail); }            // swallow non-auth
export function isOriginRejectedError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.code === 'origin_rejected' || error.code === 'AUTH_ORIGIN_REJECTED');
}

export type AuthPrompt = 'device' | 'token' | 'origin';

/** Keep an explicit device-authorization flow stable while stale requests finish. */
export function authPromptAfterFailure(current: AuthPrompt, error: unknown): AuthPrompt {
  if (current === 'device') return current;
  return isOriginRejectedError(error) || current === 'origin' ? 'origin' : 'token';
}

export function authHandled(error: unknown, onAuthFail?: (error: unknown) => void): boolean {
  if (error instanceof UnauthorizedError || isOriginRejectedError(error)) { onAuthFail?.(error); return true; }
  return false;
}
