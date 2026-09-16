import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPublicProxy, isBrowserServicePath } from '../src/browser/publicProxy.js';

const servers = [];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('browser public proxy', () => {
  const DEVICE = 'device_abcdefghijklmnopqrstuvwxyz123456';
  const cookie = `tw_browser_device=${DEVICE}`;
  it.each(['/hammerhead.js', '/task.js', '/iframe-task.js', '/messaging', '/transport-worker.js', '/worker-hammerhead.js'])(
    'recognizes Hammerhead service route %s',
    (path) => expect(isBrowserServicePath(path)).toBe(true),
  );

  it('falls through for ordinary Handmux routes', async () => {
    const browser = { internalPorts: [1, 2], ownsPublicPath: () => false, hasDevice: () => false };
    const proxy = createBrowserPublicProxy({ browser, token: 'handmux-secret' });
    const app = express();
    app.use(proxy.handler);
    app.get('*', (_req, res) => res.status(218).send('handmux'));

    const res = await request(app).get('/api/states');

    expect(res.status).toBe(218);
    expect(res.text).toBe('handmux');
  });

  it('never asks the browser manager to proxy ordinary Handmux routes', async () => {
    const resolvePublicRequest = vi.fn(() => ({ port: 9 }));
    const proxy = createBrowserPublicProxy({ browser: { resolvePublicRequest } });
    const app = express();
    app.use(proxy.handler);
    app.get('*', (_req, res) => res.status(218).send('handmux'));

    const res = await request(app).get('/api/browser-tabs').set('Cookie', cookie);

    expect(res.status).toBe(218);
    expect(resolvePublicRequest).not.toHaveBeenCalled();
  });

  it('notifies the parent preview when a document loses its browser session', async () => {
    const browser = { resolvePublicRequest: () => null };
    const proxy = createBrowserPublicProxy({ browser });
    const app = express();
    app.use(proxy.handler);

    const page = await request(app).get('/_browser-expired*channel-a/https://target.example/')
      .set('Accept', 'text/html')
      .set('Cookie', cookie);
    const asset = await request(app).get('/task.js')
      .set('Accept', 'application/javascript')
      .set('Cookie', cookie);

    expect(page.status).toBe(403);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.type).toMatch(/html/);
    expect(page.text).toContain("channel:\"channel-a\"");
    expect(page.text).toContain("type:'session-unavailable'");
    expect(asset.status).toBe(403);
    expect(asset.body).toEqual({ error: 'browser session unavailable' });
  });

  it('preserves target Authorization while removing only the Handmux bearer token', async () => {
    const received = [];
    const upstream = http.createServer((req, res) => {
      received.push(req.headers.authorization);
      res.end('proxied');
    });
    const port = await listen(upstream);
    const browser = { internalPorts: [port, port + 1], ownsPublicPath: (_path, device) => device === DEVICE, hasDevice: () => true };
    const proxy = createBrowserPublicProxy({ browser, token: 'handmux-secret' });
    const app = express();
    app.use(proxy.handler);

    await request(app).get('/_browser-tab-a/https://target.example/').set('Cookie', cookie).set('Authorization', 'Bearer handmux-secret');
    await request(app).get('/_browser-tab-a/https://target.example/').set('Cookie', cookie).set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(received).toEqual([undefined, 'Basic dXNlcjpwYXNz']);
  });

  it('forwards active session paths and service assets to Hammerhead loopback', async () => {
    const received = [];
    const upstream = http.createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      res.setHeader('x-upstream', 'hammerhead');
      res.end('proxied');
    });
    const port = await listen(upstream);
    const browser = {
      internalPorts: [port, port + 1],
      ownsPublicPath: (path, device) => device === DEVICE && path.startsWith('/_browser-tab-a/'),
      hasDevice: (device) => device === DEVICE,
    };
    const proxy = createBrowserPublicProxy({ browser, token: 'handmux-secret' });
    const app = express();
    app.use(proxy.handler);

    const page = await request(app)
      .get('/_browser-tab-a/https://target.example/')
      .set('Authorization', 'Bearer handmux-secret')
      .set('Cookie', `tw_preview=handmux-secret; ${cookie}; hammerhead-sync=value`);
    const asset = await request(app).get('/hammerhead.js').set('Cookie', cookie);

    expect(page.status).toBe(200);
    expect(page.text).toBe('proxied');
    expect(asset.status).toBe(200);
    expect(received.map((item) => item.url)).toEqual(['/_browser-tab-a/https://target.example/', '/hammerhead.js']);
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].headers.cookie).toBe('hammerhead-sync=value');
    expect(received[0].headers.host).toBe(`127.0.0.1:${port}`);
  }, 15_000);

  it('routes two devices to their independent public-origin proxy pools', async () => {
    const received = [];
    const first = http.createServer((req, res) => { received.push(`one:${req.url}`); res.end('one'); });
    const second = http.createServer((req, res) => { received.push(`two:${req.url}`); res.end('two'); });
    const firstPort = await listen(first);
    const secondPort = await listen(second);
    const browser = {
      resolvePublicRequest: (pathname, deviceId, origin) => {
        if (deviceId === 'device-one' && origin === 'https://one.example' && pathname.startsWith('/_browser-one/')) return { port: firstPort };
        if (deviceId === 'device-two' && origin === 'https://two.example' && pathname.startsWith('/_browser-two/')) return { port: secondPort };
        return null;
      },
    };
    const proxy = createBrowserPublicProxy({ browser });
    const app = express();
    app.use(proxy.handler);

    const one = await request(app).get('/_browser-one/https://a.example/')
      .set('Cookie', 'tw_browser_device=device-one').set('Host', 'one.example').set('X-Forwarded-Proto', 'https');
    const two = await request(app).get('/_browser-two/https://b.example/')
      .set('Cookie', 'tw_browser_device=device-two').set('Host', 'two.example').set('X-Forwarded-Proto', 'https');

    expect(one.text).toBe('one');
    expect(two.text).toBe('two');
    expect(received).toEqual(['one:/_browser-one/https://a.example/', 'two:/_browser-two/https://b.example/']);
  });

  it('does not let forwarded host claim another origin over HTTP or WebSocket', async () => {
    const resolvePublicRequest = vi.fn((_pathname, _deviceId, origin) => (
      origin === 'https://two.example' ? { port: 9 } : null
    ));
    const connect = vi.fn();
    const proxy = createBrowserPublicProxy({ browser: { resolvePublicRequest }, connect });
    const app = express();
    app.use(proxy.handler);

    const httpResult = await request(app).get('/_browser-two/https://target.example/')
      .set('Cookie', cookie)
      .set('Host', 'one.example')
      .set('X-Forwarded-Host', 'two.example')
      .set('X-Forwarded-Proto', 'https');
    const wsClaimed = proxy.onUpgrade({
      url: '/messaging', method: 'GET', httpVersion: '1.1',
      headers: { host: 'one.example', 'x-forwarded-host': 'two.example', 'x-forwarded-proto': 'https', cookie },
      socket: { remoteAddress: '127.0.0.1' },
    }, { destroy: vi.fn(), once: vi.fn() }, Buffer.alloc(0));

    expect(httpResult.status).toBe(403);
    expect(wsClaimed).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(resolvePublicRequest).toHaveBeenCalledWith(expect.any(String), DEVICE, 'https://one.example');
  });

  it('consumes a one-time preview-origin bootstrap into a cross-site iframe cookie', async () => {
    const browserBootstrap = {
      consume: vi.fn(() => ({
        deviceId: DEVICE,
        url: 'https://handmux.example.com:30443/_browser-tab-a/https://target.example/',
      })),
    };
    const proxy = createBrowserPublicProxy({ browser: {}, browserBootstrap });
    const app = express();
    app.use(proxy.handler);

    const res = await request(app).get('/_browser-bootstrap/ticket')
      .set('Host', 'handmux.example.com:30443')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/_browser-tab-a/');
    expect(res.headers['set-cookie'][0]).toContain(`tw_browser_device=${DEVICE}`);
    expect(res.headers['set-cookie'][0]).not.toContain('Domain=');
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=None');
    expect(res.headers['set-cookie'][0]).toContain('Secure');
    expect(browserBootstrap.consume).toHaveBeenCalledWith('/_browser-bootstrap/ticket', 'https://handmux.example.com:30443');
  });

  it('preserves POST method and body with a 307 bootstrap handoff', async () => {
    const browserBootstrap = {
      consume: vi.fn(() => ({
        deviceId: DEVICE,
        url: 'https://b.example/_browser-tab-b/https://target.example/',
        preserveMethod: true,
        redirectStatus: 307,
      })),
    };
    const proxy = createBrowserPublicProxy({ browser: {}, browserBootstrap });
    const app = express();
    app.use(proxy.handler);

    const res = await request(app).post('/_browser-bootstrap/post-ticket')
      .set('Host', 'b.example')
      .set('X-Forwarded-Proto', 'https')
      .send('secret-body');

    expect(res.status).toBe(307);
    expect(res.headers.location).toContain('/_browser-tab-b/');
    expect(res.headers['set-cookie'][0]).toContain(`tw_browser_device=${DEVICE}`);
  });

  it('returns a specific 502 when the internal proxy is unavailable', async () => {
    const browser = { internalPorts: [9, 10], ownsPublicPath: () => true, hasDevice: () => true };
    const proxy = createBrowserPublicProxy({ browser });
    const app = express();
    app.use(proxy.handler);

    const res = await request(app).get('/_browser-tab-a/https://target.example/').set('Cookie', cookie);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/browser proxy unavailable/i);
  });

  it('aborts the Hammerhead upstream when the browser navigation disconnects', async () => {
    let markReceived;
    let markClosed;
    const received = new Promise((resolve) => { markReceived = resolve; });
    const closed = new Promise((resolve) => { markClosed = resolve; });
    const upstream = http.createServer((req) => {
      markReceived();
      req.once('close', markClosed);
    });
    const port = await listen(upstream);
    const browser = { internalPorts: [port, port + 1], ownsPublicPath: () => true, hasDevice: () => true };
    const proxy = createBrowserPublicProxy({ browser });
    const app = express();
    app.use(proxy.handler);
    const outer = http.createServer(app);
    const outerPort = await listen(outer);
    const pending = http.request({
      host: '127.0.0.1', port: outerPort,
      path: '/_browser-tab-a/https://target.example/',
      headers: { cookie },
    });
    pending.once('error', () => {});
    pending.end();
    await received;

    pending.destroy();

    await expect(Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stayed open')), 250)),
    ])).resolves.toBeUndefined();
  });

  it('does not expose a session or Hammerhead service routes to another device', async () => {
    const browser = { internalPorts: [9, 10], ownsPublicPath: () => false, hasDevice: () => false };
    const proxy = createBrowserPublicProxy({ browser });
    const app = express();
    app.use(proxy.handler);
    app.get('*', (_req, res) => res.status(218).end());

    await request(app).get('/_browser-tab-a/https://target.example/').set('Cookie', 'tw_browser_device=other').expect(403);
    await request(app).get('/task.js').set('Cookie', 'tw_browser_device=other').expect(403);
  });
});
