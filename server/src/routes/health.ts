import express from 'express';
import type { RuntimeHealth } from '../healthProtocol.js';

export function healthRoutes({
  health,
  refresh = () => {},
}: {
  health: RuntimeHealth;
  refresh?: () => void | Promise<void>;
}): express.Router {
  const router = express.Router();
  router.get('/health/live', (_req, res) => res.json(health.live()));
  router.get('/health/ready', async (_req, res, next) => {
    try {
      await refresh();
      const snapshot = health.snapshot();
      return res.status(snapshot.ready ? 200 : 503).json(snapshot);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
