import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimedBrowserRequest } from './publicProxy.js';
import { BROWSER_INTERNAL_HEADER } from './protocol.js';
import { createBrowserCoordinator } from './coordinator.js';

const WORKER_FILE = fileURLToPath(new URL('./worker.js', import.meta.url));

function forwardedHeaders(headers, internalToken, appToken, api) {
  const out = { ...headers, [BROWSER_INTERNAL_HEADER]: internalToken };
  if (api || out.authorization === `Bearer ${appToken}`) delete out.authorization;
  delete out['proxy-authorization'];
  return out;
}

export function createBrowserWorkerClient({
  appToken,
  previewDomain = null,
  handmuxOrigin = 'http://127.0.0.1',
  forkWorker = fork,
  request = http.request,
  connect = net.connect,
  randomToken = () => randomBytes(32).toString('base64url'),
  parentEnv = process.env,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  readyTimeoutMs = 10_000,
  stableAfterMs = 30_000,
  requestTimeoutMs = 15_000,
  stopTimeoutMs = 3_000,
} = {}) {
  const internalToken = randomToken();
  let child = null;
  let port = null;
  let generation = 0;
  let stopping = false;
  let restartDelay = 250;
  let restartTimer = null;
  let readyTimer = null;
  let stableTimer = null;
  const activeSockets = new Set();
  const workerEnv = {};
  for (const name of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]) {
    if (parentEnv[name] != null) workerEnv[name] = parentEnv[name];
  }

  const clearReadyTimer = () => {
    if (readyTimer != null) clearTimer(readyTimer);
    readyTimer = null;
  };
  const clearStableTimer = () => {
    if (stableTimer != null) clearTimer(stableTimer);
    stableTimer = null;
  };
  const scheduleRestart = () => {
    if (stopping || restartTimer != null) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, 5_000);
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (!stopping) start();
    }, delay);
  };
  const start = () => {
    let spawned;
    try {
      spawned = forkWorker(WORKER_FILE, [], {
        env: {
          ...workerEnv,
          HANDMUX_BROWSER_INTERNAL_TOKEN: internalToken,
          HANDMUX_BROWSER_CONTROL_ORIGIN: handmuxOrigin,
          ...(previewDomain ? { HANDMUX_PREVIEW_DOMAIN: previewDomain } : {}),
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch {
      child = null;
      port = null;
      scheduleRestart();
      return;
    }
    child = spawned;
    port = null;
    readyTimer = setTimer(() => {
      if (child === spawned && port == null) spawned.kill('SIGTERM');
    }, readyTimeoutMs);
    spawned.on('message', (message) => {
      if (child !== spawned || message?.type !== 'handmux-browser-ready' || !Number.isInteger(message.port)) return;
      port = message.port;
      generation += 1;
      clearReadyTimer();
      clearStableTimer();
      stableTimer = setTimer(() => {
        stableTimer = null;
        if (child === spawned && port != null) restartDelay = 250;
      }, stableAfterMs);
    });
    const finalize = () => {
      if (child !== spawned) return;
      child = null;
      port = null;
      generation += 1;
      clearReadyTimer();
      clearStableTimer();
      for (const socket of activeSockets) socket.destroy();
      activeSockets.clear();
      scheduleRestart();
    };
    spawned.once('error', () => {
      if (child !== spawned) return;
      try { spawned.kill('SIGTERM'); } catch { /* already gone */ }
      finalize();
    });
    spawned.once('exit', finalize);
    spawned.once('close', finalize);
  };

  const unavailable = (res, status) => res.status(status).json({ error: 'browser unavailable' });
  const proxyHttp = (api) => (req, res, next) => {
    if (!api && !claimedBrowserRequest(req)) return next();
    const targetPort = port;
    if (!targetPort) return unavailable(res, api ? 503 : 502);
    const upstream = request({
      hostname: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.originalUrl || req.url,
      headers: forwardedHeaders(req.headers, internalToken, appToken, api),
    }, (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
      res.once('close', () => { if (!res.writableEnded) incoming.destroy(); });
    });
    if (api) upstream.setTimeout?.(requestTimeoutMs, () => upstream.destroy(new Error('browser worker request timeout')));
    const abort = () => upstream.destroy();
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    upstream.once('error', () => {
      if (!res.headersSent) unavailable(res, api ? 503 : 502);
      else res.destroy();
    });
    req.pipe(upstream);
  };

  const onUpgrade = (req, socket, head) => {
    if (!claimedBrowserRequest(req)) return false;
    const targetPort = port;
    if (!targetPort) { socket.destroy(); return true; }
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    activeSockets.add(socket);
    activeSockets.add(upstream);
    const cleanup = () => {
      activeSockets.delete(socket);
      activeSockets.delete(upstream);
    };
    upstream.once('connect', () => {
      const headers = forwardedHeaders(req.headers, internalToken, appToken, false);
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
    upstream.once('close', cleanup);
    socket.once('close', cleanup);
    return true;
  };

  const proxyRequest = ({ req, method, path, body }) => new Promise((resolve) => {
    const targetPort = port;
    if (!targetPort) return resolve(null);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = forwardedHeaders(req.headers, internalToken, appToken, true);
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    } else {
      delete headers['content-length'];
      delete headers['content-type'];
    }
    const upstream = request({ hostname: '127.0.0.1', port: targetPort, method, path, headers }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode || 502,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }));
    });
    upstream.setTimeout?.(requestTimeoutMs, () => upstream.destroy(new Error('browser worker request timeout')));
    upstream.once('error', () => resolve(null));
    req.once('aborted', () => upstream.destroy());
    upstream.end(payload || undefined);
  });

  const apiHandler = createBrowserCoordinator({
    proxyRequest,
    getStatus: () => ({ ready: port != null, generation }),
  });

  if (previewDomain) start();
  let closePromise = null;
  return {
    apiHandler,
    publicHandler: proxyHttp(false),
    onUpgrade,
    health() {
      if (!previewDomain) return { status: 'disabled', detail: null };
      if (stopping) return { status: 'degraded', detail: 'browser-stopping' };
      return port != null
        ? { status: 'ready', detail: null }
        : { status: 'starting', detail: 'browser-worker-starting' };
    },
    close() {
      if (!closePromise) {
        stopping = true;
        apiHandler.close();
        if (restartTimer != null) clearTimer(restartTimer);
        restartTimer = null;
        clearReadyTimer();
        clearStableTimer();
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        const current = child;
        if (!current) closePromise = Promise.resolve();
        else closePromise = new Promise((resolve) => {
          let finished = false;
          let forceTimer = setTimer(() => {
            forceTimer = null;
            current.kill('SIGKILL');
          }, stopTimeoutMs);
          const finish = () => {
            if (finished) return;
            finished = true;
            if (forceTimer != null) clearTimer(forceTimer);
            resolve();
          };
          current.once('error', finish);
          current.once('exit', finish);
          current.once('close', finish);
          try { current.kill('SIGTERM'); } catch { finish(); }
        });
      }
      return closePromise;
    },
  };
}
