import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import hammerhead from 'testcafe-hammerhead';
import { createBrowserPreviewManager } from '../src/browser/manager.js';
import { createBrowserPublicProxy } from '../src/browser/publicProxy.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function requestThrough(port, rawUrl, deviceId) {
  const url = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        accept: 'text/html',
        cookie: `tw_browser_device=${deviceId}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('built-in browser vertical slice', () => {
  it('shares SSO cookies across app contexts for one device while isolating hosts and devices', async () => {
    const sessions = [];
    class Proxy extends hammerhead.Proxy {
      start(options) {
        this.server1Info = { hostname: options.hostname, port: options.port1, crossDomainPort: options.port2, protocol: 'http:', domain: `http://${options.hostname}:${options.port1}` };
        this.server2Info = { hostname: options.hostname, port: options.port2, crossDomainPort: options.port1, protocol: 'http:', domain: `http://${options.hostname}:${options.port2}` };
      }
      openSession(url, session) {
        sessions.push({ url, session });
        return `${this.server1Info.domain}/${session.id}/${url}`;
      }
      closeSession() {}
      close() {}
    }
    const manager = await createBrowserPreviewManager({ hammerhead: { ...hammerhead, Proxy } });
    const deviceA = 'device_abcdefghijklmnopqrstuvwxyz123456';
    const deviceB = 'device_zyxwvutsrqponmlkjihgfedcba654321';

    try {
      await manager.putLease({
        tabId: 'app-a', url: 'https://app-a.example/',
        origin: 'https://browser-app-a.preview.example', deviceId: deviceA,
      });
      await manager.putLease({
        tabId: 'app-b', url: 'https://app-b.example/',
        origin: 'https://browser-app-b.preview.example', deviceId: deviceA,
      });
      await manager.putLease({
        tabId: 'other-device', url: 'https://app-a.example/',
        origin: 'https://browser-other.preview.example', deviceId: deviceB,
      });
      const [appA, appB, otherDevice] = sessions.map(({ session }) => session.cookies);

      appA.setByServer('https://sso.corp.example/login', [
        'sso_token=one; Domain=sso.corp.example; Path=/; HttpOnly; Secure',
      ]);
      appA.setByServer('https://app-a.example/login', ['host_session=a; Path=/']);
      appB.setByServer('https://app-b.example/login', ['host_session=b; Path=/']);

      expect(appB.getHeader({
        url: 'https://sso.corp.example/authorize', hostname: 'sso.corp.example',
      })).toContain('sso_token=one');
      expect(otherDevice.getHeader({
        url: 'https://sso.corp.example/authorize', hostname: 'sso.corp.example',
      })).toBeNull();
      expect(appB.getHeader({
        url: 'https://app-a.example/', hostname: 'app-a.example',
      })).toContain('host_session=a');
      expect(appB.getHeader({
        url: 'https://app-b.example/', hostname: 'app-b.example',
      })).toContain('host_session=b');
      expect(appB.getHeader({
        url: 'https://app-b.example/', hostname: 'app-b.example',
      })).not.toContain('host_session=a');
      expect(appB.getHeader({
        url: 'https://app-a.example/', hostname: 'app-a.example',
      })).not.toContain('host_session=b');
    } finally {
      await manager.close();
    }
  });

  it('loads one target origin through isolated sessions for two devices', async () => {
    const target = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Internal App</title><main id="loaded">working</main>');
    });
    const targetPort = await listen(target);
    const manager = await createBrowserPreviewManager({ hammerhead });
    const publicProxy = createBrowserPublicProxy({ browser: manager });
    const app = express();
    app.use(publicProxy.handler);
    const outer = http.createServer(app);
    outer.on('upgrade', publicProxy.onUpgrade);
    const outerPort = await listen(outer);

    try {
      const origin = `http://127.0.0.1:${outerPort}`;
      const deviceId = 'device_abcdefghijklmnopqrstuvwxyz123456';
      const tab = await manager.putLease({
        tabId: 'first-device',
        url: `http://127.0.0.1:${targetPort}/keys`,
        origin,
        deviceId,
      });
      const secondDeviceId = 'device_zyxwvutsrqponmlkjihgfedcba654321';
      const secondTab = await manager.putLease({
        tabId: 'second-device',
        url: `http://127.0.0.1:${targetPort}/second`,
        origin,
        deviceId: secondDeviceId,
      });
      const headers = { accept: 'text/html', cookie: `tw_browser_device=${deviceId}` };
      const secondHeaders = { accept: 'text/html', cookie: `tw_browser_device=${secondDeviceId}` };
      const page = await fetch(tab.url, { headers });
      const secondPage = await fetch(secondTab.url, { headers: secondHeaders });
      const html = await page.text();
      const secondHtml = await secondPage.text();
      const asset = await fetch(`${origin}/hammerhead.js`, { headers });
      const secondAsset = await fetch(`${origin}/hammerhead.js`, { headers: secondHeaders });
      const crossDeviceSession = await fetch(`${origin}${new URL(tab.url).pathname}`, { headers: secondHeaders });

      expect(page.status).toBe(200);
      expect(secondPage.status).toBe(200);
      expect(html).toContain('Internal App');
      expect(secondHtml).toContain('Internal App');
      expect(html).toContain('/hammerhead.js');
      expect(secondHtml).toContain('/hammerhead.js');
      expect(asset.status).toBe(200);
      expect(secondAsset.status).toBe(200);
      expect(crossDeviceSession.status).toBe(403);
      await secondAsset.body.cancel();
      const reader = asset.body.getReader();
      let assetBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        assetBytes += chunk.value.length;
      }
      expect(assetBytes).toBeGreaterThan(1_000_000);
    } finally {
      await manager.close();
      await Promise.all([close(outer), close(target)]);
    }
  });

  it('loads localhost when the target listens only on IPv4', async () => {
    const target = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>IPv4 localhost</title><main>dual-stack fallback</main>');
    });
    const targetPort = await listen(target);
    const manager = await createBrowserPreviewManager({ hammerhead });
    const publicProxy = createBrowserPublicProxy({ browser: manager });
    const app = express();
    app.use(publicProxy.handler);
    const outer = http.createServer(app);
    const outerPort = await listen(outer);

    try {
      const origin = `http://127.0.0.1:${outerPort}`;
      const deviceId = 'device_abcdefghijklmnopqrstuvwxyz123456';
      const tab = await manager.putLease({
        tabId: 'ipv4-localhost',
        url: `http://localhost:${targetPort}/`,
        origin,
        deviceId,
      });
      const response = await fetch(tab.url, {
        headers: { accept: 'text/html', cookie: `tw_browser_device=${deviceId}` },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('dual-stack fallback');
    } finally {
      await manager.close();
      await Promise.all([close(outer), close(target)]);
    }
  });

  it('shares target cookies across same-device tabs while keeping distinct Hammerhead windows', async () => {
    const target = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/set') res.setHeader('set-cookie', 'shared=yes; Path=/');
      res.end(`<!doctype html><title>Cookies</title><main>${req.headers.cookie || ''}</main>`);
    });
    const targetPort = await listen(target);
    const manager = await createBrowserPreviewManager({ hammerhead });
    const publicProxy = createBrowserPublicProxy({ browser: manager });
    const app = express();
    app.use(publicProxy.handler);
    const outer = http.createServer(app);
    const outerPort = await listen(outer);

    try {
      const origin = `http://127.0.0.1:${outerPort}`;
      const deviceId = 'device_abcdefghijklmnopqrstuvwxyz123456';
      const first = await manager.putLease({
        tabId: 'first', url: `http://127.0.0.1:${targetPort}/set`, origin, deviceId,
      });
      const second = await manager.putLease({
        tabId: 'second', url: `http://127.0.0.1:${targetPort}/read`, origin, deviceId,
      });
      const headers = { accept: 'text/html', cookie: `tw_browser_device=${deviceId}` };
      const firstHtml = await (await fetch(first.url, { headers })).text();
      const secondHtml = await (await fetch(second.url, { headers })).text();
      const firstTask = await (await fetch(`${origin}/task.js`, { headers: { ...headers, referer: first.url } })).text();
      const secondTask = await (await fetch(`${origin}/task.js`, { headers: { ...headers, referer: second.url } })).text();

      expect(first.channel).not.toBe(second.channel);
      expect(first.url).toContain(`*${first.channel}`);
      expect(second.url).toContain(`*${second.channel}`);
      expect(firstTask).toContain(first.channel);
      expect(secondTask).toContain(second.channel);
      expect(secondHtml).toContain('shared=yes');
    } finally {
      await manager.close();
      await Promise.all([close(outer), close(target)]);
    }
  });

  it('rehomes a real cross-origin 302 through a new wildcard bootstrap', async () => {
    const destination = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Destination</title><main>arrived</main>');
    });
    const destinationPort = await listen(destination);
    const source = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://b.test:${destinationPort}/final`);
      res.end();
    });
    const sourcePort = await listen(source);
    const publicApp = express();
    const outer = http.createServer(publicApp);
    const outerPort = await listen(outer);
    const browserBootstrap = (await import('../src/browser/bootstrap.js')).createBrowserBootstrapStore();
    const manager = await createBrowserPreviewManager({
      hammerhead,
      previewDomain: `http://preview.test:${outerPort}`,
      browserBootstrap,
      targetPolicyFactory: ({ topLevelUrl }) => ({
        check: async () => ({ allowed: true, addresses: [{ address: '127.0.0.1', family: 4 }] }),
        authorizeTopLevel: () => topLevelUrl,
      }),
    });
    const publicProxy = createBrowserPublicProxy({ browser: manager, browserBootstrap });
    publicApp.use(publicProxy.handler);
    const deviceId = 'device_abcdefghijklmnopqrstuvwxyz123456';

    try {
      const initialOrigin = `http://b-source.preview.test:${outerPort}`;
      const lease = await manager.putLease({
        tabId: 'redirect',
        deviceId,
        url: `http://a.test:${sourcePort}/start`,
        origin: initialOrigin,
      });
      let response = await requestThrough(outerPort, lease.url, deviceId);
      expect(response.status).toBe(302);

      response = await requestThrough(outerPort, new URL(response.headers.location, lease.url), deviceId);
      expect(response.status).toBe(307);
      expect(response.headers['x-handmux-browser-rebind']).toBeUndefined();
      const bootstrap = new URL(response.headers.location);
      expect(bootstrap.hostname).not.toBe(new URL(lease.url).hostname);

      response = await requestThrough(outerPort, bootstrap, deviceId);
      expect(response.status).toBe(307);
      response = await requestThrough(outerPort, new URL(response.headers.location, bootstrap), deviceId);
      expect(response.status).toBe(200);
      expect(response.body).toContain('arrived');
      expect(manager.getLease('redirect', deviceId).originalUrl)
        .toBe(`http://b.test:${destinationPort}/final`);
    } finally {
      await manager.close();
      await Promise.all([close(outer), close(source), close(destination)]);
    }
  });
});
