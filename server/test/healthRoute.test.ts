import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeHealth } from '../src/healthProtocol.js';
import { healthRoutes } from '../src/routes/health.js';

describe('health routes', () => {
  it('keeps liveness available while readiness exposes subsystem startup and recovery', async () => {
    const health = new RuntimeHealth({ now: () => 123 });
    const refresh = vi.fn();
    const app = express();
    app.use(healthRoutes({ health, refresh }));

    await request(app).get('/health/live').expect(200, {
      status: 'live', live: true, checkedAt: 123,
    });
    const starting = await request(app).get('/health/ready').expect(503);
    expect(starting.body).toMatchObject({
      status: 'starting', ready: false,
      subsystems: { workspace: { status: 'starting' }, codex: { status: 'starting' } },
    });

    health.set('workspace', 'ready', 'workspace-unprotected');
    health.set('codex', 'ready');
    const ready = await request(app).get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({
      status: 'ready', ready: true,
      subsystems: { workspace: { detail: 'workspace-unprotected' } },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
