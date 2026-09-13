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
  fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...server, serverTime: Date.now() }) }));
  vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(() => {
  cleanup();
  applyAuthStatus({ mode: 'token', authenticated: false, serverTime: Date.now() });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('device pairing with CLI and trusted-device methods', () => {
  it('starts with an explicit request and does not show method tabs before a code exists', async () => {
    render(<DevicePairingPrompt onSaved={vi.fn()} />);
    await flush();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByPlaceholderText(t('token.placeholder'))).toBeNull();
    expect(fetcher.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method === 'GET')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('auth.request') }));
    await flush();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/pairing', expect.objectContaining({ method: 'POST' }));
  });

  it('switches complete method instructions without replacing the code or extending its deadline', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    const cli = screen.getByRole('tab', { name: t('auth.cliMethod') });
    const web = screen.getByRole('tab', { name: t('auth.webMethod') });
    expect(cli.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(t('auth.cliInstructions'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('auth.switchLink') }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.done') }));
    expect(screen.getByText('038271')).toBeTruthy();
    fireEvent.click(web);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(web.id);
    expect(screen.getByText(t('auth.webInstructions'))).toBeTruthy();
    expect(screen.getByText(t('auth.webPath'))).toBeTruthy();
    expect(screen.getByText(t('auth.webNext'))).toBeTruthy();
    expect(screen.getByText(t('auth.webFallback'))).toBeTruthy();
    expect(screen.getByText(t('auth.antiPhishing'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('auth.copyCommand') })).toBeNull();
    expect(screen.getByRole('button', { name: t('auth.copyCode') })).toBeTruthy();
    await tick(1000);
    fireEvent.click(cli);
    expect(screen.getByText('038271')).toBeTruthy();
    expect(screen.getByText(t('auth.codeRemaining', { seconds: 59 }))).toBeTruthy();
    expect(screen.getByText('handmux auth add 038271')).toBeTruthy();
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it('supports keyboard tab selection with focus and accessible selection state', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    const cli = screen.getByRole('tab', { name: t('auth.cliMethod') });
    const web = screen.getByRole('tab', { name: t('auth.webMethod') });
    fireEvent.keyDown(cli, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(web);
    expect(web.getAttribute('aria-selected')).toBe('true');
    expect(web.tabIndex).toBe(0); expect(cli.tabIndex).toBe(-1);
    fireEvent.keyDown(web, { key: 'Home' });
    expect(document.activeElement).toBe(cli);
    fireEvent.keyDown(cli, { key: 'End' });
    expect(document.activeElement).toBe(web);
    fireEvent.keyDown(web, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cli);
    expect(cli.getAttribute('aria-selected')).toBe('true');
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it.each(['cli', 'web'] as const)('uses actual %s approver source, not the selected instruction tab', async source => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    const onSaved = vi.fn();
    render(<DevicePairingPrompt onSaved={onSaved} />); await flush();
    fireEvent.click(screen.getByRole('tab', { name: t(source === 'cli' ? 'auth.webMethod' : 'auth.cliMethod') }));
    server.pairing = { id: 'pair_1', state: 'configuring', source, expiresAt: Date.now() + 300000 };
    await tick(1500);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('038271')).toBeNull();
    expect(screen.getByText(t(source === 'cli' ? 'auth.finishCli' : 'auth.finishWeb'))).toBeTruthy();
    expect(screen.queryByText(t(source === 'cli' ? 'auth.finishWeb' : 'auth.finishCli'))).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('restores and copies the same code, including its leading zero and exact shell command', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<DevicePairingPrompt onSaved={vi.fn()} />);
    await flush();
    expect(screen.getByText('038271')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('auth.copyCode') })); await flush();
    expect(writeText).toHaveBeenLastCalledWith('038271');
    fireEvent.click(screen.getByRole('button', { name: t('auth.copyCommand') })); await flush();
    expect(writeText).toHaveBeenLastCalledWith('handmux auth add 038271');
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it('selects visible text on HTTP clipboard failure without reporting success', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    fireEvent.click(screen.getByRole('button', { name: t('auth.copyCommand') })); await flush();
    expect(window.getSelection()?.toString()).toBe('handmux auth add 038271');
    expect(screen.getByText(t('auth.manualCopy'))).toBeTruthy();
    expect(screen.queryByText(t('auth.copied'))).toBeNull();
    await tick(1500);
    expect(screen.getByText(t('auth.manualCopy'))).toBeTruthy();
  });

  it('hides consumed codes and grants a fresh setup window without logging in before commit', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    const onSaved = vi.fn();
    render(<DevicePairingPrompt onSaved={onSaved} />); await flush();
    await tick(59000);
    server.pairing = { id: 'pair_1', state: 'configuring', source: 'cli', expiresAt: Date.now() + 300000 };
    await tick(1500);
    expect(screen.getByText(t('auth.pending'))).toBeTruthy();
    expect(screen.getByText(t('auth.finishCli'))).toBeTruthy();
    expect(screen.queryByText('038271')).toBeNull();
    expect(screen.queryByRole('button', { name: t('auth.copyCommand') })).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    server.authenticated = true;
    await tick(1500);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('uses the server deadline and does not automatically replace an expired request', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 1000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    await tick(1100);
    expect(screen.queryByText('038271')).toBeNull();
    expect(screen.getByText(t('auth.expired'))).toBeTruthy();
    expect(fetcher.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method === 'GET')).toBe(true);
  });

  it('cancels by the actual request ID and hides the old code after confirmation', async () => {
    server.pairing = { id: 'pair_1', state: 'waiting', code: '038271', expiresAt: Date.now() + 60000 };
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    server.pairing = { ...server.pairing, state: 'canceled' };
    fireEvent.click(screen.getByRole('button', { name: t('auth.cancelPairing') })); await flush();
    expect(fetcher).toHaveBeenLastCalledWith('/api/auth/pairing', expect.objectContaining({
      method: 'DELETE', body: '{"id":"pair_1"}',
    }));
    expect(screen.queryByText('038271')).toBeNull();
    expect(screen.getByText(t('auth.canceled'))).toBeTruthy();
  });

  it('recovers another tab\'s completed authorization on foreground without generating a new code', async () => {
    render(<DevicePairingPrompt onSaved={vi.fn()} />); await flush();
    server.authenticated = true;
    fireEvent(window, new Event('focus')); await flush();
    expect(fetcher.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method === 'GET')).toBe(true);
  });
});

describe('mode bootstrap', () => {
  it('does not mount business UI before checking the saved fixed Token with the auth authority', async () => {
    localStorage.setItem('tw_token', 'old-token');
    let resolve!: (value: unknown) => void;
    fetcher.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AuthBootstrap><div>Business UI</div></AuthBootstrap>);
    await flush();
    expect(screen.queryByText('Business UI')).toBeNull();
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer old-token');
    resolve({ ok: true, status: 200, json: async () => server }); await flush();
    expect(screen.getByText('Business UI')).toBeTruthy();
    expect(localStorage.getItem('tw_token')).toBe('old-token');
  });

  it('stays closed on network failure, with a retry instead of falling back to token login', async () => {
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
