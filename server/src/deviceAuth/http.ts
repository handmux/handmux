import { Router } from 'express';
import { bearerFrom } from '../auth.js';
import type { Request, Response } from 'express';
import { DeviceAuthError, DeviceAuthService, readSessionSecret, readPairingCookies, sessionCookieName, pairingCookieName } from './service.js';
import type { DevicePrincipal } from './service.js';

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
export function createDeviceAuthRouter({ service, resolveOrigin }: {
  service: DeviceAuthService; resolveOrigin: (req: Request) => string | null;
}): Router {
  const router = Router();
  // A tunnel can put every browser behind one loopback IP. Anonymous traffic must not spend an
  // authorized device's status/logout quota, including recovery before its primary cookie arrives.
  type Bucket = { at: number; requests: number; creates: number };
  const anonymousBuckets = new Map<string, Bucket>();
  const authenticatedBuckets = new Map<string, Bucket>();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache');
    const origin = resolveOrigin(req);
    if (!origin || (req.get('Origin') && req.get('Origin') !== origin)
      || (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== origin)) {
      res.status(403).json({ error: 'AUTH_ORIGIN_REJECTED', message: 'Open HandMux from its advertised address and retry' }); return;
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
      res.status(503).json({ error: 'AUTH_UNAVAILABLE', message: 'Authentication storage is unavailable; restart HandMux and retry' }); return;
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
  const status = (req: Request, res: Response): void => {
    const origin = String(res.locals.authOrigin);
    let secret = readSessionSecret(req, origin);
    let principal = service.authenticateRequest(req, origin);
    const formalPrincipal = principal;
    const candidate = selectCandidate(req, origin);
    // A late anonymous POST may overwrite only the candidate cookie, never a live session.
    // Existing primary sessions always win over another tab's pending/authorized candidate.
    if (!principal && candidate) { principal = service.authenticateSecret(candidate.secret, origin); if (principal) secret = candidate.secret; }
    if (principal && secret) setSessionCookie(res, origin, secret, principal.expiresAt);
    const pairing = candidate?.pairing;
    res.json({ mode: service.mode, tokenEnabled: service.tokenEnabled, authenticated: !!principal || !!tokenPrincipal(req, origin), currentDeviceId: formalPrincipal?.deviceId ?? null, ...(pairing ? { pairing } : {}), serverTime: Date.now() });
  };
  const safe = (handler: (req: Request, res: Response) => void) => (req: Request, res: Response): void => {
    try { handler(req, res); } catch (error) {
      if (error instanceof DeviceAuthError) res.status(error.status).json({ error: error.code, message: error.message });
      else res.status(503).json({ error: 'AUTH_UNAVAILABLE', message: 'Authentication storage is unavailable; restart HandMux and retry' });
    }
  };
  router.get('/status', safe(status));
  router.get('/pairing', safe(status));
  router.post('/pairing', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    if (service.authenticateRequest(req, origin)) { status(req, res); return; }
    const all = candidates(req, origin);
    for (const c of all) if (!c.pairing || c.pairing.state === 'expired' || c.pairing.state === 'canceled') setPairingCookie(res, origin, c.name, '');
    const candidate = selectCandidate(req, origin);
    if (candidate && service.authenticateSecret(candidate.secret, origin)) { status(req, res); return; }
    const result = service.createPairing(candidate?.secret ?? null, origin, browserSummary(req.get('user-agent') ?? ''));
    if (result.secret) setPairingCookie(res, origin, `${pairingCookieName(origin)}_${result.pairing.id.slice(5)}`, result.secret);
    res.json({ mode: service.mode, tokenEnabled: service.tokenEnabled, currentDeviceId: null, authenticated: false, pairing: result.pairing, serverTime: Date.now() });
  }));
  router.delete('/pairing', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const candidate = candidates(req, origin).find(c => c.pairing?.id === id);
    const pairing = service.cancelPairing(candidate?.secret ?? null, origin, id);
    res.json({ mode: service.mode, tokenEnabled: service.tokenEnabled, currentDeviceId: service.authenticateRequest(req, origin)?.deviceId ?? null, authenticated: !!service.authenticateRequest(req, origin), pairing, serverTime: Date.now() });
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
    const actor = service.authenticateRequest(req, String(res.locals.authOrigin));
    if (!actor) throw new DeviceAuthError('SESSION_INVALID', 'Sign in with an authorized device to manage devices', 401);
    service.assertActive(actor);
    const editingSelf = req.params.id === actor.deviceId && (req.method === 'PATCH' || req.method === 'DELETE');
    const secret = readSessionSecret(req, actor.origin);
    if (!editingSelf && secret) setSessionCookie(res, actor.origin, secret, actor.expiresAt);
    handler(req, res, actor);
  });
  router.get('/devices', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const actor = service.authenticateRequest(req, origin);
    if (!actor && !tokenPrincipal(req, origin)) throw new DeviceAuthError('SESSION_INVALID', 'Sign in to view trusted devices', 401);
    const secret = readSessionSecret(req, origin);
    if (actor && secret) setSessionCookie(res, origin, secret, actor.expiresAt);
    const devices = service.list().sort((a, b) => Number(b.id === actor?.deviceId) - Number(a.id === actor?.deviceId) || b.last_used_at - a.last_used_at || a.id.localeCompare(b.id));
    res.json({ devices, tokenEnabled: service.tokenEnabled, currentDeviceId: actor?.deviceId ?? null, serverTime: Date.now() });
  }));
  router.post('/devices/self', safe((req, res) => {
    const origin = String(res.locals.authOrigin);
    const actor = service.authenticateRequest(req, origin);
    if (actor) { res.json({ device: service.list().find(d => d.id === actor.deviceId), serverTime: Date.now() }); return; }
    if (!tokenPrincipal(req, origin)) throw new DeviceAuthError('SESSION_INVALID', 'Sign in with fixed Token login before adding this browser', 401);
    const candidate = selectCandidate(req, origin);
    if (!candidate) throw new DeviceAuthError('PAIRING_NOT_FOUND', 'Prepare this browser for registration and retry', 409);
    const device = service.registerSelf(candidate.secret, origin, { name: req.body?.name, expire: req.body?.expire });
    setSessionCookie(res, origin, candidate.secret, device.expires_at);
    res.json({ device, serverTime: Date.now() });
  }));
  router.post('/token/disable', manage((_req, res, actor) => {
    service.setTokenEnabled(false, { actor });
    res.json({ tokenEnabled: false, serverTime: Date.now() });
  }));
  router.patch('/devices/:id', manage((req, res, actor) => {
    const device = service.edit(String(req.params.id), { name: req.body?.name, expire: req.body?.expire, version: req.body?.version }, actor);
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
