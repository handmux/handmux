import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deliveredData = [];
const failedEndpoints = new Map();
const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, data) => {
      deliveredData.push(data);
      if (failedEndpoints.has(sub.endpoint)) {
        const error = new Error('push rejected');
        error.statusCode = failedEndpoints.get(sub.endpoint);
        throw error;
      }
      return { statusCode: 201 };
    }),
  },
}));

process.env.VAPID_PUBLIC = 'pub';
process.env.VAPID_PRIVATE = 'priv';

let app;
beforeEach(async () => {
  deliveredData.length = 0;
  failedEndpoints.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-routes-'));
  process.env.PUSH_STORE = path.join(dir, 'push.json');
  process.env.NOTIF_DIR = path.join(dir, 'notifications');
  vi.resetModules();
  const push = await import('../src/push.js');
  await import('../src/notifications.js');
  const { createApiRouter } = await import('../src/httpApi.js');
  push.addSubscription(subscription('A'), ['proj-a']);
  app = express();
  app.use('/api', createApiRouter({ token: 'good' }));
});

const auth = (r) => r.set('Authorization', 'Bearer good');

describe('notification inbox routes', () => {
  it('a send-local push lands only in the targeted device inbox; others stay empty', async () => {
    // device A bound to proj-a; add device B bound to proj-b
    const push = await import('../src/push.js');
    push.addSubscription(subscription('B'), ['proj-b']);
    const keyA = push.getPushKey('A');
    const keyB = push.getPushKey('B');
    // scope: session proj-a → only device A
    await auth(request(app).post('/api/push/send-local').send({ title: 'x', body: '1', sessions: ['proj-a'] })).expect(200);
    const aItems = (await auth(request(app).get(`/api/notifications?device=${keyA}`)).expect(200)).body.items;
    const bItems = (await auth(request(app).get(`/api/notifications?device=${keyB}`)).expect(200)).body.items;
    expect(aItems.map((n) => n.title)).toEqual(['x']);
    expect(aItems[0].delivery).toEqual({ status: 'success' });
    expect(bItems).toEqual([]);
    // the delivered payload deep-links to that record
    const payload = JSON.parse(deliveredData[deliveredData.length - 1]);
    expect(payload.data.inboxId).toBe(aItems[0].id);
  });

  it('stores an independent success/failure result in each targeted device inbox', async () => {
    const push = await import('../src/push.js');
    push.addSubscription(subscription('B'), []);
    const keyA = push.getPushKey('A');
    const keyB = push.getPushKey('B');
    failedEndpoints.set('B', 503);
    await auth(request(app).post('/api/push/send-local').send({ title: 'x', body: '1' })).expect(200);
    const a = (await auth(request(app).get(`/api/notifications?device=${keyA}`)).expect(200)).body.items[0];
    const b = (await auth(request(app).get(`/api/notifications?device=${keyB}`)).expect(200)).body.items[0];
    expect(a.delivery).toEqual({ status: 'success' });
    expect(b.delivery).toEqual({ status: 'failed', reason: 'service_unavailable' });
  });

  it('no device param → empty list / delete false', async () => {
    expect((await auth(request(app).get('/api/notifications')).expect(200)).body.items).toEqual([]);
    expect((await auth(request(app).delete('/api/notifications/whatever')).expect(200)).body.ok).toBe(false);
  });

  it('DELETE removes from that device only', async () => {
    const push = await import('../src/push.js');
    const keyA = push.getPushKey('A');
    await auth(request(app).post('/api/push/send-local').send({ title: 'y', body: '1' })).expect(200); // all devices
    const id = (await auth(request(app).get(`/api/notifications?device=${keyA}`)).expect(200)).body.items[0].id;
    expect((await auth(request(app).delete(`/api/notifications/${id}?device=${keyA}`)).expect(200)).body.ok).toBe(true);
    expect((await auth(request(app).get(`/api/notifications?device=${keyA}`)).expect(200)).body.items).toEqual([]);
  });

  it('GET /notifications requires the token', async () => {
    await request(app).get('/api/notifications').expect(401);
  });
});
