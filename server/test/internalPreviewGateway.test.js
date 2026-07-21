import http from 'node:http';
import net from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryCookieJar,
  createInternalPreviewGateway,
  decodeProxyPath,
  decodeWebSocketPath,
  proxyPathFor,
  proxyWebSocketPathFor,
  parseInternalPreviewArgs,
  isBlockedGatewayAddress,
  rewriteCss,
  rewriteHtml,
} from '../src/internalPreviewGateway.js';

describe('internal preview gateway URL mapping', () => {
  it('round-trips an HTTPS URL with path, query, and fragment', () => {
    const target = new URL('https://app.corp.internal/a/b?x=1#part');
    const path = proxyPathFor(target);
    expect(path).toMatch(/^\/__handmux_proxy__\/[A-Za-z0-9_-]+\/a\/b\?x=1#part$/);
    expect(decodeProxyPath(path).href).toBe(target.href);
  });

  it('round-trips a WebSocket URL together with its source page origin', () => {
    const source = new URL('https://app.corp.internal/dashboard');
    const target = new URL('wss://events.corp.internal/socket?room=1');
    const path = proxyWebSocketPathFor(target, source);
    expect(path).toMatch(/^\/__handmux_ws__\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
    expect(decodeWebSocketPath(path)).toEqual({
      sourceOrigin: source.origin,
      target,
    });
  });

  it('rejects malformed and non-http proxy routes', () => {
    expect(decodeProxyPath('/nope')).toBeNull();
    expect(decodeProxyPath('/__handmux_proxy__/%%%/')).toBeNull();
    const ftp = `/__handmux_proxy__/${Buffer.from('ftp://example.test').toString('base64url')}/`;
    expect(decodeProxyPath(ftp)).toBeNull();
  });
});

describe('internal preview gateway CLI arguments', () => {
  it('uses a stable local port and supports explicit insecure TLS for a validation run', () => {
    expect(parseInternalPreviewArgs(['https://app.corp.internal'])).toEqual({
      entryUrl: 'https://app.corp.internal', port: 4319, insecure: false, cookieDomains: [],
    });
    expect(parseInternalPreviewArgs(['https://app.corp.internal', '--port', '4320', '--insecure', '--cookie-domain', 'corp.internal'])).toEqual({
      entryUrl: 'https://app.corp.internal', port: 4320, insecure: true, cookieDomains: ['corp.internal'],
    });
  });

  it('rejects a missing URL and invalid port', () => {
    expect(() => parseInternalPreviewArgs([])).toThrow(/URL/);
    expect(() => parseInternalPreviewArgs(['https://app.test', '--port', '0'])).toThrow(/port/);
  });
});

describe('internal preview gateway network boundary', () => {
  it('blocks loopback, link-local, metadata, and unspecified addresses but permits private LAN addresses', () => {
    expect(isBlockedGatewayAddress('127.0.0.1')).toBe(true);
    expect(isBlockedGatewayAddress('169.254.169.254')).toBe(true);
    expect(isBlockedGatewayAddress('0.0.0.0')).toBe(true);
    expect(isBlockedGatewayAddress('::1')).toBe(true);
    expect(isBlockedGatewayAddress('fe80::1')).toBe(true);
    expect(isBlockedGatewayAddress('ff02::1')).toBe(true);
    expect(isBlockedGatewayAddress('fd00:ec2::254')).toBe(true);
    expect(isBlockedGatewayAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedGatewayAddress('::ffff:7f00:1')).toBe(true);
    expect(isBlockedGatewayAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedGatewayAddress('::ffff:0:0')).toBe(true);
    expect(isBlockedGatewayAddress('10.0.0.8')).toBe(false);
    expect(isBlockedGatewayAddress('192.168.1.8')).toBe(false);
  });

  it('rejects both a direct loopback target and a hostname resolving to loopback', async () => {
    const direct = createInternalPreviewGateway({ entryUrl: 'http://127.0.0.1:9' });
    await request(direct.handler).get(direct.entryPath).expect(403);

    const rebound = createInternalPreviewGateway({
      entryUrl: 'http://rebind.test/',
      dnsLookup: (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const response = await request(rebound.handler).get(rebound.entryPath).expect(502);
    expect(response.text).toContain('blocked internal preview address');

    const directV6 = createInternalPreviewGateway({ entryUrl: 'http://[::1]:9' });
    await request(directV6.handler).get(directV6.entryPath).expect(403);
    const mappedV6 = createInternalPreviewGateway({ entryUrl: 'http://[::ffff:127.0.0.1]:9' });
    await request(mappedV6.handler).get(mappedV6.entryPath).expect(403);
  });

  it('honors the all:true DNS callback contract in a real hostname request', async () => {
    const upstream = http.createServer((req, res) => res.end('hostname reached'));
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const gateway = createInternalPreviewGateway({
      entryUrl: `http://gateway-test.invalid:${upstream.address().port}/`,
      allowLoopback: true,
      dnsLookup: (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const response = await request(gateway.handler).get(gateway.entryPath).expect(200);
    expect(response.text).toBe('hostname reached');
    await new Promise((resolve) => upstream.close(resolve));
  });
});

describe('internal preview gateway rewriting', () => {
  const page = new URL('https://app.corp.internal/team/index.html');

  it('rewrites absolute and root-relative HTML URLs and injects the runtime', () => {
    const html = '<!doctype html><html><head></head><body>'
      + '<script src="/assets/app.js"></script>'
      + '<a href="https://auth.corp.internal/login">Login</a>'
      + '<img src="data:image/png;base64,abc">'
      + '<img srcset="/img/a.png 1x, https://cdn.corp.internal/b.png 2x">'
      + '</body></html>';
    const out = rewriteHtml(html, page);
    expect(out).toContain(proxyPathFor(new URL('https://app.corp.internal/assets/app.js')));
    expect(out).toContain(proxyPathFor(new URL('https://auth.corp.internal/login')));
    expect(out).toContain('data:image/png;base64,abc');
    expect(out).toContain(`${proxyPathFor(new URL('https://app.corp.internal/img/a.png'))} 1x`);
    expect(out).toContain(`${proxyPathFor(new URL('https://cdn.corp.internal/b.png'))} 2x`);
    expect(out).toContain('data-handmux-internal-preview');
    expect(out).toContain("x.protocol=x.protocol==='https:'?'wss:':'ws:'");
    expect(out).toContain("['CONNECTING','OPEN','CLOSING','CLOSED']");
  });

  it('rewrites CSS url() and @import references across domains', () => {
    const css = '@import "https://cdn.corp.internal/base.css"; .x{background:url(/img/a.png)}';
    const out = rewriteCss(css, page);
    expect(out).toContain(proxyPathFor(new URL('https://cdn.corp.internal/base.css')));
    expect(out).toContain(proxyPathFor(new URL('https://app.corp.internal/img/a.png')));
  });
});

describe('internal preview gateway cookie jar', () => {
  it('shares a parent-domain cookie with sibling subdomains but keeps host-only cookies isolated', () => {
    const jar = new MemoryCookieJar({ trustedDomains: ['corp.internal'] });
    jar.store('sid=shared; Domain=.corp.internal; Path=/; HttpOnly', new URL('https://auth.corp.internal/login'));
    jar.store('app=only; Path=/', new URL('https://app.corp.internal/'));

    expect(jar.header(new URL('https://api.corp.internal/v1'))).toBe('sid=shared');
    expect(jar.header(new URL('https://app.corp.internal/v1'))).toBe('sid=shared; app=only');
    expect(jar.header(new URL('https://other.internal/v1'))).toBe('');
  });

  it('honors cookie path boundaries and prefers the longest matching path', () => {
    const jar = new MemoryCookieJar();
    const source = new URL('https://app.corp.internal/foo/login');
    jar.store('sid=root; Path=/', source);
    jar.store('sid=foo; Path=/foo', source);
    expect(jar.header(new URL('https://app.corp.internal/foo/page'))).toBe('sid=foo; sid=root');
    expect(jar.header(new URL('https://app.corp.internal/foobar'))).toBe('sid=root');
  });

  it('rejects a Domain cookie scoped to a single-label suffix', () => {
    const jar = new MemoryCookieJar({ trustedDomains: ['corp.internal'] });
    jar.store('sid=bad; Domain=.internal; Path=/', new URL('https://app.corp.internal/'));
    expect(jar.header(new URL('https://other.internal/'))).toBe('');
  });

  it('rejects a multi-label public suffix unless it was explicitly trusted', () => {
    const jar = new MemoryCookieJar({ trustedDomains: ['corp.internal'] });
    jar.store('sid=bad; Domain=.co.uk; Path=/', new URL('https://app.co.uk/'));
    expect(jar.header(new URL('https://other.co.uk/'))).toBe('');
  });
});

describe('internal preview gateway HTTP flow', () => {
  let first;
  let second;
  let firstUrl;
  let secondUrl;

  beforeAll(async () => {
    second = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`second ${req.url} cookie=${req.headers.cookie || ''}`);
    });
    await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
    secondUrl = `http://127.0.0.1:${second.address().port}`;

    first = http.createServer((req, res) => {
      if (req.url === '/auth/login-url') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('etag', '"upstream-json"');
        res.setHeader('digest', 'sha-256=upstream');
        res.setHeader('signature', 'sig1=:upstream:');
        return res.end(JSON.stringify({
          code: 0,
          data: 'https://sso.corp.internal/login?service=https%3A%2F%2Fapi.corp.internal%2Fcallback',
        }));
      }
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          issuer: 'https://identity.corp.internal',
          authorization_endpoint: 'https://identity.corp.internal/authorize',
        }));
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${secondUrl}/landing?from=first` });
        return res.end();
      }
      if (req.url === '/set-cookie') {
        res.writeHead(200, { 'set-cookie': 'sid=secret; Path=/; HttpOnly', 'content-type': 'text/plain' });
        return res.end('stored');
      }
      if (req.url === '/check-cookie') {
        res.setHeader('content-type', 'text/plain');
        return res.end(`cookie=${req.headers.cookie || ''}`);
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><a href="/redirect">next</a>');
    });
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    firstUrl = `http://127.0.0.1:${first.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => first.close(resolve));
    await new Promise((resolve) => second.close(resolve));
  });

  it('redirects the root to the configured entry and rewrites the returned page', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: firstUrl, allowLoopback: true });
    const root = await request(gateway.handler).get('/').expect(302);
    expect(root.headers.location).toBe(proxyPathFor(new URL(firstUrl)));
    const page = await request(gateway.handler).get(root.headers.location).expect(200);
    expect(page.text).toContain(proxyPathFor(new URL('/redirect', firstUrl)));
    expect(page.headers['content-security-policy']).toBeUndefined();
    expect(page.headers['referrer-policy']).toBe('same-origin');
  });

  it('routes a root-relative request back to the referring virtual origin', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: `${firstUrl}/team/page`, allowLoopback: true });
    const ref = `http://gateway.test${proxyPathFor(new URL('/team/page', firstUrl))}`;
    const response = await request(gateway.handler).get('/').set('Referer', ref).expect(200);
    expect(response.text).toContain(proxyPathFor(new URL('/redirect', firstUrl)));
  });

  it('automatically follows a newly discovered origin through a rewritten redirect', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: firstUrl, allowLoopback: true });
    const redirected = await request(gateway.handler).get(proxyPathFor(new URL('/redirect', firstUrl))).expect(302);
    expect(redirected.headers.location).toBe(proxyPathFor(new URL('/landing?from=first', secondUrl)));
    const landed = await request(gateway.handler).get(redirected.headers.location).expect(200);
    expect(landed.text).toBe('second /landing?from=first cookie=');
  });

  it('keeps a login URL returned in JSON inside the preview gateway', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: firstUrl, allowLoopback: true });
    const response = await request(gateway.handler)
      .get(proxyPathFor(new URL('/auth/login-url', firstUrl)))
      .expect(200);
    const loginUrl = 'https://sso.corp.internal/login?service=https%3A%2F%2Fapi.corp.internal%2Fcallback';
    expect(response.body).toEqual({ code: 0, data: proxyPathFor(new URL(loginUrl)) });
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers.digest).toBeUndefined();
    expect(response.headers.signature).toBeUndefined();
  });

  it('does not rewrite identity URLs in general JSON responses', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: firstUrl, allowLoopback: true });
    const response = await request(gateway.handler)
      .get(proxyPathFor(new URL('/.well-known/openid-configuration', firstUrl)))
      .expect(200);
    expect(response.body).toEqual({
      issuer: 'https://identity.corp.internal',
      authorization_endpoint: 'https://identity.corp.internal/authorize',
    });
  });

  it('keeps upstream cookies in memory instead of exposing them to the phone', async () => {
    const gateway = createInternalPreviewGateway({ entryUrl: firstUrl, allowLoopback: true });
    const stored = await request(gateway.handler).get(proxyPathFor(new URL('/set-cookie', firstUrl))).expect(200);
    expect(stored.headers['set-cookie']).toBeUndefined();
    const checked = await request(gateway.handler).get(proxyPathFor(new URL('/check-cookie', firstUrl))).expect(200);
    expect(checked.text).toBe('cookie=sid=secret');
  });
});

describe('internal preview gateway WebSocket flow', () => {
  it('tunnels an upgrade to a newly discovered host and restores the source Origin', async () => {
    let handshake = '';
    const upstream = net.createServer((socket) => {
      socket.once('data', (data) => {
        handshake = data.toString();
        socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const source = new URL('https://app.corp.internal/dashboard');
    const target = new URL(`ws://127.0.0.1:${upstream.address().port}/socket?room=1`);
    const gateway = createInternalPreviewGateway({ entryUrl: source.href, allowLoopback: true });
    const server = http.createServer(gateway.handler);
    server.on('upgrade', gateway.onUpgrade);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => {
        socket.write(`GET ${proxyWebSocketPathFor(target, source)} HTTP/1.1\r\n`
          + 'Host: gateway.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nCookie: tw_preview=must-not-leak\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    expect(response).toContain('101 Switching Protocols');
    expect(handshake).toContain('GET /socket?room=1 HTTP/1.1');
    expect(handshake).toContain('origin: https://app.corp.internal');
    expect(handshake).not.toContain('tw_preview');
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
});
