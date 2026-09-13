import { Router } from 'express';
import { bearerFrom } from '../auth.js';
import type { Request, Response } from 'express';
import { DeviceAuthError, DeviceAuthService, readSessionSecret, readPairingCookies, sessionCookieName, pairingCookieName } from './service.js';
import type { DevicePrincipal } from './service.js';
import { requestOrigin } from '../requestOrigin.js';

export function setSessionCookie(res: Response, origin: string, secret: string, expiresAt: number | null, now = Date.now()): void {
  const maxAge = Math.max(0, Math.min(expiresAt === null ? 34_560_000_000 : expiresAt - now, 34_560_000_000));
  res.cookie(sessionCookieName(origin), secret, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'strict', path: '/', maxAge });
}
function setPairingCookie(res: Response, origin: string, name: string, secret: string): void {
  res.cookie(name, secret, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'strict', path: '/', maxAge: secret ? 900_000 : 0 });
}
function browserSummary(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /(?:iPhone|iPad|iPod)/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}
export function createDeviceAuthRouter({ service, resolveOrigin, resolvePublicUrl, previewDomain }: {
  service: DeviceAuthService; resolveOrigin: (req: Request) => string | null;
  /** The effective advertised entry point (config publicUrl or a runtime tunnel URL). */
  resolvePublicUrl?: () => string | null;
  /** Built-in browser proxy base; every lease uses an HTTPS subdomain below it. */
  previewDomain?: string | null;
}): Router {
  const router = Router();
  const advertisedOrigin = (): string | null => {
    const value = resolvePublicUrl?.();
    if (!value) return null;
    try { return new URL(value).origin; } catch { return null; }
  };
  const previewOrigin = (): string | null => {
    if (!previewDomain) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(previewDomain) ? previewDomain : `https://${previewDomain}`);
      return `https://*.${url.hostname}`;
    } catch { return null; }
  };
  // A tunnel can put every browser behind one loopback IP. Anonymous traffic must not spend an
  // authorized device's status/logout quota, including recovery before its primary cookie arrives.
  type Bucket = { at: number; requests: number; creates: number };
  const anonymousBuckets = new Map<string, Bucket>();
  const authenticatedBuckets = new Map<string, Bucket>();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache');
    const resolvedOrigin = resolveOrigin(req);
    // An unlisted host may only reach the status/pairing bootstrap. It still
    // needs the Token to create a pairing and can never touch business
    // or device-management routes before an approved device is enrolled.
    const origin = resolvedOrigin ?? requestOrigin(req);
    const pairingBootstrap = !resolvedOrigin && origin && (req.path === '/status' || req.path === '/pairing');
    if (!origin || (!pairingBootstrap && !resolvedOrigin)
      || (req.get('Origin') && req.get('Origin') !== origin)
      || (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== origin)) {
      res.status(403).json({ error: 'AUTH_ORIGIN_REJECTED', message: 'Open handmux from its trusted access address and retry' }); return;
    }
    res.locals.authOrigin = origin;
    let principal;
    try {
      principal = service.authenticateRequest(req, origin);
      if (!principal) {
        for (const candidate of readPairingCookies(req, origin)) {
          principal = service.authenticateSecret(candidate.secret, origin);
          if (principal) break;
        }
      }
    } catch {
      res.status(503).json({ error: 'AUTH_UNAVAILABLE', message: 'Authentication storage is unavailable; restart handmux and retry' }); return;
    }
    const now = Date.now();
    // Separate bounded maps reserve capacity for authenticated sessions even under anonymous floods.
    const buckets = principal ? authenticatedBuckets : anonymousBuckets;
    for (const [key, value] of buckets) if (now - value.at >= 60_000) buckets.delete(key);
    const key = principal ? principal.sessionId : req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 1024) { res.status(429).json({ error: 'AUTH_RATE_LIMIT', message: 'Wait one minute and try again' }); return; }
      bucket = { at: now, requests: 0, creates: 0 }; buckets.set(key, bucket);
    }
    bucket.requests++;
    if (req.method === 'POST' && req.path === '/pairing') bucket.creates++;
    if (bucket.requests > 600 || bucket.creates > 20) { res.set('Retry-After', '60').status(429).json({ error: 'AUTH_RATE_LIMIT', message: 'Wait one minute and try again' }); return; }
    next();
  });
  const candidates = (req: Request, origin: string) => readPairingCookies(req, origin).map(c => ({ ...c, pairing: service.pairing(c.secret, origin), principal: service.authenticateSecret(c.secret, origin) }));
  const selectCandidate = (req: Request, origin: string) => {
    const rank = (state?: string): number => state === 'authorized' ? 0 : state === 'configuring' ? 1 : state === 'waiting' ? 2 : 3;
    return candidates(req, origin).sort((a, b) => (a.principal ? 0 : rank(a.pairing?.state)) - (b.principal ? 0 : rank(b.pairing?.state)) || a.name.localeCompare(b.name))[0];
  };
  const tokenPrincipal = (req: Request, origin: string) => service.authenticateToken(bearerFrom(req.get('authorization')) ?? req.get('X-Handmux-Token'), origin);
  const accessPrincipal = (req: Request, origin: string): DevicePrincipal | null => {
    const device = service.authenticateRequest(req, origin);
    const token = tokenPrincipal(req, origin);
    if (!token) return null;
    return service.trustedDeviceEnabled ? device : token;
  };
  const status = (req: Request, res: Response): void => {
    const origin = String(res.locals.authOrigin);
    let secret = readSessionSecret(req, origin);
    const token = tokenPrincipal(req, origin);
    let principal = accessPrincipal(req, origin);
    const candidate = selectCandidate(req, origin);
    // A late anonymous POST may overwrite only the candidate cookie, never a live session.
    // Existing primary sessions always win over another tab's pending/authorized candidate.
    if (!principal && candidate && token) { principal = service.authenticateSecret(candidate.secret, origin); if (principal) secret = candidate.secret; }
    if (principal && secret) setSessionCookie(res, origin, secret, principal.expiresAt);
    const pairing = candidate?.pairing;
    res.json({ mode: service.mode, tokenEnabled: true, tokenAuthenticated: !!token,
      trustedDeviceEnabled: service.trustedDeviceEnabled, trustedOriginEnabled: service.trustedOriginEnabled,
      requiresTrustedDevice: service.requiresTrustedDevice && !principal, publicUrl: advertisedOrigin(), previewDomain: previewOrigin(), trustedOrigins: service.trustedOrigins, authenticated: !!principal,
      currentDeviceId: principal && !service.isTokenPrincipal(principal) ? principal.deviceId : null, ...(pairing ? { pairing } : {}), serverTime: Date.now() });
  };
  const safe = (handler: (req: Request, res: Response) => void) => (req: Request, res: Response): void => {
    try { handler(req, res); } catch (error) {
      if (error instanceof DeviceAuthError) res.status(error.status).json({ error: error.code, message: error.message });
      else res.status(503).json({ error: 'AUTH_UNAVAILABLE', message: 'Authentication storage is unavailable; restart handmux and retry' });
    }
  };
  router.get('/status', safe(status));
  router.get('/pairing', safe(status));
  router.post('/pairing', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const token = tokenPrincipal(req, origin);
    const access = accessPrincipal(req, origin);
    if (access && service.trustedDeviceEnabled) { status(req, res); return; }
    if (!token) throw new DeviceAuthError('TOKEN_REQUIRED', 'Enter the Token before requesting device authorization', 401);
    const all = candidates(req, origin);
    for (const c of all) if (!c.pairing || c.pairing.state === 'expired' || c.pairing.state === 'canceled') setPairingCookie(res, origin, c.name, '');
    const candidate = selectCandidate(req, origin);
    if (candidate && service.authenticateSecret(candidate.secret, origin)) { status(req, res); return; }
    const result = service.createPairing(candidate?.secret ?? null, origin, browserSummary(req.get('user-agent') ?? ''));
    if (result.secret) setPairingCookie(res, origin, `${pairingCookieName(origin)}_${result.pairing.id.slice(5)}`, result.secret);
    res.json({ mode: service.mode, tokenEnabled: true, tokenAuthenticated: true, trustedDeviceEnabled: service.trustedDeviceEnabled, trustedOriginEnabled: service.trustedOriginEnabled, requiresTrustedDevice: true, currentDeviceId: null, authenticated: false, pairing: result.pairing, serverTime: Date.now() });
  }));
  router.delete('/pairing', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const candidate = candidates(req, origin).find(c => c.pairing?.id === id);
    const pairing = service.cancelPairing(candidate?.secret ?? null, origin, id);
    const principal = accessPrincipal(req, origin);
    res.json({ mode: service.mode, tokenEnabled: true, tokenAuthenticated: !!tokenPrincipal(req, origin),
      trustedDeviceEnabled: service.trustedDeviceEnabled, trustedOriginEnabled: service.trustedOriginEnabled,
      requiresTrustedDevice: service.requiresTrustedDevice && !principal, currentDeviceId: principal && !service.isTokenPrincipal(principal) ? principal.deviceId : null, authenticated: !!principal, pairing, serverTime: Date.now() });
  }));
  const logout = (req: Request, res: Response): void => {
    const origin = String(res.locals.authOrigin); const principal = service.authenticateRequest(req, origin);
    if (principal) service.revoke(principal.deviceId);
    for (const c of candidates(req, origin)) {
      const authorized = service.authenticateSecret(c.secret, origin);
      if (authorized) service.revoke(authorized.deviceId);
      else if (c.pairing) service.cancelPairing(c.secret, origin, c.pairing.id);
      setPairingCookie(res, origin, c.name, '');
    }
    setSessionCookie(res, origin, '', 0); res.json({ ok: true, mode: service.mode, tokenEnabled: service.tokenEnabled, currentDeviceId: null, authenticated: false, serverTime: Date.now() });
  };
  router.post('/logout', safe(logout));
  // Management never promotes a candidate credential. A formal primary session is required at the
  // point of use, separately from the broader quota classification used by login recovery above.
  const manage = (handler: (req: Request, res: Response, actor: DevicePrincipal) => void) => safe((req, res) => {
    const actor = accessPrincipal(req, String(res.locals.authOrigin));
    if (!actor) throw new DeviceAuthError('SESSION_INVALID', 'Sign in with an authorized device to manage devices', 401);
    service.assertActive(actor);
    const editingSelf = req.params.id === actor.deviceId && (req.method === 'PATCH' || req.method === 'DELETE');
    const secret = readSessionSecret(req, actor.origin);
    if (!editingSelf && secret) setSessionCookie(res, actor.origin, secret, actor.expiresAt);
    handler(req, res, actor);
  });
  router.get('/devices', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const actor = accessPrincipal(req, origin);
    if (!actor) throw new DeviceAuthError('SESSION_INVALID', 'Sign in with the Token to view devices', 401);
    const secret = readSessionSecret(req, origin);
    if (actor && secret) setSessionCookie(res, origin, secret, actor.expiresAt);
    const devices = service.list().sort((a, b) => Number(b.id === actor?.deviceId) - Number(a.id === actor?.deviceId) || b.last_used_at - a.last_used_at || a.id.localeCompare(b.id));
    res.json({ devices, tokenEnabled: true, trustedDeviceEnabled: service.trustedDeviceEnabled, trustedOriginEnabled: service.trustedOriginEnabled, publicUrl: advertisedOrigin(), previewDomain: previewOrigin(), trustedOrigins: service.trustedOrigins, currentDeviceId: service.isTokenPrincipal(actor) ? null : actor.deviceId, serverTime: Date.now() });
  }));
  router.post('/devices/self', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const actor = service.authenticateRequest(req, origin);
    if (actor && tokenPrincipal(req, origin)) { res.json({ device: service.list().find(d => d.id === actor.deviceId), serverTime: Date.now() }); return; }
    if (!tokenPrincipal(req, origin)) throw new DeviceAuthError('SESSION_INVALID', 'Sign in with the Token before adding this browser', 401);
    const candidate = selectCandidate(req, origin);
    if (!candidate) throw new DeviceAuthError('PAIRING_NOT_FOUND', 'Prepare this browser for registration and retry', 409);
    const device = service.registerSelf(candidate.secret, origin, { name: req.body?.name, expire: req.body?.expire });
    setSessionCookie(res, origin, candidate.secret, device.expires_at);
    res.json({ device, serverTime: Date.now() });
  }));
  router.post('/trusted-origins', manage((req, res) => {
    const trustedOrigins = service.addTrustedOrigin(req.body?.origin);
    res.json({ trustedOrigins, serverTime: Date.now() });
  }));
  router.delete('/trusted-origins', manage((req, res) => {
    const trustedOrigins = service.removeTrustedOrigin(req.body?.origin);
    res.json({ trustedOrigins, serverTime: Date.now() });
  }));
  router.post('/trusted-origins/inspect', manage((req, res) => {
    res.json({ affectedDevices: service.inspectTrustedOriginRemoval(req.body?.origin), serverTime: Date.now() });
  }));
  router.patch('/devices/:id', manage((req, res, actor) => {
    if (req.body?.expire !== undefined) throw new DeviceAuthError('DEVICE_EXPIRY_CLI_ONLY', 'Change device expiry with the handmux CLI on the server', 403);
    const device = service.edit(String(req.params.id), { name: req.body?.name, version: req.body?.version }, actor);
    if (device.id === actor.deviceId) {
      const secret = readSessionSecret(req, actor.origin);
      if (secret) setSessionCookie(res, actor.origin, secret, device.expires_at);
    }
    res.json({ device, serverTime: Date.now() });
  }));
  router.delete('/devices/:id', manage((req, res, actor) => {
    if (req.params.id === actor.deviceId) { logout(req, res); return; }
    const device = service.revoke(String(req.params.id), actor);
    res.json({ device, serverTime: Date.now() });
  }));
  router.get('/approvals', manage((_req, res, actor) => res.json({ approvals: service.approvals(actor), serverTime: Date.now() })));
  router.post('/approvals', manage((req, res, actor) => res.json({ approval: service.claimWeb(req.body?.code, actor), serverTime: Date.now() })));
  router.get('/approvals/:id', manage((req, res, actor) => res.json({ approval: service.approval(actor, String(req.params.id)), serverTime: Date.now() })));
  router.delete('/approvals/:id', manage((req, res, actor) => res.json({ approval: service.cancelApproval(actor, String(req.params.id)), serverTime: Date.now() })));
  router.post('/approvals/:id/authorize', manage((req, res, actor) => res.json({ device: service.authorizeWeb(actor, String(req.params.id), { name: req.body?.name, expire: req.body?.expire }), serverTime: Date.now() })));
  return router;
}
