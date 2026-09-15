import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http, { type IncomingMessage } from 'node:http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { DeviceAuthService, sessionCookieName } from '../src/deviceAuth/service.js';
import { createDeviceAuthRouter } from '../src/deviceAuth/http.js';
import { connectAuthControl, startDeviceAuthControl } from '../src/deviceAuth/control.js';
import { createAuthOriginResolver, createDeviceAccess } from '../src/deviceAccess.js';
import { requestOrigin } from '../src/requestOrigin.js';
import { createTerminalStream } from '../src/terminalStream.js';
import { terminalRoutes } from '../src/routes/terminal.js';
import * as commands from '../src/tmux/commands.js';
import { serializePaneInput } from '../src/paneInput.js';
import { assertRequestAuthority } from '../src/requestAuthority.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); migrateProjectDatabase(db);
  const service = new DeviceAuthService({ db, token: 'secret' });
  const origin = 'http://localhost:4000';
  const resolveOrigin = createAuthOriginResolver({ port: 4000, host: '0.0.0.0' });
  const access = createDeviceAccess({ service, resolveOrigin });
  const app = express();
  app.use((req, _res, next) => { if (!req.headers.authorization) req.headers.authorization = 'Bearer secret'; next(); });
  app.use('/api/auth', express.json(), createDeviceAuthRouter({ service, resolveOrigin }));
  app.use('/api', access.middleware);
  app.use('/api', express.json());
  app.get('/api/private', (_req, res) => res.json({ device: res.locals.deviceAuth.deviceId }));
  cleanup.push(() => { access.close(); service.close(); db.close(); });
  return { app, service, origin, resolveOrigin };
}
function reqMock(host: string, remoteAddress = '127.0.0.1', proto?: string, extra: Record<string, string> = {}): IncomingMessage {
  return { headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}), ...extra }, socket: { remoteAddress } } as IncomingMessage;
}
describe('known auth entry points', () => {
  it('accepts local and configured origins, while rejecting unknown hosts', () => {
    const resolve = createAuthOriginResolver({ port: 4000, host: '0.0.0.0', publicUrl: 'https://mux.example' });
    expect(resolve(reqMock('localhost:4000'))).toBe('http://localhost:4000');
    expect(resolve(reqMock('evil.example:4000'))).toBeNull();
    expect(resolve(reqMock('evil.example', '127.0.0.1', 'https'))).toBeNull();
    expect(resolve(reqMock('mux.example', '127.0.0.1', 'https'))).toBe('https://mux.example');
    expect(resolve(reqMock('mux.example', '192.0.2.2', 'https'))).toBe('https://mux.example');
    expect(resolve(reqMock('localhost:4000@evil.example'))).toBeNull();
  });
  it('learns trusted supervisor tunnel changes without accepting forwarded host', () => {
    let url: string | null = null;
    const resolve = createAuthOriginResolver({ port: 4000, host: '0.0.0.0', runtimePublicUrl: () => url });
    expect(resolve(reqMock('mux.example', '::1', 'https'))).toBeNull();
    url = 'https://mux.example';
    expect(resolve(reqMock('mux.example', '::1', 'https'))).toBe(url);
    url = null;
    expect(resolve(reqMock('mux.example', '::1', 'https'))).toBeNull();
  });

  it('accepts the dynamic preview wildcard and user-managed trusted wildcards', () => {
    const resolve = createAuthOriginResolver({
      port: 4000, host: '0.0.0.0', previewDomain: 'preview.example.com',
      trustedOrigins: () => ['https://*.extra.example.com'],
    });
    expect(resolve(reqMock('one.preview.example.com', '203.0.113.4', 'https'))).toBe('https://one.preview.example.com');
    expect(resolve(reqMock('a.extra.example.com', '203.0.113.4', 'https'))).toBe('https://a.extra.example.com');
    expect(resolve(reqMock('extra.example.com', '203.0.113.4', 'https'))).toBeNull();
    expect(resolve(reqMock('a.extra.example.com', '203.0.113.4', 'http'))).toBeNull();
  });

  it('keeps a TLS-terminated custom tunnel on HTTPS without forwarded protocol', () => {
    const resolve = createAuthOriginResolver({ port: 4000, host: '0.0.0.0', trustedOrigins: () => ['https://mux.example'] });
    expect(requestOrigin(reqMock('mux.example', '127.0.0.1', undefined, { origin: 'https://mux.example' }))).toBe('https://mux.example');
    expect(resolve(reqMock('mux.example', '127.0.0.1', undefined, { origin: 'https://mux.example' }))).toBe('https://mux.example');
    expect(requestOrigin(reqMock('mux.example:443', '127.0.0.1', undefined, { origin: 'https://mux.example' }))).toBe('https://mux.example');
    expect(requestOrigin(reqMock('mux.example:80', '127.0.0.1', undefined, { origin: 'https://mux.example' }))).toBe('http://mux.example');
    expect(requestOrigin(reqMock('mux.example', '127.0.0.1', undefined, { cookie: '__Host-handmux_pairing_abc=secret' }))).toBe('https://mux.example');
    expect(requestOrigin(reqMock('mux.example', '203.0.113.4', undefined, { origin: 'https://mux.example' }))).toBe('http://mux.example');
  });

  it('allows a valid Token from an unknown host when both protections are off', async () => {
    const db = new DatabaseSync(':memory:'); migrateProjectDatabase(db);
    const service = new DeviceAuthService({ db, token: 'secret' });
    service.setTrustedDeviceEnabled(false);
    service.setTrustedOriginEnabled(false);
    const resolveOrigin = createAuthOriginResolver({ port: 4000, host: '0.0.0.0', trustedOriginEnabled: () => service.trustedOriginEnabled });
    const access = createDeviceAccess({ service, resolveOrigin });
    const app = express(); app.use(express.json()); app.use('/api/auth', createDeviceAuthRouter({ service, resolveOrigin })); app.use('/api', access.middleware);
    app.get('/api/private', (_req, res) => res.json({ ok: true }));
    cleanup.push(() => { access.close(); service.close(); db.close(); });
    await request(app).get('/api/private').set({ Host: 'custom.example', Origin: 'http://custom.example', Authorization: 'Bearer secret' }).expect(200, { ok: true });
  });
});
describe('browser → CLI socket → protected HTTP / WebSocket', () => {
  it('does not cancel an already accepted background job on logout', async () => {
    const { app, service, origin } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let completed: Promise<string> | undefined;
    app.post('/api/background', (_req, res) => {
      completed = (async () => { await gate; assertRequestAuthority(); return 'completed'; })();
      res.status(202).json({ accepted: true });
    });
    const pair = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pair.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'background', expire: '1h' });
    await request(app).post('/api/background').set({ Host: 'localhost:4000', Origin: origin,
      'X-Handmux-Request': '1', Cookie: `${sessionCookieName(origin)}=${pair.secret}`,
    }).send({}).expect(202);
    service.revoke(device.id); release();
    expect(await completed).toBe('completed');
  });
  it('does not execute queued pane input after revocation', async () => {
    const { app, service, origin } = fixture();
    const sent = vi.fn(async () => {});
    let received = false;
    app.use((_req, _res, next) => { received = true; next(); });
    app.use('/api', terminalRoutes({ commands: { ...commands, sendText: sent, exitCopyModeIfActive: vi.fn(async () => {}) } }));
    const pair = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pair.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'queued', expire: '1h' });
    let release!: () => void;
    const blocked = serializePaneInput('%99001', () => new Promise<void>(resolve => { release = resolve; }));
    const pending = request(app).post('/api/send').set({ Host: 'localhost:4000', Origin: origin,
      'X-Handmux-Request': '1', Cookie: `${sessionCookieName(origin)}=${pair.secret}`,
    }).send({ pane: '%99001', text: 'must not type', enter: false }).then(value => value, error => error);
    await vi.waitFor(() => expect(received).toBe(true));
    service.revoke(device.id);
    release(); await blocked; await pending;
    await serializePaneInput('%99001', async () => {});
    expect(sent).not.toHaveBeenCalled();
  });
  it('does not send delayed Enter after text was sent but authorization was revoked', async () => {
    const { app, service, origin } = fixture();
    const sent = vi.fn(async () => {}); const enter = vi.fn(async () => {});
    app.use('/api', terminalRoutes({ commands: { ...commands, sendText: sent, sendEnter: enter, exitCopyModeIfActive: vi.fn(async () => {}) } }));
    const pair = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pair.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'delayed', expire: '1h' });
    const pending = request(app).post('/api/send').set({ Host: 'localhost:4000', Origin: origin,
      'X-Handmux-Request': '1', Cookie: `${sessionCookieName(origin)}=${pair.secret}`,
    }).send({ pane: '%99002', text: 'already typed', enter: true }).then(value => value, error => error);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce(), { interval: 1 });
    service.revoke(device.id); await pending;
    await serializePaneInput('%99002', async () => {});
    expect(enter).not.toHaveBeenCalled();
  });
  it('actively disconnects authenticated SSE when the owning device is revoked', async () => {
    const { app, service, origin } = fixture();
    app.get('/api/events', (_req, res) => { res.set('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
    const pair = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pair.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'stream', expire: '1h' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no test port');
    const incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: address.port, path: '/api/events', headers: {
        Host: 'localhost:4000', Origin: origin, 'X-Handmux-Request': '1', Cookie: `${sessionCookieName(origin)}=${pair.secret}`,
      } }, resolve).once('error', reject);
    });
    expect(incoming.statusCode).toBe(200);
    await new Promise<void>(resolve => incoming.once('data', () => resolve()));
    const disconnected = new Promise<void>(resolve => { incoming.once('close', resolve); incoming.on('error', () => {}); });
    service.revoke(device.id);
    await disconnected;
    expect(incoming.complete).toBe(false);
  });
  it('does not authorize on claim; binds only the original browser and revokes immediately', async () => {
    const { app, service, origin } = fixture();
    const temp = await mkdtemp(path.join(tmpdir(), 'handmux-auth-access-'));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    const control = await startDeviceAuthControl({ service, home: temp });
    cleanup.push(() => control.close());
    const client = await connectAuthControl(temp); cleanup.push(() => client.close());
    const headers = { Host: 'localhost:4000', Origin: origin, 'X-Handmux-Request': '1' };
    const pair = await request(app).post('/api/auth/pairing').set(headers).send({}).expect(200);
    const candidate = String(pair.headers['set-cookie']?.[0]).split(';')[0]!;
    const claim = await client.request({ op: 'claim', code: pair.body.pairing.code }) as { id: string };
    await request(app).get('/api/private').set(headers).set('Cookie', candidate).expect(401);
    const device = await client.request({ op: 'authorize', id: claim.id, name: '电脑', expire: '7d' }) as { id: string };
    const status = await request(app).get('/api/auth/status').set(headers).set('Cookie', candidate).expect(200);
    // The candidate may authenticate the recovery lookup, but it is not a confirmed
    // primary session until the formal Cookie is sent back on a later request.
    expect(status.body.currentDeviceId).toBeNull();
    const cookie = String(status.headers['set-cookie']?.[0]).split(';')[0]!;
    await request(app).get('/api/private').set(headers).set('Cookie', cookie).expect(200, { device: device.id });
    await request(app).get('/api/private').set(headers).set('Authorization', 'Bearer old-token').expect(401);
    await request(app).get('/api/private').set(headers).set('Cookie', cookie).set('Origin', 'null').expect(403);
    await request(app).get('/api/private').set('Host', 'localhost:4000').set('Cookie', cookie).expect(200);
    await client.request({ op: 'device-revoke', id: device.id });
    await request(app).get('/api/private').set(headers).set('Cookie', cookie).expect(401);
  });
  it('authenticates Upgrade with Cookie + Origin and closes on revoke', async () => {
    const { service } = fixture();
    const server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no test port');
    const origin = `http://127.0.0.1:${address.port}`;
    const resolveOrigin = createAuthOriginResolver({ port: address.port, host: '127.0.0.1' });
    const stream = createTerminalStream({ token: 'old-token', commands: { paneSession: async () => 'test' }, deviceAuth: { service, resolveOrigin } });
    server.on('upgrade', stream.onUpgrade);
    cleanup.push(async () => { stream.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const pair = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pair.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'test', expire: '1h' });
    const url = `ws://127.0.0.1:${address.port}/api/terminal-stream`;
    const cookie = `${sessionCookieName(origin)}=${pair.secret}`;
    const missingOrigin = new WebSocket(url, { headers: { Cookie: cookie } }); missingOrigin.on('error', () => {});
    const status = await new Promise<number | undefined>(resolve => missingOrigin.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); missingOrigin.terminate(); }));
    expect(status).toBe(401);
    const evil = new WebSocket(url, { headers: { Cookie: cookie, Origin: 'https://evil.example' } }); evil.on('error', () => {});
    const evilStatus = await new Promise<number | undefined>(resolve => evil.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); evil.terminate(); }));
    expect(evilStatus).toBe(401);
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
    await new Promise<void>(resolve => ws.on('open', resolve));
    const closed = new Promise<number>(resolve => ws.on('close', resolve));
    ws.send(JSON.stringify({ type: 'subscribe', pane: '%1', token: 'old-token' }));
    expect(await closed).toBe(4001);
    const active = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
    await new Promise<void>(resolve => active.on('open', resolve));
    const revoked = new Promise<number>(resolve => active.on('close', resolve));
    service.revoke(device.id);
    expect(await revoked).toBe(4001);
  });
});
