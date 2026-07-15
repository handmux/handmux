// Web Push routes: hand the client the VAPID key, store/update/remove a browser PushSubscription, and
// the local script-push send entry. The push module owns the delivery contract (TTL/topic/prune).
import express from 'express';

export function pushRoutes({ push, notifications }) {
  const r = express.Router();

  // The client needs the VAPID public key to subscribe; 503 if the server has no keys configured.
  r.get('/push/vapid', (req, res) => {
    if (!push.isConfigured()) return res.status(503).json({ error: 'push not configured' });
    res.json({ key: push.publicKey() });
  });

  // Store a browser PushSubscription, then immediately fire a welcome push back to it — so enabling
  // the toggle proves the whole pipe (subscribe → push service → SW → notification) end to end.
  r.post('/push/subscribe', async (req, res, next) => {
    const sub = req.body?.subscription;
    const boundSessions = Array.isArray(req.body?.boundSessions) ? req.body.boundSessions : [];
    if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ error: 'bad subscription' });
    try {
      push.addSubscription(sub, boundSessions);
      await push.sendToOne(sub, { title: '通知已开启 ✅', body: '会话「需要你」或「已完成」时提醒你', tag: 'handmux-welcome' }, { topic: 'handmux', urgency: 'high' });
      res.json({ ok: true, count: push.count(), pushKey: push.getPushKey(sub.endpoint) });
    } catch (e) { next(e); }
  });

  r.post('/push/unsubscribe', (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint === 'string') push.removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // Manual "send me a test" — pushes to every stored subscription.
  r.post('/push/test', async (req, res, next) => {
    try {
      const out = await push.sendToAll(
        { title: 'handmux 测试', body: '这是一条测试通知 — 点我回到 app', tag: 'handmux-test' },
        { topic: 'handmux', urgency: 'high' },
      );
      res.json(out);
    } catch (e) { next(e); }
  });

  // Client reports which sessions this device cares about; updates the stored subscription.
  r.post('/push/bound', (req, res) => {
    const endpoint = req.body?.endpoint;
    const boundSessions = Array.isArray(req.body?.boundSessions) ? req.body.boundSessions : [];
    if (typeof endpoint === 'string') push.updateBound(endpoint, boundSessions);
    res.json({ ok: true });
  });

  // Local script push (`handmux push`): loopback + server token. Scope is mutually exclusive —
  // devices (by pushKey) > sessions > all. This is the ONLY push-send entry; no public/remote variant.
  r.post('/push/send-local', async (req, res, next) => {
    const { sessions, devices, title, body, tag, url } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
    const hasSessions = Array.isArray(sessions) && sessions.length > 0;
    const hasDevices = Array.isArray(devices) && devices.length > 0;
    if (hasSessions && hasDevices) return res.status(400).json({ error: 'use --session or --device, not both' });
    const payload = { title, body };
    if (typeof tag === 'string' && tag) payload.tag = tag;
    if (typeof url === 'string' && url) payload.data = { url };
    const opts = { urgency: 'normal', ttl: 1800 };
    if (payload.tag) opts.topic = payload.tag;
    if (notifications) notifications.record({ title, body, tag: payload.tag });
    try {
      const out = hasDevices ? await push.sendToDevices(devices, payload, opts)
        : hasSessions ? await push.sendToSessions(sessions, payload, opts)
        : await push.sendToAll(payload, opts);
      res.json(out);
    } catch (e) { next(e); }
  });

  // This device's addressing key (server-token auth) — the script push sheet reads it to show `--device`.
  r.post('/push/key', (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
    res.json({ pushKey: push.getPushKey(endpoint) });
  });

  return r;
}
