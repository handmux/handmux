import { networkInterfaces } from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler, Response } from 'express';
import type { DevicePrincipal } from './deviceAuth/service.js';
import { originPatternMatches } from './deviceAuth/service.js';
import { readSessionSecret } from './deviceAuth/service.js';
import { setSessionCookie } from './deviceAuth/http.js';
import { withRequestAuthority } from './requestAuthority.js';
import { bearerFrom } from './auth.js';
import { requestOrigin } from './requestOrigin.js';
export type { DevicePrincipal } from './deviceAuth/service.js';

export interface DeviceAccessService {
  authenticateRequest(req: IncomingMessage, origin: string): DevicePrincipal | null;
  isActive(principal: DevicePrincipal): boolean;
  touch(principal: DevicePrincipal): void;
  onRevoke(listener: (deviceId: string) => void): () => void;
  readonly tokenEnabled?: boolean;
  authenticateToken?(provided: unknown, origin: string): DevicePrincipal | null;
}

/** Host and forwarded headers select a known entry point; they never create a trusted origin. */
export function createAuthOriginResolver({
  port, host, publicUrl, previewDomain, trustedOrigin = () => null, trustedOrigins = () => [], runtimePublicUrl = () => null,
}: {
  port: number; host: string; publicUrl?: string; previewDomain?: string;
  /** Persisted single-origin value retained for databases created before the list existed. */
  trustedOrigin?: () => string | null;
  trustedOrigins?: () => readonly string[];
  runtimePublicUrl?: () => string | null;
}): (req: IncomingMessage) => string | null {
  const local = new Set<string>();
  const add = (hostname: string): void => {
    if (!hostname || hostname === '0.0.0.0' || hostname === '::') return;
    try { local.add(new URL(`http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`).origin); } catch {}
  };
  for (const hostname of ['localhost', '127.0.0.1', '::1', host]) add(hostname);
  const configuredPatterns: string[] = [];
  if (previewDomain) {
    try {
      const url = new URL(/^https?:\/\//i.test(previewDomain) ? previewDomain : `https://${previewDomain}`);
      if (url.hostname && !url.hostname.includes('*')) configuredPatterns.push(`https://*.${url.hostname}`);
    } catch { /* an invalid preview domain is rejected by its own setup validation */ }
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (!entry.address.includes('%')) add(entry.address);
  }
  return (req) => {
    const origin = requestOrigin(req);
    if (!origin) return null;
    if (local.has(origin)) return origin;
    for (const known of [publicUrl, runtimePublicUrl()]) {
      if (!known) continue;
      try {
        const url = new URL(known);
        if (!url.username && !url.password && ['http:', 'https:'].includes(url.protocol) && url.origin === origin) return origin;
      } catch {}
    }
    for (const pattern of [trustedOrigin(), ...configuredPatterns, ...trustedOrigins()]) {
      if (!pattern) continue;
      if (originPatternMatches(pattern, origin)) return origin;
    }
    return null;
  };
}

export function createDeviceAccess({ service, resolveOrigin }: {
  service: DeviceAccessService;
  resolveOrigin: (req: IncomingMessage) => string | null;
}) {
  const responses = new Map<string, Set<Response>>();
  const stop = service.onRevoke((deviceId) => {
    for (const res of responses.get(deviceId) ?? []) res.destroy();
    responses.delete(deviceId);
  });
  const authenticate = (req: IncomingMessage): DevicePrincipal | null => {
    const origin = resolveOrigin(req);
    if (!origin) return null;
    const device = service.authenticateRequest(req, origin);
    const token = service.authenticateToken?.(
      bearerFrom(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined)
        ?? req.headers['x-handmux-token'], origin,
    ) ?? null;
    return device && token ? device : null;
  };
  const middleware: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = resolveOrigin(req);
    if (!origin || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      res.status(403).json({ error: 'untrusted request origin', code: 'origin_rejected' });
      return;
    }
    let principal: DevicePrincipal | null;
    try { principal = authenticate(req); } catch {
      res.status(503).json({ error: 'authentication storage unavailable', code: 'auth_unavailable' });
      return;
    }
    if (!principal) {
      res.status(401).json({ error: 'unauthorized', code: 'auth_required' });
      return;
    }
    res.locals.deviceAuth = principal;
    let accepted = false;
    const assertActive = (): void => {
      if (!accepted && !service.isActive(principal)) {
        throw Object.assign(new Error('Device authorization is no longer active'), { status: 401, code: 'auth_required' });
      }
    };
    // Accepted Agent/background jobs may continue after logout; not-yet-issued HTTP work may not.
    // Destroy/abort never marks a request accepted.
    res.once('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) accepted = true; });
    res.locals.assertDeviceActive = assertActive;
    const secret = readSessionSecret(req, origin);
    if (secret && !principal.deviceId.startsWith('token_')) setSessionCookie(res, origin, secret, principal.expiresAt);
    const group = responses.get(principal.deviceId) ?? new Set<Response>();
    group.add(res);
    responses.set(principal.deviceId, group);
    const cleanup = (): void => {
      group.delete(res);
      if (group.size === 0) responses.delete(principal.deviceId);
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    withRequestAuthority(assertActive, next);
  };
  return { middleware, authenticate, close: stop };
}
