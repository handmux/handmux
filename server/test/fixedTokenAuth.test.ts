import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { DeviceAuthService } from '../src/deviceAuth/service.js';
import { createDeviceAuthRouter } from '../src/deviceAuth/http.js';
import { createDeviceAccess } from '../src/deviceAccess.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'http://localhost:4000';
const headers = { Origin: origin, Host: 'localhost:4000' };
const bearer = { ...headers, Authorization: 'Bearer secret' };
const cookie = (response: request.Response): string => (response.headers['set-cookie'] as unknown as string[]).map(c => c.split(';')[0]).join('; ');
function fixture(mode: 'token' | 'trusted-device' = 'trusted-device') {
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
  it('keeps the fixed Token enabled and marks a legacy token-only database for migration', () => {
    const fresh = fixture('trusted-device').service;
    expect(fresh.tokenEnabled).toBe(true);
    expect(fresh.migrationRequired).toBe(false);
    expect(fresh.requiresTrustedDevice).toBe(true);
    const legacy = fixture('token').service;
    expect(legacy.tokenEnabled).toBe(true);
    expect(legacy.migrationRequired).toBe(true);
    expect(legacy.authenticateToken('secret', origin)).not.toBeNull();
  });

  it('requires both factors for business access, while Token alone can start migration pairing', async () => {
    const { app } = fixture('token');
    await request(app).get('/api/private').set(headers).expect(401);
    await request(app).get('/api/private').set({ ...headers, Authorization: 'Bearer wrong' }).expect(401);
    const status = await request(app).get('/api/auth/status').set(bearer).expect(200);
    expect(status.body).toMatchObject({ authenticated: false, tokenAuthenticated: true, tokenEnabled: true, migrationRequired: true, requiresTrustedDevice: true });
    await request(app).post('/api/auth/pairing').set(bearer).send({}).expect(200);
  });

  it('registers a browser and requires Token plus its trusted-device Cookie thereafter', async () => {
    const { app, service } = fixture('token');
    const { primary, candidate, device } = await register(app);
    await request(app).get('/api/private').set(headers).set('Cookie', primary).expect(401);
    await request(app).get('/api/private').set(bearer).expect(401);
    await request(app).get('/api/private').set(bearer).set('Cookie', primary).expect(200, { deviceId: device.id });
    const status = await request(app).get('/api/auth/status').set(bearer).set('Cookie', primary).expect(200);
    expect(status.body).toMatchObject({ authenticated: true, tokenAuthenticated: true, currentDeviceId: device.id, migrationRequired: false, requiresTrustedDevice: false });
    const retried = await request(app).post('/api/auth/devices/self').set(bearer).set('Cookie', candidate).send({ name: 'duplicate', expire: 'never' }).expect(200);
    expect(retried.body.device).toEqual(device);
    await request(app).get('/api/auth/devices').set(bearer).set('Cookie', primary).expect(200);
    service.revoke(device.id);
    await request(app).get('/api/private').set(bearer).set('Cookie', primary).expect(401);
  });

  it('does not let a Token-only browser manage devices or register without its pairing cookie', async () => {
    const { app } = fixture();
    await request(app).get('/api/auth/devices').set(bearer).expect(401);
    await request(app).post('/api/auth/devices/self').set(bearer).send({ name: 'No cookie', expire: '1h' }).expect(409);
  });

  it('rejects the removed Token disable endpoint and keeps the factor after restart', () => {
    const { db, service } = fixture('token');
    expect(() => service.setTokenEnabled(false)).toThrow(/always required/);
    expect(service.tokenEnabled).toBe(true);
    service.close();
    const restored = new DeviceAuthService({ db, mode: 'trusted-device', token: 'secret' });
    cleanup.push(() => restored.close());
    expect(restored.tokenEnabled).toBe(true);
    expect(restored.authenticateToken('secret', origin)).not.toBeNull();
  });
});
