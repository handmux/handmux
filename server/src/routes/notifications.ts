// Read/delete for the manual-push inbox. Recording happens in routes/push.js (send-local). This
// module is single-purpose: list history (newest first) and delete one entry by id.
import express from 'express';
import type { Request, Response, Router } from 'express';
import type { StoredNotification } from '../notifications.js';

interface NotificationStore {
  list(pushKey: string): StoredNotification[];
  remove(pushKey: string, id: string): boolean;
}

interface NotificationRouteOptions {
  notifications: NotificationStore;
}

export function notificationRoutes({ notifications }: NotificationRouteOptions): Router {
  const r = express.Router();

  r.get('/notifications', (req: Request, res: Response) => {
    const device = req.query.device;
    res.json({ items: typeof device === 'string' && device ? notifications.list(device) : [] });
  });

  r.delete('/notifications/:id', (req: Request, res: Response) => {
    const device = req.query.device;
    const id = req.params.id;
    res.json({ ok: typeof device === 'string' && device && id ? notifications.remove(device, id) : false });
  });

  return r;
}
