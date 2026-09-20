import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthBootstrap from './AuthBootstrap.js';
import { applyAuthStatus } from '../authSession.js';
import { t } from '../i18n';

let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  applyAuthStatus({ mode: 'token', authenticated: false, serverTime: Date.now() });
  fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const statusBody = (status: Record<string, unknown>) => ({
  mode: 'trusted-device', ...status, serverTime: Date.now(),
});
const statusResponse = (status: Record<string, unknown>) => Promise.resolve({
  ok: true, status: 200, json: async () => statusBody(status),
});

// The auth SCREENS render this brand line; nothing else does. Asserting on it is how these tests tell
// "a decided auth state" from "the pre-decision placeholder".
const authChrome = () => screen.queryByText('handmux');

it('shows no authentication chrome while the policy is still unknown', async () => {
  // A slow first paint must not look like a login screen: no brand, no card, no mode — just the page.
  let settle!: () => void;
  fetcher.mockImplementation(() => new Promise<Response>((resolve) => {
    settle = () => resolve({
      ok: true, status: 200, json: async () => statusBody({ originTrusted: true, authenticated: true }),
    } as Response);
  }));
  render(<AuthBootstrap><p>APP</p></AuthBootstrap>);
  // The first paint is the placeholder, before any request has even gone out.
  expect(authChrome()).toBeNull();
  expect(screen.queryByText(t('auth.connecting'))).toBeNull();
  expect(screen.queryByText('APP')).toBeNull();
  // Let the effect's request reach the network, then confirm the paint is still chrome-free.
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('status')).toBeTruthy(); // a quiet indicator, the only thing on screen
  expect(authChrome()).toBeNull();
  // The auth request is serialized behind a module-level lock, so a request left hanging here would hang
  // every later test in this file: settle it before leaving.
  await act(async () => { settle(); await Promise.resolve(); });
});

it('mounts the app once the origin is trusted, and never shows the auth screen on the way', async () => {
  fetcher.mockImplementation(() => statusResponse({ originTrusted: true, authenticated: true }));
  render(<AuthBootstrap><p>APP</p></AuthBootstrap>);
  expect(authChrome()).toBeNull();
  await waitFor(() => expect(screen.getByText('APP')).toBeTruthy());
  expect(authChrome()).toBeNull();
});

it('offers a retry without authentication chrome when the policy cannot be read at all', async () => {
  fetcher.mockImplementation(() => Promise.reject(new Error('offline')));
  render(<AuthBootstrap><p>APP</p></AuthBootstrap>);
  await waitFor(() => expect(screen.getByText(t('auth.connectionError'))).toBeTruthy());
  expect(authChrome()).toBeNull();
  // Retrying is a plain in-page action: the request goes out again and the app mounts when it succeeds.
  fetcher.mockImplementation(() => statusResponse({ originTrusted: true, authenticated: true }));
  fireEvent.click(screen.getByRole('button', { name: t('auth.retry') }));
  await waitFor(() => expect(screen.getByText('APP')).toBeTruthy());
});

it('still shows the real origin-rejected screen when the origin itself is untrusted', async () => {
  // This IS a decided authentication state, so the auth screen belongs here (brand and all).
  fetcher.mockImplementation(() => statusResponse({ originTrusted: false, authenticated: false }));
  render(<AuthBootstrap><p>APP</p></AuthBootstrap>);
  await waitFor(() => expect(authChrome()).toBeTruthy());
  expect(screen.queryByText('APP')).toBeNull();
});
