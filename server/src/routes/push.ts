// Web Push routes: hand the client the VAPID key, store/update/remove a browser PushSubscription, and
// the local script-push send entry. The push module owns the delivery contract (TTL/topic/prune).
import express from 'express';
import { sanitizeNotificationUrl } from '../urlPolicy.js';
import { parsePushSubscription } from '../push.js';
import type { NextFunction, Request, Response, Router } from 'express';
import type { PushOptions, PushPayload } from '../push.js';
import type { NotificationInput, StoredNotification } from '../notifications.js';

type PushService = typeof import('../push.js');
interface NotificationService {
  record(pushKeys: readonly unknown[] | null | undefined, input?: NotificationInput): StoredNotification;
  updateDelivery(pushKey: unknown, id: unknown, delivery: unknown): boolean;
}
interface PushRouteOptions {
  push: PushService;
  notifications?: NotificationService | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function pushRoutes({ push, notifications }: PushRouteOptions): Router {
  const r = express.Router();

  // The client needs the VAPID public key to subscribe; 503 if the server has no keys configured.
  r.get('/push/vapid', (_req: Request, res: Response) => {
    if (!push.isConfigured()) return res.status(503).json({ error: 'push not configured' });
    return res.json({ key: push.publicKey() });
  });

  // Store a browser PushSubscription, then immediately fire a welcome push back to it — so enabling
  // the toggle proves the whole pipe (subscribe → push service → SW → notification) end to end.
  r.post('/push/subscribe', async (req: Request, res: Response, next: NextFunction) => {
    const body: unknown = req.body;
    const sub = parsePushSubscription(isRecord(body) ? body.subscription : undefined);
    const preferredPushKey = isRecord(body) ? body.pushKey : undefined;
    const boundSessions = strings(isRecord(body) ? body.boundSessions : undefined);
    if (!sub) return res.status(400).json({ error: 'bad subscription' });
    try {
      const pushKey = push.addSubscription(sub, boundSessions, preferredPushKey);
      if (!pushKey) return res.status(400).json({ error: 'bad subscription' });
      const delivery = await push.sendToOne(sub, { title: '通知已开启 ✅', body: '会话「需要你」或「已完成」时提醒你', tag: 'handmux-welcome' }, { topic: 'handmux', urgency: 'high' });
      // `deliver` deliberately contains failures so an automatic pane push can never break the polling
      // loop. Enabling notifications is different: its welcome push is the end-to-end health check, so a
      // rejected/dead subscription must not be reported to the phone as "enabled".
      if (delivery.sent !== 1) {
        const expired = delivery.gone > 0;
        return res.status(expired ? 410 : 502).json({
          error: expired ? 'push subscription expired' : 'push delivery rejected',
        });
      }
      return res.json({ ok: true, count: push.count(), pushKey });
    } catch (e) { return next(e); }
  });

  r.post('/push/unsubscribe', (req: Request, res: Response) => {
    const body: unknown = req.body;
    const endpoint = isRecord(body) ? body.endpoint : undefined;
    const pushKey = typeof endpoint === 'string' ? push.removeSubscription(endpoint) : null;
    return res.json({ ok: true, pushKey });
  });

  // Manual "send me a test" — pushes to every stored subscription.
  r.post('/push/test', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await push.sendToAll(
        { title: 'handmux 测试', body: '这是一条测试通知 — 点我回到 app', tag: 'handmux-test' },
        { topic: 'handmux', urgency: 'high' },
      );
      const { deliveries: _deliveries, ...summary } = out;
      return res.json(summary);
    } catch (e) { return next(e); }
  });

  // Client reports which sessions this device cares about; updates the stored subscription.
  r.post('/push/bound', (req: Request, res: Response) => {
    const requestBody: unknown = req.body;
    const endpoint = isRecord(requestBody) ? requestBody.endpoint : undefined;
    const boundSessions = strings(isRecord(requestBody) ? requestBody.boundSessions : undefined);
    if (typeof endpoint === 'string') push.updateBound(endpoint, boundSessions);
    return res.json({ ok: true });
  });

  // Local script push (`handmux push`): loopback + server token. Scope is mutually exclusive —
  // devices (by pushKey) > sessions > all. This is the ONLY push-send entry; no public/remote variant.
  r.post('/push/send-local', async (req: Request, res: Response, next: NextFunction) => {
    const requestBody: unknown = req.body;
    const data = isRecord(requestBody) ? requestBody : {};
    const { title, body, tag, url } = data;
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' });
    const safeUrl = url == null ? null : sanitizeNotificationUrl(url);
    if (url != null && !safeUrl) return res.status(400).json({ error: 'url must be http(s) or relative' });
    const sessions = strings(data.sessions);
    const devices = strings(data.devices);
    const hasSessions = sessions.length > 0;
    const hasDevices = devices.length > 0;
    if (hasSessions && hasDevices) return res.status(400).json({ error: 'use --session or --device, not both' });
    const payload: PushPayload = { title, body };
    if (typeof tag === 'string' && tag) payload.tag = tag;
    const opts: PushOptions = { urgency: 'normal', ttl: 1800 };
    if (typeof payload.tag === 'string') opts.topic = payload.tag;
    // Record FIRST so the notification tap can deep-link to this exact message's detail page. `--url`
    // is stored on the record (surfaced in the detail), NOT used as the tap target.
    let targetKeys: string[] = [];
    let rec: StoredNotification | null = null;
    if (notifications) {
      targetKeys = push.resolveTargetKeys({ devices: hasDevices ? devices : null, sessions: hasSessions ? sessions : null });
      rec = notifications.record(targetKeys, {
        title, body, tag: payload.tag, url: safeUrl, delivery: { status: 'pending' },
      });
      payload.data = { inboxId: rec.id };
    }
    try {
      const out = hasDevices ? await push.sendToDevices(devices, payload, opts)
        : hasSessions ? await push.sendToSessions(sessions, payload, opts)
        : await push.sendToAll(payload, opts);
      if (notifications && rec) {
        for (const delivery of out.deliveries || []) {
          if (!delivery.pushKey) continue;
          try { notifications.updateDelivery(delivery.pushKey, rec.id, delivery); }
          catch (error) {
            // Delivery already happened. Do not turn a status-metadata write failure into an HTTP error:
            // CLI automation would retry and send the real notification twice. The pending record remains
            // honest (unknown final state) and the server log retains the storage failure for diagnosis.
            console.warn(`[handmux] notification delivery status update failed: ${errorMessage(error)}`);
          }
        }
      }
      const { deliveries: _deliveries, ...summary } = out;
      return res.json(summary);
    } catch (e) { return next(e); }
  });

  // This device's addressing key (server-token auth) — the script push sheet reads it to show `--device`.
  r.post('/push/key', (req: Request, res: Response) => {
    const requestBody: unknown = req.body;
    const endpoint = isRecord(requestBody) ? requestBody.endpoint : undefined;
    if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
    return res.json({ pushKey: push.getPushKey(endpoint) });
  });

  return r;
}
