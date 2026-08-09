import http from 'node:http';
import net from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import { isBrowserBootstrapPath } from './bootstrap.js';
import { classifyIp } from './targetPolicy.js';

const SERVICE_PATHS = new Set([
  '/hammerhead.js',
  '/task.js',
  '/iframe-task.js',
  '/messaging',
  '/transport-worker.js',
  '/worker-hammerhead.js',
]);
const DEVICE_COOKIE = 'tw_browser_device';

interface BrowserPublicTarget { port: number }
interface BrowserPublicManager {
  resolvePublicRequest?(pathname: string, deviceId: string | null, origin: string | null): BrowserPublicTarget | null;
  hasDevice?(deviceId: string | null): boolean;
  ownsPublicPath?(pathname: string, deviceId: string | null): boolean;
  internalPorts?: number[];
}
interface BrowserBootstrapConsumer {
  consume(pathname: unknown, origin: string | null): {
    deviceId: string;
    url: string;
    preserveMethod?: boolean;
    redirectStatus?: number;
  } | null;
}

function sessionChannel(pathname: unknown): string | null {
  const descriptor = String(pathname || '').split('/')[1] || '';
  return descriptor.match(/\*([A-Za-z0-9_-]{1,128})$/)?.[1] || null;
}

function sessionUnavailableHtml(pathname: unknown): string {
  const channel = JSON.stringify(sessionChannel(pathname));
  return `<!doctype html><meta charset="utf-8">
<script>parent.postMessage({source:'handmux-browser',channel:${channel},type:'session-unavailable'},'*')</script>
<pre>{"error":"browser session unavailable"}</pre>`;
}

export function isBrowserServicePath(pathname: unknown): boolean {
  return SERVICE_PATHS.has(String(pathname || '').split('?')[0]);
}

function cookieValue(raw: unknown, name: string): string | null {
  for (const part of String(raw || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function browserTarget(
  browser: BrowserPublicManager,
  req: IncomingMessage,
  deviceId: string | null,
): BrowserPublicTarget | null {
  const pathname = String(req.url || '').split('?')[0];
  if (!claimedBrowserRequest(req)) return null;
  if (typeof browser.resolvePublicRequest === 'function') {
    return browser.resolvePublicRequest(pathname, deviceId, browserRequestOrigin(req));
  }
  const allowed = isBrowserServicePath(pathname)
    ? browser.hasDevice?.(deviceId) : browser.ownsPublicPath?.(pathname, deviceId);
  const port = browser.internalPorts?.[0];
  return allowed && typeof port === 'number' ? { port } : null;
}

function isLoopback(address: unknown): boolean {
  return classifyIp(address) === 'loopback';
}

export function browserRequestOrigin(req: IncomingMessage): string | null {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = isLoopback(req.socket?.remoteAddress) && (forwardedProto === 'http' || forwardedProto === 'https')
    ? forwardedProto
    : (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers.host;
  if (!host) return null;
  try { return new URL(`${protocol}://${host}`).origin; } catch { return null; }
}

export function claimedBrowserRequest(req: IncomingMessage): boolean {
  const pathname = String(req.url || '').split('?')[0];
  return isBrowserBootstrapPath(pathname)
    || isBrowserServicePath(pathname)
    || String(pathname).split('/')[1]?.startsWith('_browser-');
}

function filteredCookie(raw: unknown): string {
  const values = String(raw || '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !value.startsWith('tw_preview=') && !value.startsWith(`${DEVICE_COOKIE}=`));
  return values.join('; ');
}

function expectsDocument(req: IncomingMessage): boolean {
  const destination = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const accept = String(req.headers.accept || '').toLowerCase();
  return destination === 'document' || destination === 'iframe' || accept.includes('text/html');
}

function upstreamHeaders(headers: IncomingHttpHeaders, port: number, token?: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers, host: `127.0.0.1:${port}` };
  if (token && out.authorization === `Bearer ${token}`) delete out.authorization;
  delete out['proxy-authorization'];
  if (out.cookie) {
    out.cookie = filteredCookie(out.cookie);
    if (!out.cookie) delete out.cookie;
  }
  return out;
}

export function createBrowserPublicProxy({
  browser,
  browserBootstrap,
  token,
  request = http.request,
  connect = net.connect,
}: {
  browser?: BrowserPublicManager | null;
  browserBootstrap?: BrowserBootstrapConsumer | null;
  token?: string;
  request?: typeof http.request;
  connect?: typeof net.connect;
} = {}) {
  const handler: RequestHandler = (req, res, next) => {
    if (!browser) return next();
    const pathname = String(req.url || '').split('?')[0];
    if (isBrowserBootstrapPath(pathname)) {
      const origin = browserRequestOrigin(req);
      const bootstrap = browserBootstrap?.consume(pathname, origin);
      if (!bootstrap) return res.status(403).json({ error: 'browser bootstrap unavailable' });
      const secure = origin?.startsWith('https://') ? '; Secure' : '';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${bootstrap.deviceId}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      return res.redirect(
        bootstrap.preserveMethod ? (bootstrap.redirectStatus || 307) : 302,
        bootstrap.url,
      );
    }
    const deviceId = cookieValue(req.headers.cookie, DEVICE_COOKIE);
    const target = browserTarget(browser, req, deviceId);
    if (!target) {
      if (claimedBrowserRequest(req)) {
        res.setHeader('Cache-Control', 'no-store');
        if (expectsDocument(req)) return res.status(403).type('html').send(sessionUnavailableHtml(pathname));
        return res.status(403).json({ error: 'browser session unavailable' });
      }
      return next();
    }
    const { port } = target;
    const upstream = request({
      hostname: '127.0.0.1',
      port,
      method: req.method,
      path: req.originalUrl || req.url,
      headers: upstreamHeaders(req.headers, port, token),
    }, (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
      res.once('close', () => { if (!res.writableEnded) incoming.destroy(); });
    });
    const abort = () => upstream.destroy();
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    upstream.on('error', () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.status(502).json({ error: 'browser proxy unavailable' });
      else res.destroy();
    });
    req.pipe(upstream);
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const deviceId = cookieValue(req.headers.cookie, DEVICE_COOKIE);
    const target = browser && browserTarget(browser, req, deviceId);
    if (!target) return false;
    const { port } = target;
    const upstream = connect({ host: '127.0.0.1', port });
    upstream.once('connect', () => {
      const headers = upstreamHeaders(req.headers, port, token);
      const lines = [`${req.method || 'GET'} ${req.url} HTTP/${req.httpVersion || '1.1'}`];
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
        else if (value != null) lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    return true;
  };

  return { handler, onUpgrade };
}
