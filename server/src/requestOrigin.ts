import type { IncomingMessage } from 'node:http';

/** Parse the effective request origin without deciding whether it is allowed. */
export function requestOrigin(req: IncomingMessage): string | null {
  const encrypted = 'encrypted' in req.socket && Boolean(req.socket.encrypted);
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = !encrypted && (forwarded === 'http' || forwarded === 'https')
    ? forwarded : encrypted ? 'https' : 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const hasForwardedHost = typeof forwardedHost === 'string' && forwardedHost.length > 0;
  const hostHeader = hasForwardedHost
    ? ((forwardedHost as string).split(',')[0] ?? '').trim() : req.headers.host;
  if (!hostHeader || /[\s,/@\\?#]/.test(hostHeader)) return null;
  try { return new URL(`${protocol}://${hostHeader}`).origin; } catch { return null; }
}
