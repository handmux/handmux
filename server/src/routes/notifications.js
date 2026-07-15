// Read/delete for the manual-push inbox. Recording happens in routes/push.js (send-local). This
// module is single-purpose: list history (newest first) and delete one entry by id.
import express from 'express';

export function notificationRoutes({ notifications }) {
  const r = express.Router();

  r.get('/notifications', (req, res) => {
    res.json({ items: notifications.list() });
  });

  r.delete('/notifications/:id', (req, res) => {
    res.json({ ok: notifications.remove(req.params.id) });
  });

  return r;
}
