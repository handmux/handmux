import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateProjectDatabase } from '../src/projectTask/migrations.js';
import { DeviceAuthService, sessionCookieName } from '../src/deviceAuth/service.js';
import { createDeviceAuthRouter } from '../src/deviceAuth/http.js';
import { createAuthOriginResolver, createDeviceAccess } from '../src/deviceAccess.js';
import { createTerminalStream } from '../src/terminalStream.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const db = new DatabaseSync(':memory:');
  migrateProjectDatabase(db);
  let now = Date.now();
  const service = new DeviceAuthService({ db, token: 'secret', now: () => now });
  const app = express();
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  const origin = `http://127.0.0.1:${address.port}`;
  const resolveOrigin = createAuthOriginResolver({ port: address.port, host: '127.0.0.1', trustedOrigins: () => service.trustedOrigins });
  const access = createDeviceAccess({ service, resolveOrigin });
  app.use('/api/auth', express.json(), createDeviceAuthRouter({ service, resolveOrigin }));
  app.use('/api', access.middleware);
  app.get('/api/private', (_req, res) => res.json({ deviceId: res.locals.deviceAuth.deviceId }));
  const stream = createTerminalStream({ token: 'old-token', commands: { paneSession: async () => 'test' }, deviceAuth: { service, resolveOrigin } });
  server.on('upgrade', stream.onUpgrade);
  cleanup.push(async () => {
    stream.close(); access.close(); service.close(); db.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  const headers = { Origin: origin, Authorization: 'Bearer secret', 'X-Handmux-Request': '1' };
  const begin = async () => {
    const result = await request(server).post('/api/auth/pairing').set(headers).send({}).expect(200);
    return { code: result.body.pairing.code as string, id: result.body.pairing.id as string,
      cookie: String(result.headers['set-cookie']?.[0]).split(';')[0]! };
  };
  const promote = async (candidate: string) => {
    const result = await request(server).get('/api/auth/status').set(headers).set('Cookie', candidate).expect(200);
    expect(result.body.authenticated).toBe(true);
    return (result.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith(`${sessionCookieName(origin)}=`))!.split(';')[0]!;
  };
  const enroll = async (name: string, expire = '1h') => {
    const pending = await begin();
    const claim = service.claim(pending.code, 'test-cli');
    const device = service.authorize(claim.id, 'test-cli', { name, expire });
    return { device, cookie: await promote(pending.cookie) };
  };
  return { server, service, headers, origin, begin, promote, enroll, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('Web device management across real HTTP and WebSocket boundaries', () => {
  it('authorizes only the requesting browser, then Web revocation closes its terminal and API access', async () => {
    const f = await fixture();
    const approver = await f.enroll('approver');
    const candidate = await f.begin();
    const claimed = await request(f.server).post('/api/auth/approvals').set(f.headers).set('Cookie', approver.cookie)
      .send({ code: candidate.code }).expect(200);
    const claimId = claimed.body.approval.id as string;
    const progress = await request(f.server).get('/api/auth/pairing').set(f.headers).set('Cookie', candidate.cookie).expect(200);
    expect(progress.body.pairing).toMatchObject({ state: 'configuring', source: 'web' });
    await request(f.server).get('/api/private').set(f.headers).set('Cookie', candidate.cookie).expect(401);
    const authorized = await request(f.server).post(`/api/auth/approvals/${claimId}/authorize`).set(f.headers)
      .set('Cookie', approver.cookie).send({ name: 'new browser', expire: '7d' }).expect(200);
    const deviceId = authorized.body.device.id as string;
    expect(JSON.stringify({ headers: authorized.headers, body: authorized.body })).not.toContain(candidate.cookie.split('=')[1]);
    // A candidate name is not itself a management credential, even after the DB commit.
    await request(f.server).get('/api/auth/devices').set(f.headers).set('Cookie', candidate.cookie).expect(401);
    const cookie = await f.promote(candidate.cookie);
    await request(f.server).get('/api/private').set(f.headers).set('Cookie', cookie).expect(200, { deviceId });
    const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/api/terminal-stream`, { headers: { Origin: f.origin, Cookie: cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>(resolve => ws.once('close', resolve));
    await request(f.server).delete(`/api/auth/devices/${deviceId}`).set(f.headers).set('Cookie', approver.cookie).expect(200);
    expect(await closed).toBe(4001);
    await request(f.server).get('/api/private').set(f.headers).set('Cookie', cookie).expect(401);
    await request(f.server).get('/api/private').set(f.headers).set('Cookie', approver.cookie).expect(200);
  });

  it('allows Web name edits but keeps expiry changes CLI-only', async () => {
    const f = await fixture();
    const actor = await f.enroll('actor');
    const target = await f.enroll('target');
    const list = await request(f.server).get('/api/auth/devices').set(f.headers).set('Cookie', actor.cookie).expect(200);
    const snapshot = list.body.devices.find((device: { id: string }) => device.id === target.device.id);
    await request(f.server).patch(`/api/auth/devices/${target.device.id}`).set(f.headers).set('Cookie', actor.cookie)
      .send({ version: snapshot.version, name: 'Web name' }).expect(200);
    const updated = f.service.edit(target.device.id, { name: 'CLI name', expire: '7d' });
    await request(f.server).patch(`/api/auth/devices/${target.device.id}`).set(f.headers).set('Cookie', actor.cookie)
      .send({ version: snapshot.version + 1, name: 'stale Web name', expire: 'never' }).expect(403);
    const actual = f.service.list().find(device => device.id === target.device.id)!;
    expect(actual.name).toBe('CLI name');
    expect(actual.expires_at).toBe(updated.expires_at);
  });

  it('lets an unlisted host request pairing with Token, then records it only after approval', async () => {
    const f = await fixture();
    const approver = await f.enroll('approver');
    const extraOrigin = 'https://phone.example.com';
    const candidate = await request(f.server).post('/api/auth/pairing')
      .set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret', 'X-Handmux-Request': '1' }).send({}).expect(200);
    expect(f.service.trustedOrigins).toEqual([f.origin]);
    const approval = await request(f.server).post('/api/auth/approvals').set(f.headers).set('Cookie', approver.cookie)
      .send({ code: candidate.body.pairing.code }).expect(200);
    await request(f.server).post(`/api/auth/approvals/${approval.body.approval.id}/authorize`).set(f.headers)
      .set('Cookie', approver.cookie).send({ name: 'phone', expire: '7d' }).expect(200);
    expect(f.service.trustedOrigins).toEqual([f.origin, extraOrigin]);
    const candidateCookie = String(candidate.headers['set-cookie']?.[0]).split(';')[0]!;
    const status = await request(f.server).get('/api/auth/status').set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret', 'X-Handmux-Request': '1' }).set('Cookie', candidateCookie).expect(200);
    expect(status.body.authenticated).toBe(true);
    const primary = String((status.headers['set-cookie'] as unknown as string[] | undefined)?.find(value => value.startsWith('__Host-handmux_session='))).split(';')[0]!;
    await request(f.server).get('/api/private').set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', 'X-Handmux-Request': '1' }).set('Cookie', primary).set('Authorization', 'Bearer secret').expect(200);
  });

  it('does not treat an existing session as authenticated after its origin is removed', async () => {
    const f = await fixture();
    const extraOrigin = 'https://phone.example.com';
    const candidate = await request(f.server).post('/api/auth/pairing')
      .set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret' }).send({}).expect(200);
    const pendingCookie = String(candidate.headers['set-cookie']?.[0]).split(';')[0]!;
    const claim = f.service.claim(candidate.body.pairing.code, 'test-cli');
    const device = f.service.authorize(claim.id, 'test-cli', { name: 'removed origin', expire: '1h' });
    const before = await request(f.server).get('/api/auth/status')
      .set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret' })
      .set('Cookie', pendingCookie).expect(200);
    expect(before.body).toMatchObject({ authenticated: true, originTrusted: true, currentDeviceId: device.id });
    const primaryCookie = (before.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('__Host-handmux_session='))!.split(';')[0]!;

    f.service.removeTrustedOrigin(extraOrigin);
    const after = await request(f.server).get('/api/auth/status')
      .set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret' })
      .set('Cookie', primaryCookie).expect(200);
    expect(after.body).toMatchObject({ authenticated: false, originTrusted: false, tokenAuthenticated: true });
    expect(after.body.currentDeviceId).toBeNull();

    const withLeftoverPairingCookie = await request(f.server).get('/api/auth/status')
      .set({ Host: 'phone.example.com', Origin: extraOrigin, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer secret' })
      .set('Cookie', `${primaryCookie}; ${pendingCookie}`).expect(200);
    expect(withLeftoverPairingCookie.body).toMatchObject({ authenticated: false, originTrusted: false, tokenAuthenticated: true });
    expect(withLeftoverPairingCookie.body.currentDeviceId).toBeNull();
    expect(withLeftoverPairingCookie.body.pairing).toBeUndefined();
    expect((withLeftoverPairingCookie.headers['set-cookie'] as unknown as string[] | undefined ?? []).some(value => value.startsWith(`${pendingCookie.split('=')[0]}=`))).toBe(true);

    f.service.revoke(device.id);
  });

  it('preserves the full setup window after a late claim but rejects an expired approver', async () => {
    const f = await fixture();
    const actor = await f.enroll('short-lived approver', '1m');
    const candidate = await f.begin();
    f.advance(59_000);
    const claim = await request(f.server).post('/api/auth/approvals').set(f.headers).set('Cookie', actor.cookie)
      .send({ code: candidate.code }).expect(200);
    const progress = await request(f.server).get('/api/auth/pairing').set(f.headers).set('Cookie', candidate.cookie).expect(200);
    expect(progress.body.pairing.expiresAt).toBe(claim.body.approval.expiresAt);
    expect(progress.body.pairing.expiresAt - f.now()).toBe(300_000);
    expect(() => f.service.claim(candidate.code, 'other-cli')).toThrow();
    f.advance(2_000);
    await request(f.server).post(`/api/auth/approvals/${claim.body.approval.id}/authorize`).set(f.headers)
      .set('Cookie', actor.cookie).send({ name: 'must not authorize', expire: 'never' }).expect(401);
    const result = await request(f.server).get('/api/auth/status').set(f.headers).set('Cookie', candidate.cookie).expect(200);
    expect(result.body.authenticated).toBe(false);
    expect(result.body.pairing.state).toBe('canceled');
  });

  it('self-removal confirms logout, cancels pending approvals and cannot recover through a leftover candidate', async () => {
    const f = await fixture();
    const actor = await f.enroll('current device');
    const leftover = await f.begin();
    const cliClaim = f.service.claim(leftover.code, 'test-cli');
    const extra = f.service.authorize(cliClaim.id, 'test-cli', { name: 'concurrent candidate', expire: '1h' });
    const pending = await f.begin();
    await request(f.server).post('/api/auth/approvals').set(f.headers).set('Cookie', actor.cookie)
      .send({ code: pending.code }).expect(200);
    const result = await request(f.server).delete(`/api/auth/devices/${actor.device.id}`).set(f.headers)
      .set('Cookie', `${actor.cookie}; ${leftover.cookie}`).expect(200);
    expect(result.body).toMatchObject({ ok: true, authenticated: false });
    const cleared = result.headers['set-cookie'] as unknown as string[];
    expect(cleared.some(value => value.startsWith(`${sessionCookieName(f.origin)}=;`))).toBe(true);
    expect(f.service.isDeviceActive(actor.device.id)).toBe(false);
    expect(f.service.isDeviceActive(extra.id)).toBe(false);
    const status = await request(f.server).get('/api/auth/status').set(f.headers).set('Cookie', leftover.cookie).expect(200);
    expect(status.body.authenticated).toBe(false);
    const progress = await request(f.server).get('/api/auth/status').set(f.headers).set('Cookie', pending.cookie).expect(200);
    expect(progress.body.pairing.state).toBe('canceled');
  });
});
