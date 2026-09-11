import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createPreviews } from '../src/previews.js';
import { createPreview } from '../src/previewServer.js';
import { createBrowserPreviewManager } from '../src/browser/manager.js';
import { createBrowserPublicProxy } from '../src/browser/publicProxy.js';
import { createBrowserBootstrapStore } from '../src/browser/bootstrap.js';
import { createDeviceAccess } from '../src/deviceAccess.js';

const run = promisify(execFile);
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

// Opt-in real browser security smoke; does not claim mobile/PWA UX coverage.
describe.skipIf(process.env.HANDMUX_CHROMIUM_ISOLATION !== '1')('real Chromium preview isolation', () => {
  it('runs both frame scripts while denying main DOM, Cookie and authenticated API access', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'handmux-chromium-isolation-'));
    const site = join(workspace, 'site');
    await mkdir(site);
    const servers = [];
    let manager;
    let access;
    let authorizedCalls = 0;
    const apiAttempts = [];
    const targetCookies = [];
    const observedRequests = [];
    try {
      const app = express();
      app.use((req, _res, next) => { observedRequests.push(`${req.headers.host} ${req.url}`); next(); });
      const main = http.createServer(app);
      const port = await listen(main);
      servers.push(main);
      const mainOrigin = `http://main.handmux.test:${port}`;
      const proxyOrigin = `http://browser.preview.handmux.test:${port}`;
      const payload = (kind) => `<!doctype html><title>${kind}</title><script>
        (async () => {
          const result = { kind: ${JSON.stringify(kind)}, scriptRan: true };
          try { result.parent = parent.document.getElementById('main-secret').textContent; }
          catch { result.parent = 'blocked'; }
          try { result.cookie = document.cookie; } catch { result.cookie = 'blocked'; }
          try {
            // Native fetch bypasses Hammerhead URL rewriting: exercise browser CORS/Origin itself.
            const nativeFetch = window['%hammerhead%']?.nativeMethods?.fetch || window.fetch;
            const response = await nativeFetch.call(window, ${JSON.stringify(`${mainOrigin}/api/probe`)}, {
              credentials: 'include', headers: { 'X-Handmux-Request': '1' }
            });
            result.api = response.status;
            result.body = await response.text();
          } catch { result.api = 'blocked'; }
          const nativePostMessage = window['%hammerhead%']?.nativeMethods?.postMessage;
          if (nativePostMessage) nativePostMessage.call(parent, { isolationResult: result }, '*');
          else parent.postMessage({ isolationResult: result }, '*');
        })();
      </script>`;
      await writeFile(join(site, 'index.html'), payload('static'));
      const target = http.createServer((req, res) => {
        targetCookies.push(req.headers.cookie || '');
        res.setHeader('Content-Type', 'text/html');
        res.end(payload('browser'));
      });
      const targetPort = await listen(target);
      servers.push(target);
      const deviceId = 'device_abcdefghijklmnopqrstuvwxyz123456';
      const bootstrap = createBrowserBootstrapStore();
      manager = await createBrowserPreviewManager({
        handmuxOrigin: mainOrigin,
        browserBootstrap: bootstrap,
        profilePersistence: { read: async () => null, write: async () => {}, remove: async () => {}, close: async () => {} },
      });
      const publicProxy = createBrowserPublicProxy({ browser: manager, browserBootstrap: bootstrap });
      // Production ordering: Browser routes precede the main app's frame-ancestors restriction.
      app.use(publicProxy.handler);
      app.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', "base-uri 'self'; object-src 'none'; frame-ancestors 'self'");
        next();
      });
      const registry = createPreviews({ home: workspace, store: join(workspace, 'previews.json'), isDeviceActive: (id) => id === deviceId });
      const staticLease = await registry.register({ name: 'isolation', dir: site }, deviceId);
      const preview = createPreview({ previews: registry });
      app.use('/preview', preview.router);
      access = createDeviceAccess({
        resolveOrigin: (req) => req.headers.host === `main.handmux.test:${port}` ? mainOrigin : null,
        service: {
          authenticateRequest: (req) => String(req.headers.cookie || '').includes('handmux_session_http=test-session')
            ? { deviceId, sessionId: 'session', expiresAt: null } : null,
          isActive: () => true, touch: () => {}, onRevoke: () => () => {},
        },
      });
      app.use('/api/probe', (req, _res, next) => { apiAttempts.push({ origin: req.headers.origin, method: req.method }); next(); }, access.middleware);
      app.get('/api/probe', (_req, res) => { authorizedCalls++; res.json({ secret: 'protected-api-content' }); });
      const lease = await manager.putLease({ tabId: 'isolation', deviceId,
        url: `http://127.0.0.1:${targetPort}/`, origin: proxyOrigin, sourceUserAgent: '' });
      const bootstrapUrl = bootstrap.issue({ url: lease.url, origin: proxyOrigin, deviceId });
      app.get('/', (req, res) => {
        if (req.headers.host !== `main.handmux.test:${port}`) return res.status(404).end();
        res.setHeader('Set-Cookie', [
          'handmux_session_http=test-session; HttpOnly; SameSite=Strict; Path=/',
          'main_visible=main-cookie-secret; SameSite=Strict; Path=/',
        ]);
        return res.type('html').send(`<!doctype html><meta charset="utf-8"><div id="main-secret">main-dom-secret</div>
          <pre id="results">pending</pre><script>
          const results = {};
          addEventListener('message', (event) => {
            if (!event.data?.isolationResult) return;
            results[event.data.isolationResult.kind] = { ...event.data.isolationResult, messageOrigin: event.origin };
            document.getElementById('results').textContent = JSON.stringify(results);
          });</script>
          <iframe src="/preview/isolation/${staticLease.accessToken}/"></iframe>
          <iframe src="${bootstrapUrl}"></iframe>`);
      });
      const chrome = process.env.HANDMUX_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const { stdout, stderr } = await run(chrome, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--enable-logging=stderr', '--v=0',
        '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
        '--no-proxy-server', '--disable-features=OptimizationHints,MediaRouter',
        `--user-data-dir=${join(workspace, 'chrome')}`,
        '--host-resolver-rules=MAP *.handmux.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost',
        '--dump-dom', '--virtual-time-budget=12000', mainOrigin,
      ], { timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
      const serialized = stdout.match(/<pre id="results">([^<]+)<\/pre>/)?.[1];
      expect(serialized, stdout.slice(-5000)).toBeTruthy();
      const results = JSON.parse(serialized.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
      expect(Object.keys(results).sort(), JSON.stringify({ results, observedRequests, stderr })).toEqual(['browser', 'static']);
      for (const result of Object.values(results)) {
        expect(result.scriptRan).toBe(true);
        expect(result.parent).toBe('blocked');
        expect(result.cookie).not.toContain('main-cookie-secret');
        expect(result.cookie).not.toContain('test-session');
        expect(result.body || '').not.toContain('protected-api-content');
        expect(result.api).not.toBe(200);
      }
      expect(results.static.messageOrigin).toBe('null');
      expect(results.browser.messageOrigin).toBe(proxyOrigin);
      expect(authorizedCalls).toBe(0);
      expect(apiAttempts.some((attempt) => attempt.origin === 'null')).toBe(true);
      expect(apiAttempts.some((attempt) => attempt.origin === proxyOrigin)).toBe(true);
      expect(targetCookies.join(';')).not.toContain('test-session');
      expect(targetCookies.join(';')).not.toContain('main-cookie-secret');
    } finally {
      access?.close();
      await manager?.close();
      await Promise.all(servers.map(close));
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60000);
});
