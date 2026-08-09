import { randomBytes } from 'node:crypto';

const BOOTSTRAP_PREFIX = '/_browser-bootstrap/';

export interface BrowserBootstrapIssue {
  url: string;
  origin: string;
  deviceId: string;
  preserveMethod?: boolean;
  redirectStatus?: number;
}
export interface BrowserBootstrapEntry {
  url: string;
  origin: string;
  deviceId: string;
  preserveMethod: boolean;
  redirectStatus: number;
  expiresAt: number;
}
export type ConsumedBrowserBootstrap =
  | { url: string; deviceId: string }
  | { url: string; deviceId: string; preserveMethod: true; redirectStatus: number };

function normalizedOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('browser bootstrap origin must use http or https');
  return url.origin;
}

export function isBrowserBootstrapPath(pathname: unknown): boolean {
  return String(pathname || '').startsWith(BOOTSTRAP_PREFIX);
}

export function createBrowserBootstrapStore({
  randomToken = () => randomBytes(24).toString('base64url'),
  now = Date.now,
  ttlMs = 60_000,
}: {
  randomToken?: () => string;
  now?: () => number;
  ttlMs?: number;
} = {}) {
  const tickets = new Map<string, BrowserBootstrapEntry>();

  const prune = (): void => {
    const current = now();
    for (const [token, entry] of tickets) if (entry.expiresAt <= current) tickets.delete(token);
  };

  return {
    issue({
      url,
      origin,
      deviceId,
      preserveMethod = false,
      redirectStatus = 302,
    }: BrowserBootstrapIssue): string {
      prune();
      const expectedOrigin = normalizedOrigin(origin);
      const target = new URL(url);
      if (target.origin !== expectedOrigin || !target.pathname.split('/')[1]?.startsWith('_browser-')) {
        throw new Error('browser bootstrap target must be a session on its public origin');
      }
      const token = randomToken();
      tickets.set(token, {
        url: target.toString(),
        origin: expectedOrigin,
        deviceId,
        preserveMethod,
        redirectStatus,
        expiresAt: now() + ttlMs,
      });
      return new URL(`${BOOTSTRAP_PREFIX}${encodeURIComponent(token)}`, expectedOrigin).toString();
    },

    consume(pathname: unknown, origin: string): ConsumedBrowserBootstrap | null {
      prune();
      if (!isBrowserBootstrapPath(pathname)) return null;
      let token: string;
      try { token = decodeURIComponent(String(pathname).slice(BOOTSTRAP_PREFIX.length)); } catch { return null; }
      const entry = tickets.get(token);
      let requestedOrigin: string;
      try { requestedOrigin = normalizedOrigin(origin); } catch { return null; }
      if (!entry || entry.origin !== requestedOrigin) return null;
      tickets.delete(token);
      if (entry.preserveMethod) {
        return {
          url: entry.url,
          deviceId: entry.deviceId,
          preserveMethod: true,
          redirectStatus: entry.redirectStatus,
        };
      }
      return { url: entry.url, deviceId: entry.deviceId };
    },
  };
}
