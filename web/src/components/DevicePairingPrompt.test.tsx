import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevicePairingPrompt from './DevicePairingPrompt.js';
import AuthBootstrap from './AuthBootstrap.js';
import { applyAuthStatus, type AuthStatus } from '../authSession.js';
import { t } from '../i18n';

let server: AuthStatus;
let fetcher: ReturnType<typeof vi.fn>;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  server = { mode: 'trusted-device', authenticated: false, serverTime: Date.now() };
  applyAuthStatus(server);
  fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'DELETE' && server.pairing) server.pairing = { ...server.pairing, state: 'canceled' };
    if (method === 'POST') {
      server.pairing = { id: 'pair_1', state: 'waiting', code: server.pairing?.code === '038271' ? '492610' : '038271', expiresAt: Date.now() + 60000 };
    }
    return { ok: true, status: 200, json: async () => ({ ...server, serverTime: Date.now() }) };
  });
  vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

afterEach(() => {
  cleanup();
  applyAuthStatus({ mode: 'token', authenticated: false, serverTime: Date.now() });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('device authorization flow', () => {
  it('requires the Token before showing the authorization page', async () => {
    server = { mode: 'trusted-device', tokenEnabled: true, tokenAuthenticated: false, authenticated: false, serverTime: Date.now() };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    expect(screen.getByLabelText('Token')).toBeTruthy();
    expect(screen.getByText(t('auth.tokenInvalid'))).toBeTruthy();
    expect(screen.queryByText(t('auth.deviceRequired'))).toBeNull();
  });

  it('automatically creates and displays one authorization code after the first factor', async () => {
    server = { mode: 'trusted-device', tokenEnabled: true, tokenAuthenticated: true, authenticated: false, serverTime: Date.now() };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    expect(screen.getByText(t('auth.deviceRequired'))).toBeTruthy();
    expect(screen.getByText('038271')).toBeTruthy();
    expect(screen.getByText(t('auth.codeRemaining', { seconds: 60 }))).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/pairing', expect.objectContaining({ method: 'POST' }));
  });

  it('presents CLI and authorized-device approval as two alternative methods', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    expect(screen.getByText(t('auth.chooseOneMethod'))).toBeTruthy();
    expect(screen.getByText('CLI')).toBeTruthy();
    expect(screen.getByText(t('auth.webMethod'))).toBeTruthy();
    expect(screen.queryByText(/^1$/)).toBeNull();
    expect(screen.queryByText(/^2$/)).toBeNull();
  });

  it('does not render the code until the initial status check completes', async () => {
    let resolve!: (value: unknown) => void;
    fetcher.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<DevicePairingPrompt onSaved={vi.fn()} />);
    expect(screen.getByText(t('common.loading'))).toBeTruthy();
    expect(screen.queryByText('038271')).toBeNull();
    resolve({ ok: true, status: 200, json: async () => ({ ...server, tokenAuthenticated: true, serverTime: Date.now() }) });
    await flush();
    expect(screen.getByText('038271')).toBeTruthy();
  });

  it('refreshes the code from the small action beside its label', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    fireEvent.click(screen.getByRole('button', { name: t('auth.refreshCode') }));
    await flush();
    expect(screen.getByText('492610')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/pairing', expect.objectContaining({ method: 'POST' }));
  });

  it('changes the countdown from blue to orange and then red', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 21000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    expect(screen.getByText(t('auth.codeRemaining', { seconds: 21 })).classList.contains('pairing-countdown-normal')).toBe(true);
    await tick(1000);
    expect(screen.getByText(t('auth.codeRemaining', { seconds: 20 })).classList.contains('pairing-countdown-warning')).toBe(true);
    await tick(10000);
    expect(screen.getByText(t('auth.codeRemaining', { seconds: 10 })).classList.contains('pairing-countdown-danger')).toBe(true);
  });

  it('shows a short completion state and signs in only after device setup is saved', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    const onSaved = vi.fn();
    render(<DevicePairingPrompt onSaved={onSaved} />); await flush();
    server.pairing = { id: 'pair_1', state: 'configuring', source: 'cli', expiresAt: Date.now() + 300000 };
    await tick(1500);
    expect(screen.getByText(t('auth.pending'))).toBeTruthy();
    expect(screen.getByText(t('auth.finishCli'))).toBeTruthy();
    expect(screen.queryByText('038271')).toBeNull();
    server.authenticated = true;
    await tick(1500);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('uses the server deadline and offers a fresh code after expiry', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 1000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    await tick(1100);
    expect(screen.getByText('------')).toBeTruthy();
    expect(screen.getByText(t('auth.codeExpired'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('auth.refreshCode') })).toBeTruthy();
    const callsAfterExpiry = fetcher.mock.calls.length;
    await tick(5000);
    expect(fetcher.mock.calls.length).toBe(callsAfterExpiry);
  });

  it('cancels by the actual request ID and returns to Token login', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    server.pairing = { ...server.pairing, state: 'canceled' };
    fireEvent.click(screen.getByRole('button', { name: t('auth.cancelPairing') })); await flush();
    expect(fetcher).toHaveBeenLastCalledWith('/api/auth/pairing', expect.objectContaining({
      method: 'DELETE', body: '{"id":"pair_1"}',
    }));
    expect(screen.getByLabelText('Token')).toBeTruthy();
    expect(screen.queryByText(t('auth.canceled'))).toBeNull();
  });

  it('recovers another tab’s completed authorization on foreground without generating a new code', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    server.authenticated = true;
    fireEvent(window, new Event('focus')); await flush();
    expect(fetcher.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method !== 'POST')).toBe(true);
  });
});

describe('mode bootstrap', () => {
  it('does not mount business UI before checking the saved Token with the auth authority', async () => {
    localStorage.setItem('tw_token', 'old-token');
    let resolve!: (value: unknown) => void;
    fetcher.mockReturnValue(new Promise(done => { resolve = done; }));
    render(<AuthBootstrap><div>Business UI</div></AuthBootstrap>);
    await flush();
    expect(screen.queryByText('Business UI')).toBeNull();
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer old-token');
    resolve({ ok: true, status: 200, json: async () => server }); await flush();
    expect(screen.getByText('Business UI')).toBeTruthy();
    expect(localStorage.getItem('tw_token')).toBe('old-token');
  });

  it('stays closed on network failure, with a retry instead of falling back to Token login', async () => {
    fetcher.mockRejectedValue(new Error('offline'));
    render(<AuthBootstrap><div>Business UI</div></AuthBootstrap>); await flush();
    expect(screen.queryByText('Business UI')).toBeNull();
    expect(screen.getByRole('button', { name: t('auth.retry') })).toBeTruthy();
  });

  it('can resolve device auth even when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<AuthBootstrap><div>Device mode ready</div></AuthBootstrap>); await flush();
    expect(screen.getByText('Device mode ready')).toBeTruthy();
  });
});
