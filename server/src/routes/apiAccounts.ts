import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { ApiAccountInputError, ApiAccountService, ProviderQueryError } from '../apiAccounts.js';
import { PublicApiError } from '../apiErrors.js';

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const octets = host.split('.');
  const ipv4Loopback = octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return host === 'localhost' || ipv4Loopback || host === '::1' || host === '[::1]';
}

export function isCredentialTransportAllowed(req: Request): boolean {
  const origin = req.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHost(url.hostname));
    } catch { return false; }
  }
  const address = req.socket.remoteAddress ?? '';
  return loopbackHost(address) || address.startsWith('::ffff:127.');
}

function publicError(error: unknown): PublicApiError | null {
  if (error instanceof ProviderQueryError) {
    const status = error.code === 'invalid_credential' ? 422
      : error.code === 'rate_limited' ? 429
        : error.code === 'provider_timeout' ? 504 : 502;
    return new PublicApiError(status, error.code, error.code, error.retryAfterSeconds);
  }
  if (!(error instanceof ApiAccountInputError)) return null;
  const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409
    : error.code === 'account_limit_reached' ? 409
      : error.code === 'storage_unavailable' ? 503
        : error.code === 'request_cancelled' ? 499 : 400;
  return new PublicApiError(status, error.code, error.code);
}

function cancellationSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort);
  res.once('close', abort);
  return controller.signal;
}

function handler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      Promise.resolve(fn(req, res)).catch((error: unknown) => next(publicError(error) ?? error));
    } catch (error) {
      next(publicError(error) ?? error);
    }
  };
}

export function apiAccountRoutes({ service }: { service: ApiAccountService }): Router {
  const router = express.Router();
  router.use('/api-accounts', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/api-accounts', handler((_req, res) => { res.json(service.list()); }));
  router.post('/api-accounts', handler(async (req, res) => {
    if (!isCredentialTransportAllowed(req)) throw new PublicApiError(403, 'secure_transport_required', 'secure transport required');
    const account = await service.create(req.body ?? {}, cancellationSignal(req, res));
    res.status(201).json(account);
  }));
  router.patch('/api-accounts/:id', handler(async (req, res) => {
    if (req.body?.credential !== undefined && !isCredentialTransportAllowed(req)) {
      throw new PublicApiError(403, 'secure_transport_required', 'secure transport required');
    }
    res.json(await service.patch(String(req.params.id), req.body ?? {}, cancellationSignal(req, res)));
  }));
  router.delete('/api-accounts/:id', handler(async (req, res) => {
    await service.remove(String(req.params.id)); res.status(204).end();
  }));
  router.post('/api-accounts/:id/query', handler(async (req, res) => {
    res.json(await service.query(String(req.params.id)));
  }));
  return router;
}
