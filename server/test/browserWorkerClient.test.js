import http from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expressAuth } from '../src/auth.js';
import { createBrowserWorkerClient } from '../src/browser/workerClient.js';

const servers = [];
const clients = [];
const DEVICE = 'device_abcdefghijklmnopqrstuvwxyz123456';

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

function fakeChild(port) {
  const child = new EventEmitter();
  child.connected = true;
  child.kill = vi.fn(() => {
    child.connected = false;
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    return true;
  });
  queueMicrotask(() => child.emit('message', { type: 'handmux-browser-ready', port }));
  return child;
}

function clientFor(port, options = {}) {
  const children = [];
  const client = createBrowserWorkerClient({
    appToken: 'app-secret',
    randomToken: () => 'internal-secret',
    forkWorker: vi.fn(() => {
      const child = fakeChild(port);
      children.push(child);
      return child;
    }),
    previewDomain: 'preview.example',
    ...options,
  });
  clients.push(client);
  return { client, children };
}

describe('browser worker client', () => {
  it('does not fork without a preview domain and reports proxy leases unavailable', async () => {
    const forkWorker = vi.fn();
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', forkWorker, randomToken: () => 'internal-secret',
    });
    clients.push(client);
    const app = express();
    app.use(express.json());
    app.use('/api/browser-proxy', expressAuth('app-secret'), client.apiHandler);

    await request(app).get('/api/browser-proxy/status')
      .set('Authorization', 'Bearer app-secret')
      .expect(200, { ready: false, generation: 0 });
    await request(app).put('/api/browser-proxy/leases/client-a')
      .set('Authorization', 'Bearer app-secret')
      .set('X-Handmux-Browser-Device', DEVICE)
      .send({ url: 'https://target.example/' })
      .expect(503, { error: 'browser unavailable' });

    expect(forkWorker).not.toHaveBeenCalled();
    expect(client.health()).toEqual({ status: 'disabled', detail: null });
  });

  it('reports a configured proxy worker unavailable while starting and after exit', async () => {
    const child = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
      return true;
    });
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', previewDomain: 'preview.example',
      forkWorker: () => child, randomToken: () => 'internal-secret',
    });
    clients.push(client);
    const app = express();
    app.use(express.json());
    app.use('/api/browser-proxy', expressAuth('app-secret'), client.apiHandler);

    await request(app).get('/api/browser-proxy/status')
      .set('Authorization', 'Bearer app-secret')
      .expect(200, { ready: false, generation: 0 });
    await request(app).put('/api/browser-proxy/leases/client-a')
      .set('Authorization', 'Bearer app-secret')
      .set('X-Handmux-Browser-Device', DEVICE)
      .send({ url: 'https://target.example/' })
      .expect(503, { error: 'browser unavailable' });
    expect(client.health()).toEqual({ status: 'starting', detail: 'browser-worker-starting' });

    child.emit('exit', 1, null);
    await request(app).get('/api/browser-proxy/status')
      .set('Authorization', 'Bearer app-secret')
      .expect(200, { ready: false, generation: 1 });
  });

  it('keeps status available while lease and claimed public requests fail closed', async () => {
    const child = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
      return true;
    });
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', forkWorker: () => child, randomToken: () => 'internal-secret',
    });
    clients.push(client);
    const app = express();
    app.use(client.publicHandler);
    app.use(express.json());
    app.use('/api/browser-proxy', expressAuth('app-secret'), client.apiHandler);
    app.get('*', (_req, res) => res.status(218).send('main'));

    await request(app).get('/api/browser-proxy/status')
      .set('Authorization', 'Bearer app-secret')
      .expect(200, { ready: false, generation: 0 });
    await request(app).put('/api/browser-proxy/leases/client-a')
      .set('Authorization', 'Bearer app-secret')
      .set('X-Handmux-Browser-Device', DEVICE)
      .send({ url: 'https://target.example/' })
      .expect(503, { error: 'browser unavailable' });
    await request(app).get('/_browser-a/https://target.example/').expect(502);
    await request(app).get('/_browser-bootstrap/ticket').expect(502);
    await request(app).get('/api/states').expect(218, 'main');
  });

  it('streams API bodies while preserving Host/XFP and hiding both secrets', async () => {
    const seen = [];
    const worker = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.setHeader('set-cookie', 'tw_browser_device=device; Path=/');
        res.statusCode = 201;
        res.end('created');
      });
    });
    const port = await listen(worker);
    const { client } = clientFor(port);
    await new Promise((resolve) => setImmediate(resolve));
    const app = express();
    app.use(express.json());
    app.use('/api/browser-proxy', expressAuth('app-secret'), client.apiHandler);

    const response = await request(app).put('/api/browser-proxy/leases/client-a')
      .set('Authorization', 'Bearer app-secret')
      .set('Host', 'phone.example:30443')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Handmux-Browser-Device', DEVICE)
      .send({ url: 'https://target.example/' });

    expect(response.status).toBe(201);
    expect(response.headers['set-cookie'][0]).toContain('tw_browser_device=device');
    expect(seen[0]).toMatchObject({ url: '/api/browser-proxy/leases/client-a' });
    expect(seen[0].body).toContain('target.example');
    expect(seen[0].headers.host).toBe('phone.example:30443');
    expect(seen[0].headers['x-forwarded-proto']).toBe('https');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-handmux-browser-internal']).toBe('internal-secret');
  });

  it('preserves target Authorization on public browser requests', async () => {
    const seen = [];
    const worker = http.createServer((req, res) => {
      seen.push(req.headers);
      res.end('page');
    });
    const port = await listen(worker);
    const { client } = clientFor(port);
    await new Promise((resolve) => setImmediate(resolve));
    const app = express();
    app.use(client.publicHandler);

    await request(app).get('/_browser-a/https://target.example/')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(200, 'page');

    expect(seen[0].authorization).toBe('Basic dXNlcjpwYXNz');
    expect(seen[0]['x-handmux-browser-internal']).toBe('internal-secret');
  });

  it('forwards claimed public upgrades with target Authorization and upgrade head', async () => {
    const socket = Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      destroy: vi.fn(),
    });
    const upstream = Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    });
    socket.pipe.mockReturnValue(upstream);
    upstream.pipe.mockReturnValue(socket);
    const connect = vi.fn(() => upstream);
    const { client } = clientFor(9, { connect });
    await new Promise((resolve) => setImmediate(resolve));
    const head = Buffer.from('upgrade-head');
    const req = {
      method: 'GET',
      url: '/_browser-a/https://target.example/socket',
      httpVersion: '1.1',
      headers: {
        host: 'phone.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
        authorization: 'Basic dXNlcjpwYXNz',
      },
    };

    expect(client.onUpgrade({ ...req, url: '/api/states' }, socket, head)).toBe(false);
    expect(client.onUpgrade(req, socket, head)).toBe(true);
    upstream.emit('connect');

    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9 });
    expect(upstream.write.mock.calls[0][0]).toContain('authorization: Basic dXNlcjpwYXNz');
    expect(upstream.write.mock.calls[0][0]).toContain('x-handmux-browser-internal: internal-secret');
    expect(upstream.write.mock.calls[1][0]).toBe(head);
    expect(socket.pipe).toHaveBeenCalledWith(upstream);
    expect(upstream.pipe).toHaveBeenCalledWith(socket);
  });

  it('restarts after an unexpected exit with bounded backoff', async () => {
    const timers = [];
    const forkWorker = vi.fn(() => fakeChild(9));
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', previewDomain: 'preview.example', forkWorker, randomToken: () => 'internal-secret',
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: vi.fn(), readyTimeoutMs: 10_000,
    });
    clients.push(client);
    await new Promise((resolve) => setImmediate(resolve));

    forkWorker.mock.results[0].value.emit('exit', 1, null);
    const restart = timers.find((timer) => timer.ms === 250);
    expect(restart).toBeTruthy();
    restart.fn();
    expect(forkWorker).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setImmediate(resolve));
    forkWorker.mock.results[1].value.emit('exit', 1, null);
    expect(timers.some((timer) => timer.ms === 500)).toBe(true);
  });

  it('keeps the main process alive and retries when fork throws synchronously', () => {
    const timers = [];
    const forkWorker = vi.fn(() => { throw new Error('fork unavailable'); });

    expect(() => {
      const client = createBrowserWorkerClient({
        appToken: 'app-secret', previewDomain: 'preview.example', forkWorker, randomToken: () => 'internal-secret',
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: vi.fn(),
      });
      clients.push(client);
    }).not.toThrow();

    expect(forkWorker).toHaveBeenCalledOnce();
    expect(timers.some((timer) => timer.ms === 250)).toBe(true);
  });

  it('retries an asynchronous spawn error even when no exit event follows', () => {
    const timers = [];
    const child = new EventEmitter();
    child.kill = vi.fn();
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', previewDomain: 'preview.example', forkWorker: () => child, randomToken: () => 'internal-secret',
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: vi.fn(),
    });
    clients.push(client);

    child.emit('error', new Error('spawn EAGAIN'));

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(timers.some((timer) => timer.ms === 250)).toBe(true);
  });

  it('finishes close when the child emits error without exit', async () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', previewDomain: 'preview.example', forkWorker: () => child, randomToken: () => 'internal-secret',
    });
    clients.push(client);

    let closed = false;
    client.close().then(() => { closed = true; });
    child.emit('error', new Error('spawn EAGAIN'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(closed).toBe(true);
  });

  it('does not expose Handmux or tunnel credentials to the browser worker environment', async () => {
    const forkWorker = vi.fn(() => fakeChild(9));
    const client = createBrowserWorkerClient({
      appToken: 'app-secret', previewDomain: 'preview.example', forkWorker, randomToken: () => 'internal-secret',
      handmuxOrigin: 'https://handmux.example:30443',
      parentEnv: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.example',
        HANDMUX_TOKEN: 'app-secret',
        HANDMUX_AUTHTOKEN: 'tunnel-secret',
        VAPID_PRIVATE: 'push-secret',
        XFYUN_APISECRET: 'speech-secret',
      },
    });
    clients.push(client);
    await new Promise((resolve) => setImmediate(resolve));

    const env = forkWorker.mock.calls[0][2].env;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://proxy.example');
    expect(env.HANDMUX_BROWSER_INTERNAL_TOKEN).toBe('internal-secret');
    expect(env.HANDMUX_BROWSER_CONTROL_ORIGIN).toBe('https://handmux.example:30443');
    expect(env.HANDMUX_TOKEN).toBeUndefined();
    expect(env.HANDMUX_AUTHTOKEN).toBeUndefined();
    expect(env.VAPID_PRIVATE).toBeUndefined();
    expect(env.XFYUN_APISECRET).toBeUndefined();
  });

  it('stops restarting and terminates the child on close', async () => {
    const timers = [];
    const { client, children } = clientFor(9, {
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    await client.close();

    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('exit', 0, null);
    expect(timers.filter((timer) => timer.ms === 250)).toHaveLength(0);
  });
});
