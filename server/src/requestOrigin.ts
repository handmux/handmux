import type { IncomingMessage } from 'node:http';

function sameHost(origin: URL, hostHeader: string): boolean {
  try {
    const requestHost = new URL(`http://${hostHeader}`);
    const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
    // The backend may receive a Host without a port after TLS termination. In
    // that case, inherit the browser origin's default port; an explicit port
    // must still match exactly (443 remains equivalent to an omitted port).
    const explicitPort = hostHeader.match(/:(\d+)$/)?.[1];
    const requestPort = explicitPort ?? originPort;
    return origin.hostname === requestHost.hostname && originPort === requestPort;
  } catch { return false; }
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function browserProtocol(req: IncomingMessage, hostHeader: string): 'http' | 'https' | null {
  // Only a local TLS-terminating proxy may supply these implicit hints. For a
  // direct remote request, an Origin header is not transport proof and must not
  // turn an HTTP request into a trusted HTTPS origin.
  if (!isLoopback(req.socket.remoteAddress)) return null;
  const hinted = req.headers.origin;
  if (typeof hinted === 'string' && hinted !== 'null') {
    try {
      const origin = new URL(hinted);
      if (origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash
        && ['http:', 'https:'].includes(origin.protocol) && sameHost(origin, hostHeader)) {
        return origin.protocol === 'https:' ? 'https' : 'http';
      }
    } catch { /* fall through to the transport and cookie hints */ }
  }
  // TLS-terminating reverse proxies may omit X-Forwarded-Proto. A Secure HandMux
  // cookie is only sent by an HTTPS browser, so it provides a stable hint for the
  // follow-up GET that usually omits Origin.
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string' && /(?:^|;\s*)__Host-handmux_(?:session|pairing)(?:[_A-Za-z0-9-]*)?=/.test(cookie)) return 'https';
  return null;
}

/** Parse the effective request origin without deciding whether it is allowed. */
export function requestOrigin(req: IncomingMessage): string | null {
  const encrypted = 'encrypted' in req.socket && Boolean(req.socket.encrypted);
  const forwarded = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const hasForwardedHost = typeof forwardedHost === 'string' && forwardedHost.length > 0;
  const hostHeader = hasForwardedHost
    ? ((forwardedHost as string).split(',')[0] ?? '').trim() : req.headers.host;
  if (!hostHeader || /[\s,/@\\?#]/.test(hostHeader)) return null;
  const protocol = !encrypted && (forwarded === 'http' || forwarded === 'https')
    ? forwarded : encrypted ? 'https' : browserProtocol(req, hostHeader) ?? 'http';
  try { return new URL(`${protocol}://${hostHeader}`).origin; } catch { return null; }
}
