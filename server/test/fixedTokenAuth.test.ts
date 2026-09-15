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
const headers = { Origin: origin, 'X-Handmux-Request': '1' };
const bearer = { ...headers, Authorization: 'Bearer secret' };
const cookie = (response: request.Response): string => (response.headers['set-cookie'] as unknown as string[]).map(c => c.split(';')[0]).join('; ');
function fixture(mode: 'token' | 'trusted-device' = 'token') {
  const db = new DatabaseSync(':memory:'); migrateProjectDatabase(db);
  const service = new DeviceAuthService({ db, mode, token: 'secret' });
  const access = createDeviceAccess({ service, resolveOrigin: () => origin });
  const app = express(); app.use(express.json());
  app.use('/api/auth', createDeviceAuthRouter({ service, resolveOrigin: () => origin }));
  app.use('/api', access.middleware);
  app.get('/api/private', (_req, res) => res.json({ deviceId: res.locals.deviceAuth.deviceId }));
  cleanup.push(() => { access.close(); service.close(); db.close(); });
  return { db, service, app };
}
async function register(app: express.Express) {
  const pairing = await request(app).post('/api/auth/pairing').set(bearer).send({}).expect(200);
  const candidate = cookie(pairing);
  const added = await request(app).post('/api/auth/devices/self').set(bearer).set('Cookie', candidate).send({ name: 'This browser', expire: '30d' }).expect(200);
  return { device: added.body.device, primary: cookie(added), candidate };
}
describe('fixed Token and trusted devices together', () => {
  it('defaults new installs off, preserves legacy installs, and persists explicit disable across stale startup config', () => {
    const { service: fresh } = fixture('trusted-device');
    expect(fresh.tokenEnabled).toBe(false);
    expect(fresh.createPairing(null, origin, 'Browser').pairing.state).toBe('waiting');
    const { db, service } = fixture();
    expect(service.authenticateToken('secret', origin)).not.toBeNull();
    service.setTokenEnabled(false, { allowEmpty: true }); service.close();
    const restarted = new DeviceAuthService({ db, mode: 'token', token: 'secret' });
    cleanup.push(() => restarted.close());
    expect(restarted.tokenEnabled).toBe(false);
    expect(restarted.authenticateToken('secret', origin)).toBeNull();
  });
  it('keeps fixed Token rate limits independent for separate browser sources', async () => {
    const { app } = fixture();
    const first = { ...bearer, 'User-Agent': 'Browser-A' };
    const second = { ...bearer, 'User-Agent': 'Browser-B' };
    for (let i = 0; i < 600; i += 1) {
      const response = await request(app).get('/api/auth/status').set(first);
      if (response.status !== 200) throw new Error(`iteration ${i}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    await request(app).get('/api/auth/status').set(first).expect(429);
    await request(app).get('/api/auth/status').set(second).expect(200);
  }, 20_000);
  it('registers this browser, confirms Cookie, disables without restart, and keeps device access', async () => {
    const { app, service } = fixture();
    await request(app).get('/api/private?token=secret').set(headers).expect(401);
    await request(app).get('/api/private').set(bearer).expect(200);
    const before = await request(app).get('/api/auth/status').set(bearer).expect(200);
    expect(before.body).toMatchObject({ authenticated: true, tokenAuthenticated: true, currentDeviceId: null, tokenEnabled: true });
    await request(app).get('/api/auth/devices').set(bearer).expect(200);
    await request(app).post('/api/auth/token/disable').set(bearer).send({}).expect(401);
    const { primary, candidate, device } = await register(app);
    const retried = await request(app).post('/api/auth/devices/self').set(bearer).set('Cookie', candidate).send({ name: 'duplicate', expire: 'never' }).expect(200);
    expect(retried.body.device).toEqual(device); expect(service.list()).toHaveLength(1);
    // A saved candidate is not yet a formal management credential.
    await request(app).post('/api/auth/token/disable').set(bearer).set('Cookie', candidate).send({}).expect(401);
    const status = await request(app).get('/api/auth/status').set(headers).set('Cookie', primary).expect(200);
    expect(status.body.currentDeviceId).toBe(device.id);
    await request(app).post('/api/auth/token/disable').set(headers).set('Cookie', primary).send({}).expect(200);
    await request(app).get('/api/private').set(bearer).expect(401);
    await request(app).get('/api/private').set(bearer).set('Cookie', primary).expect(200);
    const after = await request(app).get('/api/auth/status').set(headers).set('Cookie', primary).expect(200);
    expect(after.body).toMatchObject({ tokenEnabled: false, authenticated: true, currentDeviceId: device.id });
  });
  it('checks device identity and Origin at the final mutation, and never grants other-device management to Token', async () => {
    const { app, service } = fixture();
    const { primary, device } = await register(app);
    await request(app).patch(`/api/auth/devices/${device.id}`).set(bearer).send({ name: 'bad', version: device.version }).expect(401);
    await request(app).post('/api/auth/token/disable').set(headers).set('Origin', 'https://evil.example').set('Cookie', primary).send({}).expect(403);
    service.revoke(device.id);
    await request(app).post('/api/auth/token/disable').set(bearer).set('Cookie', primary).send({ deviceId: device.id }).expect(401);
    expect(() => service.setTokenEnabled(false, { allowEmpty: false })).toThrow(/DISABLE TOKEN/);
    expect(service.tokenEnabled).toBe(true);
    service.setTokenEnabled(false, { allowEmpty: true }); expect(service.tokenEnabled).toBe(false);
  });
  it('keeps state on storage errors and never revives old derived principals after re-enable', () => {
    const { service, db } = fixture();
    const principal = service.authenticateToken('secret', origin)!;
    const revoked = vi.fn(); service.onRevoke(revoked);
    const fault = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(() => service.setTokenEnabled(false, { allowEmpty: true })).toThrow('disk unavailable');
    expect(service.tokenEnabled).toBe(true); expect(revoked).not.toHaveBeenCalled(); fault.mockRestore();
    service.setTokenEnabled(false, { allowEmpty: true }); expect(revoked).toHaveBeenCalledWith(principal.deviceId);
    service.setTokenEnabled(true); expect(service.isActive(principal)).toBe(false);
    expect(service.isActive(service.authenticateToken('secret', origin)!)).toBe(true);
  });
  it('disconnects Token SSE immediately and preserves an existing trusted device SSE', async () => {
    const { app, service } = fixture(); const { primary } = await register(app);
    app.get('/api/events', (_req, res) => { res.set('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    cleanup.push(() => new Promise<void>(r => server.close(() => r())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const open = async (extra: Record<string,string>) => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => http.get({ host: '127.0.0.1', port: address.port, path: '/api/events', headers: { ...headers, ...extra } }, resolve).on('error', reject));
      cleanup.push(() => response.destroy()); await new Promise<void>(r => response.once('data', () => r())); return response;
    };
    const tokenStream = await open({ Authorization: 'Bearer secret' }); const deviceStream = await open({ Cookie: primary });
    const closed = new Promise<void>(r => { tokenStream.once('close', r); tokenStream.on('error', () => {}); });
    service.setTokenEnabled(false, { actor: service.authenticateRequest({ headers: { cookie: primary } } as http.IncomingMessage, origin)! });
    await closed; expect(tokenStream.complete).toBe(false); expect(deviceStream.destroyed).toBe(false);
  });
  it('disconnects Token WebSocket immediately while keeping trusted device WebSocket open', async () => {
    const { app, service } = fixture(); const { primary } = await register(app);
    // Hold pane lookup: revocation must prevent queued subscription from spawning tmux.
    let started!: () => void; const subscribed = new Promise<void>(r => { started = r; });
    let finish!: (value: string) => void; const pane = new Promise<string>(r => { finish = r; });
    const stream = createTerminalStream({ token: 'secret', commands: { paneSession: () => { started(); return pane; } }, deviceAuth: { service, resolveOrigin: () => origin } });
    const server = http.createServer(app); server.on('upgrade', stream.onUpgrade);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => { finish('session'); stream.close(); await new Promise<void>(r => server.close(() => r())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `ws://127.0.0.1:${address.port}/api/terminal-stream`;
    const open = async (extra: Record<string,string>) => { const ws = new WebSocket(url, { headers: { Origin: origin, ...extra } }); cleanup.push(() => ws.terminate()); await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); }); return ws; };
    const tokenSocket = await open({}); const deviceSocket = await open({ Cookie: primary });
    tokenSocket.send(JSON.stringify({ type: 'subscribe', pane: '%1', token: 'secret' })); await subscribed;
    const closed = new Promise<number>(r => tokenSocket.once('close', r));
    service.setTokenEnabled(false, { allowEmpty: false });
    expect(await closed).toBe(4001); expect(deviceSocket.readyState).toBe(WebSocket.OPEN);
  });
});
