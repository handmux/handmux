import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const PREFIX = '/__handmux_proxy__/';
const WS_PREFIX = '/__handmux_ws__/';
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);

function encodeOrigin(origin) {
  return Buffer.from(origin).toString('base64url');
}

function decodeOrigin(token) {
  try {
    const value = Buffer.from(token, 'base64url').toString();
    const url = new URL(value);
    return HTTP_PROTOCOLS.has(url.protocol) && url.href === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

export function proxyPathFor(input) {
  const url = input instanceof URL ? input : new URL(input);
  if (!HTTP_PROTOCOLS.has(url.protocol)) return url.href;
  return `${PREFIX}${encodeOrigin(url.origin)}${url.pathname}${url.search}${url.hash}`;
}

export function decodeProxyPath(path) {
  if (typeof path !== 'string' || !path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const origin = decodeOrigin(rest.slice(0, slash));
  if (!origin) return null;
  try {
    return new URL(rest.slice(slash) || '/', `${origin}/`);
  } catch {
    return null;
  }
}

export function proxyWebSocketPathFor(input, source) {
  const target = input instanceof URL ? input : new URL(input);
  const page = source instanceof URL ? source : new URL(source);
  if (!WS_PROTOCOLS.has(target.protocol) || !HTTP_PROTOCOLS.has(page.protocol)) throw new Error('bad websocket proxy URL');
  return `${WS_PREFIX}${encodeOrigin(page.origin)}/${Buffer.from(target.href).toString('base64url')}`;
}

export function decodeWebSocketPath(path) {
  if (typeof path !== 'string' || !path.startsWith(WS_PREFIX)) return null;
  const [sourceToken, targetToken] = path.slice(WS_PREFIX.length).split('/');
  const sourceOrigin = decodeOrigin(sourceToken);
  if (!sourceOrigin || !targetToken) return null;
  try {
    const target = new URL(Buffer.from(targetToken, 'base64url').toString());
    return WS_PROTOCOLS.has(target.protocol) ? { sourceOrigin, target } : null;
  } catch {
    return null;
  }
}

function rewrittenUrl(raw, baseUrl) {
  const value = String(raw).trim();
  if (!value || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel|about):/i.test(value)) return raw;
  try {
    const url = new URL(value, baseUrl);
    return HTTP_PROTOCOLS.has(url.protocol) ? proxyPathFor(url) : raw;
  } catch {
    return raw;
  }
}

function runtimeFor(pageUrl) {
  const virtual = JSON.stringify(pageUrl.href);
  return `<script data-handmux-internal-preview>(function(){\n`
    + `const V=${virtual},P=${JSON.stringify(PREFIX)};\n`
    + `const e=s=>btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');\n`
    + `const p=(v,b=V)=>{try{const u=new URL(typeof v==='string'?v:v.url,b);if(u.origin===location.origin&&u.pathname.startsWith(P))return u.href;return /^https?:$/.test(u.protocol)?P+e(u.origin)+u.pathname+u.search+u.hash:v}catch{return v}};\n`
    + `const f=window.fetch;window.fetch=(v,o)=>v instanceof Request?f.call(window,new Request(p(v),v),o):f.call(window,p(v),o);\n`
    + `const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return xo.call(this,m,p(u),...a)};\n`
    + `const W=window.WebSocket;window.WebSocket=function(u,pv){const x=new URL(u,V);if(/^https?:$/.test(x.protocol))x.protocol=x.protocol==='https:'?'wss:':'ws:';const s=(location.protocol==='https:'?'wss://':'ws://')+location.host+${JSON.stringify(WS_PREFIX)}+e(new URL(V).origin)+'/'+e(x.href);return pv===undefined?new W(s):new W(s,pv)};window.WebSocket.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k=>Object.defineProperty(window.WebSocket,k,{value:W[k]}));\n`
    + `document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(a)a.href=p(a.href)},true);\n`
    + `document.addEventListener('submit',e=>{if(e.target&&e.target.action)e.target.action=p(e.target.action)},true);\n`
    + `})();</script>`;
}

export function rewriteHtml(html, pageUrl) {
  const base = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  let out = String(html).replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (all, quote, value) => `srcset=${quote}${value.split(',').map((candidate) => {
      const trimmed = candidate.trim();
      const space = trimmed.search(/\s/);
      const url = space < 0 ? trimmed : trimmed.slice(0, space);
      const descriptor = space < 0 ? '' : trimmed.slice(space);
      return `${rewrittenUrl(url, base)}${descriptor}`;
    }).join(', ')}${quote}`,
  ).replace(
    /\b(href|src|action|poster)\s*=\s*(["'])(.*?)\2/gi,
    (all, attr, quote, value) => `${attr}=${quote}${rewrittenUrl(value, base)}${quote}`,
  );
  const runtime = runtimeFor(base);
  if (/<head(?:\s[^>]*)?>/i.test(out)) return out.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${runtime}`);
  return runtime + out;
}

export function rewriteCss(css, stylesheetUrl) {
  const base = stylesheetUrl instanceof URL ? stylesheetUrl : new URL(stylesheetUrl);
  return String(css)
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (all, quote, value) => `url(${quote}${rewrittenUrl(value, base)}${quote})`)
    .replace(/@import\s+(["'])(.*?)\1/gi, (all, quote, value) => `@import ${quote}${rewrittenUrl(value, base)}${quote}`);
}

function rewriteLoginUrlJson(json, target) {
  const source = String(json);
  if (!/\/auth\/login-url\/?$/i.test(target.pathname)) return source;
  try {
    const body = JSON.parse(source);
    if (!body || typeof body !== 'object' || typeof body.data !== 'string' || !/^https?:\/\//i.test(body.data)) return source;
    body.data = proxyPathFor(new URL(body.data));
    return JSON.stringify(body);
  } catch {
    return source;
  }
}

function defaultPath(url) {
  const i = url.pathname.lastIndexOf('/');
  return i <= 0 ? '/' : url.pathname.slice(0, i + 1);
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

export function isBlockedGatewayAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || octets[0] >= 224;
  }
  if (net.isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized === 'fd00:ec2::254') return true;
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mappedDotted) return isBlockedGatewayAddress(mappedDotted[1]);
    const mappedHex = /^(?:::ffff|(?:0+:){5}ffff):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isBlockedGatewayAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return false;
}

function restrictedLookup(dnsLookup, { allowLoopback = false } = {}) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options?.family || 0, hints: options?.hints || 0, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const safe = addresses.find((item) => allowLoopback || !isBlockedGatewayAddress(item.address));
      if (!safe) {
        const denied = new Error(`blocked internal preview address for ${hostname}`);
        denied.code = 'EACCES';
        return callback(denied);
      }
      if (options?.all) callback(null, [{ address: safe.address, family: safe.family }]);
      else callback(null, safe.address, safe.family);
    });
  };
}

export class MemoryCookieJar {
  constructor({ now = () => Date.now(), trustedDomains = [] } = {}) {
    this.now = now;
    this.trustedDomains = new Set(trustedDomains.map((domain) => domain.replace(/^\./, '').toLowerCase()));
    this.cookies = [];
  }

  store(header, source) {
    if (!header) return;
    const url = source instanceof URL ? source : new URL(source);
    const parts = String(header).split(';').map((part) => part.trim());
    const first = parts.shift();
    const equals = first.indexOf('=');
    if (equals <= 0) return;
    const cookie = {
      name: first.slice(0, equals), value: first.slice(equals + 1),
      domain: url.hostname.toLowerCase(), hostOnly: true, path: defaultPath(url),
      secure: false, expiresAt: null,
    };
    for (const part of parts) {
      const [rawName, ...valueParts] = part.split('=');
      const name = rawName.toLowerCase();
      const value = valueParts.join('=').trim();
      if (name === 'domain') {
        const domain = value.replace(/^\./, '').toLowerCase();
        const trusted = [...this.trustedDomains].some((root) => domain === root || domain.endsWith(`.${root}`));
        if (!trusted || !domainMatches(url.hostname.toLowerCase(), domain)) return;
        cookie.domain = domain;
        cookie.hostOnly = false;
      } else if (name === 'path' && value.startsWith('/')) cookie.path = value;
      else if (name === 'secure') cookie.secure = true;
      else if (name === 'max-age' && /^-?\d+$/.test(value)) cookie.expiresAt = this.now() + Number(value) * 1000;
      else if (name === 'expires') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) cookie.expiresAt = parsed;
      }
    }
    this.cookies = this.cookies.filter((item) => !(item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path));
    if (cookie.expiresAt == null || cookie.expiresAt > this.now()) this.cookies.push(cookie);
  }

  header(input) {
    const url = input instanceof URL ? input : new URL(input);
    const now = this.now();
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt == null || cookie.expiresAt > now);
    return this.cookies
      .filter((cookie) => (!cookie.secure || url.protocol === 'https:')
        && (cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain))
        && pathMatches(url.pathname, cookie.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const REWRITTEN_REPRESENTATION_HEADERS = new Set([
  'accept-ranges', 'content-md5', 'content-range', 'content-digest', 'digest', 'etag',
  'repr-digest', 'signature', 'signature-input',
]);

function targetFromRequest(req) {
  const direct = decodeProxyPath(req.url);
  if (direct) return direct;
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    const source = decodeProxyPath(new URL(referer).pathname + new URL(referer).search);
    return source ? new URL(req.url, source.origin) : null;
  } catch {
    return null;
  }
}

function upstreamHeaders(req, target, jar) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'cookie' || lower === 'referer'
      || lower === 'origin' || lower === 'content-length' || lower === 'accept-encoding') continue;
    headers[name] = value;
  }
  headers.host = target.host;
  headers['accept-encoding'] = 'identity';
  const cookie = jar.header(target);
  if (cookie) headers.cookie = cookie;
  if (req.headers.referer) {
    try {
      const ref = new URL(req.headers.referer);
      const virtualRef = decodeProxyPath(ref.pathname + ref.search);
      if (virtualRef) {
        headers.referer = virtualRef.href;
        if (req.headers.origin) headers.origin = virtualRef.origin;
      }
    } catch { /* omit malformed preview referer */ }
  }
  return headers;
}

function responseHeaders(headers, target, jar) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'set-cookie' || lower === 'content-length'
      || lower === 'content-encoding' || lower === 'content-security-policy'
      || lower === 'content-security-policy-report-only' || lower === 'x-frame-options') continue;
    out[name] = value;
  }
  const setCookies = headers['set-cookie'];
  for (const cookie of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) jar.store(cookie, target);
  if (headers.location) {
    try { out.location = proxyPathFor(new URL(headers.location, target)); } catch { delete out.location; }
  }
  out['cache-control'] = 'no-store';
  out['referrer-policy'] = 'same-origin';
  return out;
}

function isHtml(contentType) { return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType || ''); }
function isCss(contentType) { return /text\/css/i.test(contentType || ''); }
function isJson(contentType) { return /^(?:application|text)\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType || ''); }
function isLoginUrlJson(contentType, target) {
  return isJson(contentType) && /\/auth\/login-url\/?$/i.test(target.pathname);
}

export function createInternalPreviewGateway({
  entryUrl,
  insecure = false,
  httpRequest = http.request,
  httpsRequest = https.request,
  netConnect = net.connect,
  tlsConnect = tls.connect,
  dnsLookup = dns.lookup,
  allowLoopback = false,
  cookieDomains = [],
  maxRewriteBytes = 10 * 1024 * 1024,
  timeoutMs = 20_000,
} = {}) {
  const entry = new URL(entryUrl);
  if (!HTTP_PROTOCOLS.has(entry.protocol)) throw new Error('entry URL must use http or https');
  const jar = new MemoryCookieJar({ trustedDomains: cookieDomains });
  const lookup = restrictedLookup(dnsLookup, { allowLoopback });

  function handler(req, res) {
    const target = targetFromRequest(req);
    if (!target && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(302, { location: proxyPathFor(entry), 'cache-control': 'no-store' });
      return res.end();
    }
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('Invalid internal preview URL');
    }
    const secure = target.protocol === 'https:';
    const targetHostname = target.hostname.replace(/^\[|\]$/g, '');
    if (!allowLoopback && net.isIP(targetHostname) && isBlockedGatewayAddress(targetHostname)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('Internal preview blocked a loopback, link-local, or metadata target');
    }
    const transport = secure ? httpsRequest : httpRequest;
    const headers = upstreamHeaders(req, target, jar);
    const up = transport({
      protocol: target.protocol,
      hostname: targetHostname,
      port: target.port || undefined,
      method: req.method,
      path: target.pathname + target.search,
      headers,
      servername: targetHostname,
      rejectUnauthorized: !insecure,
      lookup,
    }, (upRes) => {
      const contentType = upRes.headers['content-type'] || '';
      const rewrite = !upRes.headers['content-encoding']
        && (isHtml(contentType) || isCss(contentType) || isLoginUrlJson(contentType, target));
      const headersOut = responseHeaders(upRes.headers, target, jar);
      if (rewrite) {
        for (const name of Object.keys(headersOut)) {
          if (REWRITTEN_REPRESENTATION_HEADERS.has(name.toLowerCase())) delete headersOut[name];
        }
      }
      if (!rewrite) {
        if (upRes.headers['content-encoding']) headersOut['content-encoding'] = upRes.headers['content-encoding'];
        if (upRes.headers['content-length']) headersOut['content-length'] = upRes.headers['content-length'];
        res.writeHead(upRes.statusCode || 502, headersOut);
        upRes.on('error', () => res.destroy());
        return upRes.pipe(res);
      }
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxRewriteBytes) upRes.destroy(new Error('response too large to rewrite'));
        else chunks.push(chunk);
      });
      upRes.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8');
        const body = isHtml(contentType)
          ? rewriteHtml(source, target)
          : isCss(contentType) ? rewriteCss(source, target) : rewriteLoginUrlJson(source, target);
        res.writeHead(upRes.statusCode || 502, headersOut);
        res.end(body);
      });
      upRes.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`Internal preview response error: ${error.message}`);
        } else res.destroy();
      });
    });
    up.setTimeout(timeoutMs, () => up.destroy(new Error('upstream timeout')));
    up.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`Internal preview upstream error: ${error.message}`);
      } else res.destroy();
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  }

  function onUpgrade(req, socket, head) {
    const decoded = decodeWebSocketPath(req.url);
    if (!decoded) return socket.destroy();
    const { sourceOrigin, target } = decoded;
    const secure = target.protocol === 'wss:';
    const connect = secure ? tlsConnect : netConnect;
    const targetHostname = target.hostname.replace(/^\[|\]$/g, '');
    const options = {
      host: targetHostname,
      port: Number(target.port) || (secure ? 443 : 80),
      lookup,
    };
    if (!allowLoopback && net.isIP(targetHostname) && isBlockedGatewayAddress(targetHostname)) return socket.destroy();
    if (secure) Object.assign(options, {
      servername: targetHostname,
      rejectUnauthorized: !insecure,
      ALPNProtocols: ['http/1.1'],
    });
    let connectTimer;
    const upstream = connect(options, () => {
      clearTimeout(connectTimer);
      upstream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\n`);
      upstream.write(`host: ${target.host}\r\n`);
      upstream.write('upgrade: websocket\r\nconnection: Upgrade\r\n');
      upstream.write(`origin: ${sourceOrigin}\r\n`);
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'cookie' || lower === 'origin') continue;
        upstream.write(`${lower}: ${value}\r\n`);
      }
      const cookie = jar.header(new URL(target.href.replace(/^ws/, 'http')));
      if (cookie) upstream.write(`cookie: ${cookie}\r\n`);
      upstream.write('\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    connectTimer = setTimeout(() => upstream.destroy(new Error('upstream connect timeout')), timeoutMs);
    connectTimer.unref?.();
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => {
      clearTimeout(connectTimer);
      upstream.destroy();
    });
  }

  return { handler, onUpgrade, entryPath: proxyPathFor(entry), cookieJar: jar };
}

export function parseInternalPreviewArgs(argv) {
  const args = [...argv];
  const entryUrl = args.shift();
  if (!entryUrl) throw new Error('an entry URL is required');
  const entry = new URL(entryUrl);
  if (!HTTP_PROTOCOLS.has(entry.protocol)) throw new Error('entry URL must use http or https');
  let port = 4319;
  let insecure = false;
  const cookieDomains = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--insecure') insecure = true;
    else if (arg === '--port') port = Number(args.shift());
    else if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length));
    else if (arg === '--cookie-domain') cookieDomains.push(String(args.shift() || '').replace(/^\./, '').toLowerCase());
    else if (arg.startsWith('--cookie-domain=')) cookieDomains.push(arg.slice('--cookie-domain='.length).replace(/^\./, '').toLowerCase());
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  if (cookieDomains.some((domain) => !domain || !domain.includes('.'))) throw new Error('cookie domain must contain at least two labels');
  return { entryUrl, port, insecure, cookieDomains };
}

export { PREFIX as INTERNAL_PREVIEW_PREFIX };
