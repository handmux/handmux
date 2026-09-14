import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAuthStatus, authenticationHeaders, authRequest, hasDeviceSession, logoutDevice } from './authSession.js';
import { requestJson } from './apiRequest.js';
import { UnauthorizedError } from './apiErrors.js';

const status = (authenticated = true) => ({ mode: 'trusted-device' as const, authenticated, currentDeviceId: authenticated ? 'dev_test' : null, tokenEnabled: false, serverTime: Date.now() });
const json = (body: unknown, code = 200) => ({ status: code, ok: code === 200, json: async () => body });
beforeEach(() => { localStorage.clear(); applyAuthStatus(status()); });
afterEach(() => {
  applyAuthStatus({ mode: 'trusted-device', tokenEnabled: true, currentDeviceId: null, authenticated: false, serverTime: Date.now() });
  vi.unstubAllGlobals();
});

describe('device authentication transport', () => {
  it('sends the Token together with a confirmed device session', async () => {
    localStorage.setItem('tw_token', 'old-shared-token');
    applyAuthStatus(status());
    expect(localStorage.getItem('tw_token')).toBe('old-shared-token');
    expect(authenticationHeaders()).toEqual({ Authorization: 'Bearer old-shared-token' });
    const fetcher = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await requestJson('/api/sessions');
    expect(fetcher).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      credentials: 'same-origin', cache: 'no-store', headers: { Authorization: 'Bearer old-shared-token' },
    }));
  });

  it('sends Bearer with origin protection when only Token login is available', () => {
    applyAuthStatus({ mode: 'trusted-device', tokenEnabled: true, currentDeviceId: null, authenticated: false, serverTime: Date.now() });
    localStorage.setItem('tw_token', 'legacy');
    expect(authenticationHeaders()).toEqual({ Authorization: 'Bearer legacy' });
  });

  it('does not treat a proxy 401 as a revoked device', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json(status()));
    vi.stubGlobal('fetch', fetcher);
    const result = requestJson('/api/sessions');
    await expect(result).rejects.not.toBeInstanceOf(UnauthorizedError);
    expect(fetcher).toHaveBeenLastCalledWith('/api/auth/status', expect.anything());
  });

  it('does not treat a proxy 401 as logout for a Token-authenticated browser', async () => {
    // Token auth has no currentDeviceId by design. It still must go through
    // the status authority before a restart-time 401 can clear the page.
    applyAuthStatus({ mode: 'trusted-device', tokenEnabled: true, tokenAuthenticated: true,
      currentDeviceId: null, authenticated: true, serverTime: Date.now() });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ mode: 'trusted-device', tokenEnabled: true, tokenAuthenticated: true,
        currentDeviceId: null, authenticated: true, serverTime: Date.now() }));
    vi.stubGlobal('fetch', fetcher);
    await expect(requestJson('/api/sessions')).rejects.not.toBeInstanceOf(UnauthorizedError);
  });

  it('only emits UnauthorizedError after the auth authority confirms invalidation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json(status(false))));
    await expect(requestJson('/api/sessions')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('preserves authorization on proxy failures or an unavailable status endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({}, 401)).mockRejectedValueOnce(new Error('offline')));
    await expect(requestJson('/api/sessions')).rejects.not.toBeInstanceOf(UnauthorizedError);
    expect(hasDeviceSession()).toBe(true);
  });

  it('does not claim unbinding succeeded when the server cannot confirm it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(logoutDevice()).rejects.toThrow();
    expect(hasDeviceSession()).toBe(true);
  });

  it('revokes via the server and only then marks the browser logged out', async () => {
    const fetcher = vi.fn(async () => json(status(false)));
    vi.stubGlobal('fetch', fetcher);
    await logoutDevice();
    expect(hasDeviceSession()).toBe(false);
    expect(fetcher).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('sends only the public request ID when canceling, never a code or secret', async () => {
    const fetcher = vi.fn(async () => json(status(false)));
    vi.stubGlobal('fetch', fetcher);
    await authRequest('/api/auth/pairing', 'DELETE', 'pair_123');
    expect(fetcher).toHaveBeenCalledWith('/api/auth/pairing', expect.objectContaining({
      method: 'DELETE', body: '{"id":"pair_123"}', credentials: 'same-origin',
    }));
  });
});
