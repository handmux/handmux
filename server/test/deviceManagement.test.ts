import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceAuthService, pairingCookieName, sessionCookieName } from '../src/deviceAuth/service.js';
import { createDeviceAuthRouter } from '../src/deviceAuth/http.js';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { createProjectTaskRuntime } from '../src/projectTask/runtime.js';
import { tmpHome } from './tmphome.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const origin = 'http://localhost:19999';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); });
function fixture() {
  const db = new DatabaseSync(':memory:'); migrateProjectDatabase(db);
  const service = new DeviceAuthService({ db, mode: 'trusted-device', token: 'secret' }); cleanup.push(() => { service.close(); db.close(); });
  const p = service.createPairing(null, origin, 'Chrome'); const c = service.claim(p.pairing.code, 'cli'); const device = service.authorize(c.id, 'cli', { name: 'Existing browser', expire: '1h' });
  const actor = service.authenticateSecret(p.secret!, origin)!;
  const app = express(); app.use(express.json()); app.use('/api/auth', createDeviceAuthRouter({ service, resolveOrigin: () => origin }));
  const auth = (r: request.Test) => r.set('Origin', origin).set('Authorization', 'Bearer secret').set('X-Handmux-Request', '1').set('Cookie', `${sessionCookieName(origin)}=${p.secret}`);
  return { service, actor, db, app, auth, device, secret: p.secret! };
}
describe('phase two shared device management', () => {
  it('requires a formal primary Cookie, never a Token or even an authorized candidate Cookie', async () => {
    const { app, secret, device } = fixture();
    for (const cookie of ['', `${pairingCookieName(origin)}_${'a'.repeat(32)}=${secret}`]) {
      await request(app).get('/api/auth/devices').set('X-Handmux-Request', '1').set('Cookie', cookie).set('Authorization', 'Bearer old-token').expect(401);
      await request(app).post('/api/auth/approvals').set('X-Handmux-Request', '1').set('Origin', origin).set('Cookie', cookie).send({ code: '038271' }).expect(401);
    }
    await request(app).patch(`/api/auth/devices/${device.id}`).set('X-Handmux-Request', '1').set('Origin', 'https://evil.example').set('Cookie', `${sessionCookieName(origin)}=${secret}`).send({ name: 'Bad', version: 1 }).expect(403);
  });
  it('renews primary management Cookies, keeps expiry changes CLI-only, and clears self logout Cookies last', async () => {
    const { app, auth, device, service } = fixture();
    const listed = await auth(request(app).get('/api/auth/devices')).expect(200); expect(listed.headers['set-cookie']?.[0]).toContain(`${sessionCookieName(origin)}=`);
    const rename = await auth(request(app).patch(`/api/auth/devices/${device.id}`)).send({ version: device.version, name: 'Renamed' }).expect(200);
    expect(rename.body.device.expires_at).toBe(device.expires_at); expect(rename.body.device.version).toBe(device.version + 1);
    await auth(request(app).patch(`/api/auth/devices/${device.id}`)).send({ version: rename.body.device.version, expire: '7d' }).expect(403);
    const extend = service.edit(device.id, { expire: '7d' });
    expect(extend.expires_at).toBeGreaterThan(device.expires_at! + 6 * 86400_000);
    await auth(request(app).delete(`/api/auth/devices/${device.id}`)).expect(200).then(res => expect(res.headers['set-cookie']?.at(-1)).toContain('Max-Age=0'));
    expect(service.isDeviceActive(device.id)).toBe(false);
  });
  it('claim retries/resume are Session scoped, CLI/Web compete, browser cancel wins before commit, retries never duplicate', () => {
    const { service, actor } = fixture(); const p = service.createPairing(null, origin, 'Phone');
    const c = service.claimWeb(p.pairing.code, actor); expect(c.source).toBe('web');
    expect(service.claimWeb(p.pairing.code, actor)).toEqual(c); expect(service.approvals(actor)[0]).toEqual(c);
    expect(() => service.claim(p.pairing.code, 'cli')).toThrow(/already used/);
    const foreign = { ...actor, sessionId: 'another' }; expect(() => service.approval(foreign, c.id)).toThrow(/no longer authorized/);
    const authorized = service.authorizeWeb(actor, c.id, { name: 'Phone', expire: '7d' });
    expect(service.authorizeWeb(actor, c.id, { name: 'Changed', expire: 'never' })).toEqual(authorized);
    const p2 = service.createPairing(null, origin, 'Laptop'); const c2 = service.claimWeb(p2.pairing.code, actor);
    service.cancelPairing(p2.secret!, origin, c2.id);
    expect(() => service.authorizeWeb(actor, c2.id, { name: 'Laptop', expire: '7d' })).toThrow(/canceled/);
  });
  it('a real schema2 database upgrades without changing old device identity, expiry or session hashes', async () => {
    const home = tmpHome('hm-device-v2-upgrade-'); let runtime = await createProjectTaskRuntime({ home });
    let service = new DeviceAuthService({ db: runtime.requireDatabase(), mode: 'trusted-device' });
    const p = service.createPairing(null, origin, 'Safari'); const c = service.claim(p.pairing.code, 'cli'); const oldDevice = service.authorize(c.id, 'cli', { name: 'First phase phone', expire: '30d' });
    const oldSession = runtime.requireDatabase().prepare('SELECT * FROM auth_sessions').get(); service.close(); await runtime.close();
    const v2 = new DatabaseSync(path.join(home, '.handmux', 'handmux.sqlite'));
    v2.exec('ALTER TABLE auth_devices DROP COLUMN version; PRAGMA user_version = 2'); v2.close();
    runtime = await createProjectTaskRuntime({ home });
    service = new DeviceAuthService({ db: runtime.requireDatabase(), mode: 'trusted-device' });
    expect(runtime.status().schemaVersion).toBe(3);
    expect(service.list()[0]).toEqual(oldDevice); expect(runtime.requireDatabase().prepare('SELECT * FROM auth_sessions').get()).toEqual(oldSession);
    expect(service.authenticateSecret(p.secret!, origin)?.deviceId).toBe(oldDevice.id);
    service.close(); await runtime.close();
  });
});
