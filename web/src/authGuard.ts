import { UnauthorizedError } from './api.js';

// The ~15 App handlers all begin their catch with the same check: if the error is an auth failure, bounce
// to the token prompt (onAuthFail). Their NON-auth behaviour differs (swallow / return / rethrow / cleanup),
// so this factors ONLY the shared detection: fire onAuthFail and report whether it WAS an auth failure, so
// each caller keeps its own control flow —
//   catch (e) { if (authHandled(e, onAuthFail)) return; ...non-auth... }
//   catch (e) { if (authHandled(e, onAuthFail)) throw e; throw new Error(friendly); }
//   catch (e) { authHandled(e, onAuthFail); }            // swallow non-auth
export function authHandled(error: unknown, onAuthFail?: () => void): boolean {
  if (error instanceof UnauthorizedError) { onAuthFail?.(); return true; }
  return false;
}
