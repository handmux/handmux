import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const sent = [];
const dataSeen = [];
const failureStatuses = new Map();
const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, data) => {
      dataSeen.push(data);
      if (failureStatuses.has(sub.endpoint)) {
        const e = new Error('rejected');
        e.statusCode = failureStatuses.get(sub.endpoint);
        throw e;
      }
      sent.push(sub.endpoint);
      return { statusCode: 201 };
    }),
  },
}));

process.env.VAPID_PUBLIC = 'pub';
process.env.VAPID_PRIVATE = 'priv';
process.env.PUSH_STORE = '/tmp/tmw-push-sendlocal-test.json';
process.env.NOTIF_DIR = '/tmp/tmw-notif-sendlocal-test-dir';
import fs from 'node:fs';

let app, push, keyA;
beforeEach(async () => {
  sent.length = 0; dataSeen.length = 0;
  failureStatuses.clear();
  try { fs.unlinkSync('/tmp/tmw-push-sendlocal-test.json'); } catch {}
  vi.resetModules();
  push = await import('../src/push.js');
  const { createApiRouter } = await import('../src/httpApi.js');
  push.addSubscription(subscription('A'), ['proj-a']);
  push.addSubscription(subscription('B'), ['proj-b']);
  keyA = push.getPushKey('A');
  app = express();
  app.use('/api', createApiRouter({ token: 'good' }));
});

const post = (body) => request(app).post('/api/push/send-local').set('Authorization', 'Bearer good').send(body);

describe('POST /api/push/send-local', () => {
  it('401s without the server token', async () => {
    await request(app).post('/api/push/send-local').send({ title: 't', body: 'b' }).expect(401);
  });
  it('400s with a field-specific message when title or body is missing', async () => {
    expect((await post({ body: 'b' }).expect(400)).body.error).toMatch(/title/);
    expect((await post({ title: 't' }).expect(400)).body.error).toMatch(/body/);
  });
  it('400s when sessions and devices are both given (mutex)', async () => {
    await post({ title: 't', body: 'b', sessions: ['proj-a'], devices: [keyA] }).expect(400);
  });
  it('400s a notification link with a non-web protocol', async () => {
    const r = await post({ title: 't', body: 'b', url: 'javascript:alert(1)' }).expect(400);
    expect(r.body.error).toMatch(/url/i);
  });
  it('no scope → all devices', async () => {
    const r = await post({ title: 't', body: 'b' }).expect(200);
    expect(r.body.sent).toBe(2);
  });
  it('sessions → only bound devices', async () => {
    const r = await post({ title: 't', body: 'b', sessions: ['proj-a'] }).expect(200);
    expect(r.body.sent).toBe(1);
    expect(sent).toEqual(['A']);
  });
  it('devices → only matching keys', async () => {
    const r = await post({ title: 't', body: 'b', devices: [keyA] }).expect(200);
    expect(r.body.sent).toBe(1);
    expect(sent).toEqual(['A']);
  });
  it('tag and url land in the payload', async () => {
    await post({ title: 't', body: 'b', tag: 'build', url: '/x' }).expect(200);
    const payload = JSON.parse(dataSeen[0]);
    expect(payload.tag).toBe('build');
    expect(payload.data.inboxId).toBeTruthy();
  });
});

describe('key retrieval', () => {
  it('/push/subscribe rejects a subscription without encryption keys', async () => {
    await request(app).post('/api/push/subscribe').set('Authorization', 'Bearer good')
      .send({ subscription: { endpoint: 'C', keys: {} }, boundSessions: [] }).expect(400);
  });

  it('/api/push/key returns the endpoint pushKey; /push/subscribe returns one too', async () => {
    const r1 = await request(app).post('/api/push/key').set('Authorization', 'Bearer good').send({ endpoint: 'A' }).expect(200);
    expect(r1.body.pushKey).toBe(keyA);
    const r2 = await request(app).post('/api/push/subscribe').set('Authorization', 'Bearer good')
      .send({ subscription: subscription('C'), boundSessions: [] }).expect(200);
    expect(typeof r2.body.pushKey).toBe('string');
  });

  it('/push/subscribe reuses a requested device key and /unsubscribe returns it', async () => {
    const stableKey = 'stable_device_key_123456';
    const subscribed = await request(app).post('/api/push/subscribe').set('Authorization', 'Bearer good')
      .send({ subscription: subscription('C'), boundSessions: [], pushKey: stableKey }).expect(200);
    expect(subscribed.body.pushKey).toBe(stableKey);

    const removed = await request(app).post('/api/push/unsubscribe').set('Authorization', 'Bearer good')
      .send({ endpoint: 'C' }).expect(200);
    expect(removed.body).toEqual({ ok: true, pushKey: stableKey });
  });

  it('/push/subscribe rejects and prunes an expired welcome subscription', async () => {
    failureStatuses.set('C', 410);
    const r = await request(app).post('/api/push/subscribe').set('Authorization', 'Bearer good')
      .send({ subscription: subscription('C'), boundSessions: [] }).expect(410);
    expect(r.body.error).toMatch(/expired/);
    expect(push.count()).toBe(2);
  });

  it('/push/subscribe does not claim success for a non-expiry delivery rejection', async () => {
    failureStatuses.set('C', 503);
    const r = await request(app).post('/api/push/subscribe').set('Authorization', 'Bearer good')
      .send({ subscription: subscription('C'), boundSessions: [] }).expect(502);
    expect(r.body.error).toMatch(/rejected/);
    expect(push.count()).toBe(3);
  });
});
