import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import express from 'express';
import type { Request, RequestHandler } from 'express';
import { tokenEquals } from '../auth.js';
import { createBrowserPreviewManager } from './manager.js';
import { createBrowserBootstrapStore } from './bootstrap.js';
import { createBrowserPublicProxy } from './publicProxy.js';
import { browserRoutes } from './routes.js';
import { BROWSER_INTERNAL_HEADER } from './protocol.js';

interface BrowserManager {
  close?(): unknown | Promise<unknown>;
  [key: string]: unknown;
}
interface BrowserPublicProxy {
  handler: RequestHandler;
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}
interface BrowserWorkerServerOptions {
  internalToken: string | undefined;
  previewDomain?: string | null;
  handmuxOrigin?: string;
  browser?: BrowserManager | null;
  managerFactory?: (options: {
    handmuxOrigin: string;
    previewDomain: string | null;
    browserBootstrap: ReturnType<typeof createBrowserBootstrapStore>;
  }) => BrowserManager | Promise<BrowserManager>;
  browserPublicFactory?: (options: {
    browser: BrowserManager;
    browserBootstrap: ReturnType<typeof createBrowserBootstrapStore>;
  }) => BrowserPublicProxy;
  host?: string;
  port?: number;
}
type BrowserManagerFactory = NonNullable<BrowserWorkerServerOptions['managerFactory']>;
type BrowserPublicFactory = NonNullable<BrowserWorkerServerOptions['browserPublicFactory']>;
const defaultManagerFactory = createBrowserPreviewManager as unknown as BrowserManagerFactory;
const defaultBrowserPublicFactory = createBrowserPublicProxy as unknown as BrowserPublicFactory;
const workerBrowserRoutes = browserRoutes as unknown as (options: {
  browser: BrowserManager;
  previewDomain: string | null;
  browserBootstrap: ReturnType<typeof createBrowserBootstrapStore>;
}) => RequestHandler;

function isLoopback(address: unknown): boolean {
  return address === '127.0.0.1' || address === '::1' || String(address || '').startsWith('::ffff:127.');
}

function authenticated(req: Pick<Request, 'headers' | 'socket'> | IncomingMessage, token: string): boolean {
  const provided = req.headers[BROWSER_INTERNAL_HEADER];
  return isLoopback(req.socket?.remoteAddress)
    && typeof provided === 'string'
    && tokenEquals(provided, token);
}

export async function createBrowserWorkerServer({
  internalToken,
  previewDomain = null,
  handmuxOrigin = 'http://127.0.0.1',
  browser: suppliedBrowser = null,
  managerFactory = defaultManagerFactory,
  browserPublicFactory = defaultBrowserPublicFactory,
  host = '127.0.0.1',
  port = 0,
}: BrowserWorkerServerOptions) {
  if (!internalToken) throw new Error('browser worker internal token required');
  const browserBootstrap = createBrowserBootstrapStore();
  const browser = suppliedBrowser || await managerFactory({
    handmuxOrigin,
    previewDomain,
    browserBootstrap,
  });
  const browserPublic = browserPublicFactory({ browser, browserBootstrap });
  const app = express();

  app.use((req, res, next) => {
    if (!authenticated(req, internalToken)) return res.status(401).json({ error: 'browser worker unauthorized' });
    delete req.headers[BROWSER_INTERNAL_HEADER];
    return next();
  });
  app.get('/_browser-worker/health', (_req, res) => res.json({ ok: true }));
  app.use(
    '/api/browser-proxy',
    express.json(),
    workerBrowserRoutes({ browser, previewDomain, browserBootstrap }),
  );
  app.use(browserPublic.handler);

  const server = http.createServer(app);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authenticated(req, internalToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    delete req.headers[BROWSER_INTERNAL_HEADER];
    if (!browserPublic.onUpgrade(req, socket, head)) socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('browser worker did not bind a TCP port');
  let closePromise: Promise<void> | null = null;
  return {
    host,
    port: (address as AddressInfo).port,
    server,
    browser,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          const stopped = new Promise((resolve) => server.close(resolve));
          server.closeIdleConnections?.();
          for (const socket of sockets) socket.destroy();
          try { await browser.close?.(); } finally {
            server.closeAllConnections?.();
            await stopped;
          }
        })();
      }
      return closePromise;
    },
  };
}
