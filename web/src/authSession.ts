import { getToken, setBrowserAccessEnabled } from './storage.js';
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
  tokenEnabled?: boolean;
  tokenAuthenticated?: boolean;
  trustedDeviceEnabled?: boolean;
  trustedOriginEnabled?: boolean;
  originTrusted?: boolean;
  requiresTrustedDevice?: boolean;
  currentDeviceId?: string | null;
  authenticated: boolean;
  serverTime: number;
  pairing?: PairingState;
}

// Public mode/state only. All device credentials remain in server-issued HttpOnly cookies.
let authenticated = false;
let currentDeviceId: string | null = null;
let tokenEnabled = false;
let trustedDeviceEnabled = true;
let trustedOriginEnabled = true;
export const isTokenEnabled = (): boolean => tokenEnabled;
export const isDeviceAuth = (): boolean => true;
export const isTrustedDeviceEnabled = (): boolean => trustedDeviceEnabled;
export const isTrustedOriginEnabled = (): boolean => trustedOriginEnabled;
export const hasAuthenticatedSession = (): boolean => authenticated;
export const hasDeviceSession = (): boolean => authenticated && currentDeviceId !== null;
export function applyAuthStatus(status: AuthStatus): void {
  authenticated = status.authenticated;
  currentDeviceId = status.currentDeviceId ?? null;
  tokenEnabled = status.tokenEnabled === true;
  trustedDeviceEnabled = status.trustedDeviceEnabled !== false;
  trustedOriginEnabled = status.trustedOriginEnabled !== false;
  if (isDeviceAuth()) {
    if (!authenticated) { try { setBrowserAccessEnabled(false); } catch { /* storage may be disabled */ } }
  }
}

function savedToken(): string | null { try { return getToken(); } catch { return null; } }

export function authenticationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = savedToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export async function authRequest(path = '/api/auth/status', method = 'GET', id?: string): Promise<AuthStatus> {
  return withAuthLock(async () => {
    const status = await performAuthRequest(path, method, id);
    if (status.authenticated && !status.currentDeviceId && status.pairing?.state === 'authorized') {
      return performAuthRequest('/api/auth/status', 'GET');
    }
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
      headers: { ...authenticationHeaders(), ...(id ? { 'Content-Type': 'application/json' } : {}) },
      ...(id ? { body: JSON.stringify({ id }) } : {}),
    });
    if (!response.ok) {
      let code: string | null = null;
      try { const body = await response.json() as { code?: unknown; error?: unknown }; const value = typeof body.code === 'string' ? body.code : body.error; if (typeof value === 'string') code = value; } catch { /* proxy non-JSON */ }
      throw new AuthRequestError(response.status, code);
    }
    const value = await response.json() as AuthStatus;
    if (!value || (value.mode !== 'trusted-device' && value.mode !== 'token')
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
    applyAuthStatus(status);
    return !status.authenticated;
  } catch { return false; }
}
export async function authenticationError(): Promise<Error> {
  // A transient 401 can be emitted by a reverse proxy while the server is
  // restarting. Never treat the absence of an in-memory device state as proof
  // of logout: Token-authenticated browsers intentionally have no device id,
  // and a freshly loaded app has not populated auth state yet. Only the auth
  // authority's explicit `authenticated: false` response can invalidate the
  // session; unavailable/failed status checks keep the current page mounted.
  return await confirmedSessionInvalid()
    ? new UnauthorizedError() : new Error('Request rejected; could not confirm session invalidation');
}

export async function logoutDevice(): Promise<void> {
  const status = await authRequest('/api/auth/logout', 'POST');
  if (status.authenticated) throw new Error('Device is still authorized');
  applyAuthStatus(status);
}
