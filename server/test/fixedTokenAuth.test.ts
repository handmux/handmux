import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { DeviceAuthService } from '../src/deviceAuth/service.js';
import { createDeviceAuthRouter } from '../src/deviceAuth/http.js';
import { createDeviceAccess } from '../src/deviceAccess.js';
import { createTerminalStream } from '../src/terminalStream.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'http://localhost:4000';
const headers = { Origin: origin };
const bearer = { ...headers, Authorization: 'Bearer secret' };
const cookie = (response: request.Response): string => (response.headers['set-cookie'] as unknown as string[]).map(c => c.split(';')[0]).join('; ');
function fixture() {
  const db = new DatabaseSync(':memory:'); migrateProjectDatabase(db);
  const service = new DeviceAuthService({ db, token: 'secret' });
  service.setTrustedDeviceEnabled(false);
  const access = createDeviceAccess({ service, resolveOrigin: () => origin });
  const app = express(); app.use(express.json());
  app.use('/api/auth', createDeviceAuthRouter({ service, resolveOrigin: () => origin }));
  app.use('/api', access.middleware);
  app.get('/api/private', (_req, res) => res.json({ deviceId: res.locals.deviceAuth.deviceId }));
  cleanup.push(() => { access.close(); service.close(); db.close(); });
  return { db, service, app };
}
async function register(app: express.Express, name = 'This browser') {
  const pairing = await request(app).post('/api/auth/pairing').set(bearer).send({}).expect(200);
  const candidate = cookie(pairing);
  const added = await request(app).post('/api/auth/devices/self').set(bearer).set('Cookie', candidate).send({ name, expire: 'never' }).expect(200);
  return { device: added.body.device, primary: cookie(added), candidate };
}
it('recognizes the Token factor while trusted-device protection is enabled', () => {
  const { service } = fixture();
  service.setTrustedDeviceEnabled(true);
  expect(service.authenticateToken('secret', origin)).not.toBeNull();
  expect(service.isActive(service.authenticateToken('secret', origin)!)).toBe(false);
});
describe('Token factor with optional trusted device protection', () => {
  it('requires Token even for a valid formal device cookie', async () => {
    const { app, service } = fixture();
    const { primary } = await register(app);
    await request(app).get('/api/private').set(headers).set('Cookie', primary).expect(401);
    await request(app).get('/api/private').set(bearer).expect(200);
    await request(app).get('/api/private').set(bearer).set('Cookie', primary).expect(200);
    await request(app).post('/api/auth/token/disable').set(bearer).set('Cookie', primary).send({}).expect(404);
    expect(service.tokenEnabled).toBe(true);
    service.setTrustedDeviceEnabled(false);
    await request(app).get('/api/private').set(bearer).expect(200);
    await request(app).get('/api/private').set(headers).set('Cookie', primary).expect(401);
  });
  it('keeps Token rate limits separate from anonymous traffic and other browser sources', async () => {
    const { app } = fixture();
    const first = { ...bearer, 'User-Agent': 'Browser-A' };
    for (let i = 0; i < 600; i += 1) await request(app).get('/api/auth/status').set(headers).expect(200);
    await request(app).get('/api/auth/status').set(headers).expect(429);
    for (let i = 0; i < 600; i += 1) await request(app).get('/api/auth/status').set(first).expect(200);
    await request(app).get('/api/auth/status').set(first).expect(429);
    await request(app).get('/api/auth/status').set({ ...bearer, 'User-Agent': 'Browser-B' }).expect(200);
  }, 60_000);
  it('requires a formal cookie before enabling device protection or managing other devices', async () => {
    const { app, service } = fixture();
    const { primary, candidate, device } = await register(app);
    service.setTrustedDeviceEnabled(false);
    await request(app).post('/api/auth/device-protection/enable').set(bearer).set('Cookie', candidate).send({}).expect(409);
    await request(app).post('/api/auth/device-protection/enable').set(bearer).set('Cookie', primary).send({}).expect(200);
    await request(app).patch(`/api/auth/devices/${device.id}`).set(bearer).set('Cookie', candidate).send({ name: 'bad', version: device.version }).expect(401);
    await request(app).patch(`/api/auth/devices/${device.id}`).set(headers).set('Cookie', primary).send({ name: 'bad', version: device.version }).expect(401);
    await request(app).post('/api/auth/device-protection/enable').set(bearer).set('Origin', 'https://evil.example').set('Cookie', primary).send({}).expect(403);
  });
  it('recovers a durable candidate after restart without granting access before formal cookie confirmation', async () => {
    const { db, service } = fixture();
    service.setTrustedDeviceEnabled(true);
    const pending = service.createPairing(null, origin, 'Browser');
    const claim = service.claim(pending.pairing.code, 'cli');
    const device = service.authorize(claim.id, 'cli', { name: 'Phone', expire: 'never' });
    service.close();
    const restored = new DeviceAuthService({ db, token: 'secret' });
    const access = createDeviceAccess({ service: restored, resolveOrigin: () => origin });
    cleanup.push(() => { access.close(); restored.close(); });
    const app = express(); app.use(express.json());
    app.use('/api/auth', createDeviceAuthRouter({ service: restored, resolveOrigin: () => origin }));
    app.use('/api', access.middleware); app.get('/api/private', (_req, res) => res.json({ ok: true }));
    const { pairingCookieName } = await import('../src/deviceAuth/service.js');
    const candidate = `${pairingCookieName(origin)}_${claim.id.slice(5)}=${pending.secret}`;
    const missingToken = await request(app).get('/api/auth/status').set(headers).set('Cookie', candidate).expect(200);
    expect(missingToken.body).toMatchObject({ authenticated: false, sessionPending: false, tokenAuthenticated: false });
    expect(missingToken.headers['set-cookie']).toBeUndefined();
    const status = await request(app).get('/api/auth/status').set(bearer).set('Cookie', candidate).expect(200);
    expect(status.body).toMatchObject({ authenticated: false, sessionPending: true, currentDeviceId: null });
    expect(status.body.pairing).toBeUndefined();
    await request(app).get('/api/private').set(bearer).set('Cookie', candidate).expect(401);
    const primary = cookie(status);
    const confirmed = await request(app).get('/api/auth/status').set(bearer).set('Cookie', primary).expect(200);
    expect(confirmed.body).toMatchObject({ authenticated: true, sessionPending: false, currentDeviceId: device.id });
    await request(app).get('/api/private').set(bearer).set('Cookie', primary).expect(200);
  });
  it('keeps both protection policies unchanged on storage failure', () => {
    const { service, db } = fixture();
    service.setTrustedDeviceEnabled(true);
    const fault = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(() => service.setTrustedDeviceEnabled(false)).toThrow('disk unavailable');
    expect(() => service.setTrustedOriginEnabled(false)).toThrow('disk unavailable');
    expect(service.trustedDeviceEnabled).toBe(true);
    expect(service.trustedOriginEnabled).toBe(true);
    expect(service.tokenEnabled).toBe(true);
    fault.mockRestore();
  });
  it('disconnects a revoked device SSE without disconnecting another authorized device', async () => {
    const { app, service } = fixture();
    const first = await register(app, 'Browser A'); const second = await register(app, 'Browser B'); service.setTrustedDeviceEnabled(true);
    app.get('/api/events', (_req, res) => { res.set('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    cleanup.push(() => new Promise<void>(r => server.close(() => r())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const open = async (primary: string) => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => http.get({ host: '127.0.0.1', port: address.port, path: '/api/events', headers: { ...bearer, Cookie: primary } }, resolve).on('error', reject));
      cleanup.push(() => response.destroy()); await new Promise<void>(r => response.once('data', () => r())); return response;
    };
    const firstStream = await open(first.primary); const secondStream = await open(second.primary);
    const closed = new Promise<void>(r => { firstStream.once('close', r); firstStream.on('error', () => {}); });
    service.revoke(first.device.id);
    await closed; expect(firstStream.complete).toBe(false); expect(secondStream.destroyed).toBe(false);
  });
  it('disconnects a revoked device WebSocket while another authorized socket stays open', async () => {
    const { app, service } = fixture(); const first = await register(app, 'Browser A'); const second = await register(app, 'Browser B'); service.setTrustedDeviceEnabled(true);
    let started!: () => void; const subscribed = new Promise<void>(r => { started = r; });
    let finish!: (value: string) => void; const pane = new Promise<string>(r => { finish = r; });
    const stream = createTerminalStream({ token: 'secret', commands: { paneSession: () => { started(); return pane; } }, deviceAuth: { service, resolveOrigin: () => origin } });
    const server = http.createServer(app); server.on('upgrade', stream.onUpgrade);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => { finish('session'); stream.close(); await new Promise<void>(r => server.close(() => r())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `ws://127.0.0.1:${address.port}/api/terminal-stream`;
    const open = async (primary: string) => { const ws = new WebSocket(url, { headers: { Origin: origin, Cookie: primary } }); cleanup.push(() => ws.terminate()); await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); }); return ws; };
    const firstSocket = await open(first.primary); const secondSocket = await open(second.primary);
    firstSocket.send(JSON.stringify({ type: 'subscribe', pane: '%1', token: 'secret' })); await subscribed;
    const closed = new Promise<number>(r => firstSocket.once('close', r));
    service.revoke(first.device.id);
    expect(await closed).toBe(4001); expect(secondSocket.readyState).toBe(WebSocket.OPEN);
  });
});
