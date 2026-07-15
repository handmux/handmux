import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deliveredData = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, data) => { deliveredData.push(data); return { statusCode: 201 }; }),
  },
}));

process.env.VAPID_PUBLIC = 'pub';
process.env.VAPID_PRIVATE = 'priv';

let app;
beforeEach(async () => {
  deliveredData.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-routes-'));
  process.env.PUSH_STORE = path.join(dir, 'push.json');
  process.env.NOTIF_STORE = path.join(dir, 'notifications.json');
  vi.resetModules();
  const push = await import('../src/push.js');
  await import('../src/notifications.js');
  const { createApiRouter } = await import('../src/httpApi.js');
  push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
  app = express();
  app.use('/api', createApiRouter({ token: 'good' }));
});

const auth = (r) => r.set('Authorization', 'Bearer good');

describe('notification inbox routes', () => {
  it('records the manual push (with url) and deep-links the delivered payload to its detail', async () => {
    await auth(request(app).post('/api/push/send-local').send({ title: 'first', body: '1', url: '/x' })).expect(200);
    const items = (await auth(request(app).get('/api/notifications')).expect(200)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('/x');
    // the delivered web-push payload carries data.inboxId === the stored record id
    const payload = JSON.parse(deliveredData[0]);
    expect(payload.data.inboxId).toBe(items[0].id);
  });

  it('a manual send-local push is recorded and listed newest-first', async () => {
    await auth(request(app).post('/api/push/send-local').send({ title: 'first', body: '1' })).expect(200);
    await auth(request(app).post('/api/push/send-local').send({ title: 'second', body: '2', tag: 'build' })).expect(200);
    const r = await auth(request(app).get('/api/notifications')).expect(200);
    expect(r.body.items.map((n) => n.title)).toEqual(['second', 'first']);
    expect(r.body.items[0].tag).toBe('build');
  });

  it('DELETE /notifications/:id removes one', async () => {
    await auth(request(app).post('/api/push/send-local').send({ title: 'a', body: '1' })).expect(200);
    const list = (await auth(request(app).get('/api/notifications')).expect(200)).body.items;
    const id = list[0].id;
    const d = await auth(request(app).delete(`/api/notifications/${id}`)).expect(200);
    expect(d.body.ok).toBe(true);
    expect((await auth(request(app).get('/api/notifications')).expect(200)).body.items).toHaveLength(0);
  });

  it('GET /notifications requires the token', async () => {
    await request(app).get('/api/notifications').expect(401);
  });
});
