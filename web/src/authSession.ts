import { clearToken, getToken, setBrowserAccessEnabled } from './storage.js';
import { UnauthorizedError } from './apiErrors.js';
import { withAuthLock } from './authCoordination.js';

export type AuthMode = 'token' | 'trusted-device';
export interface PairingState {
  id: string;
  state: 'waiting' | 'configuring' | 'authorized' | 'expired' | 'canceled';
  code?: string;
  expiresAt: number;
  source?: 'cli' | 'web';
}
export interface AuthStatus {
  mode: AuthMode;
  authenticated: boolean;
  serverTime: number;
  pairing?: PairingState;
}

// Public mode/state only. All device credentials remain in server-issued HttpOnly cookies.
let mode: AuthMode = 'token';
let authenticated = false;
export const isDeviceAuth = (): boolean => mode === 'trusted-device';
export const hasDeviceSession = (): boolean => isDeviceAuth() && authenticated;
export function applyAuthStatus(status: AuthStatus): void {
  mode = status.mode;
  authenticated = status.authenticated;
  if (isDeviceAuth()) {
    try { clearToken(); } catch { /* device authentication never reads the legacy credential */ }
    // An old token-mode Browser opt-in must not silently re-create a device capability.
    if (!authenticated) { try { setBrowserAccessEnabled(false); } catch { /* storage may be disabled */ } }
  }
}

export function authenticationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(isDeviceAuth() ? { 'X-Handmux-Request': '1' } : { Authorization: `Bearer ${getToken() ?? ''}` }),
    ...extra,
  };
}

export async function authRequest(path = '/api/auth/status', method = 'GET', id?: string): Promise<AuthStatus> {
  return withAuthLock(async () => {
    const status = await performAuthRequest(path, method, id);
    // On HTTP, re-read the cookie that won across concurrent tabs instead of keeping a stale
    // initial POST candidate. An already-authorized primary cookie always wins on the server.
    return method === 'POST' && path === '/api/auth/pairing'
      ? performAuthRequest(path, 'GET') : status;
  });
}

export class AuthRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null) { super(`auth -> ${status}`); }
}

async function performAuthRequest(path: string, method: string, id?: string): Promise<AuthStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'X-Handmux-Request': '1', ...(id ? { 'Content-Type': 'application/json' } : {}) },
      ...(id ? { body: JSON.stringify({ id }) } : {}),
    });
    if (!response.ok) {
      let code: string | null = null;
      try { const body = await response.json() as { code?: unknown }; if (typeof body.code === 'string') code = body.code; } catch { /* proxy non-JSON */ }
      throw new AuthRequestError(response.status, code);
    }
    const value = await response.json() as AuthStatus;
    if (!value || !['token', 'trusted-device'].includes(value.mode)
      || typeof value.authenticated !== 'boolean' || !Number.isFinite(value.serverTime)) {
      throw new Error('Invalid authentication response');
    }
    return value;
  } finally { clearTimeout(timeout); }
}

// A reverse proxy can return 401 too. In cookie mode, only the auth authority may log the user out.
export async function confirmedSessionInvalid(): Promise<boolean> {
  try {
    const status = await authRequest();
    return status.mode !== 'trusted-device' || !status.authenticated;
  } catch { return false; }
}
export async function authenticationError(): Promise<Error> {
  return !isDeviceAuth() || await confirmedSessionInvalid()
    ? new UnauthorizedError() : new Error('Request rejected; could not confirm session invalidation');
}

export async function logoutDevice(): Promise<void> {
  const status = await authRequest('/api/auth/logout', 'POST');
  if (status.authenticated) throw new Error('Device is still authorized');
  applyAuthStatus(status);
}
