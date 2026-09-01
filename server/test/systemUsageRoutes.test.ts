import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { systemRoutes } from '../src/routes/system.js';
import { DEFAULT_SHORTCUTS } from '../src/shortcutConfig.js';

function app(deprecatedSubscriptionUsage: { snapshot(): Promise<unknown> } | null) {
  const value = express();
  value.use(systemRoutes({
    commands: {} as never,
    claudeEvents: { getStates: async () => [] },
    agentRuntime: deprecatedSubscriptionUsage ? {
      deprecatedSubscriptionUsage, activeRuns: () => [], inbox: { read: () => ({ revision: 0 }) },
    } as never : null,
    asrEnv: {}, shortcuts: DEFAULT_SHORTCUTS,
    home: '/tmp/handmux-system-usage-test', stateFile: '/tmp/state',
  }));
  return value;
}

describe('legacy /api/usage compatibility route', () => {
  it('returns unsupported without the Runtime capability', async () => {
    await request(app(null)).get('/usage').expect(503, {
      error: 'subscription usage unsupported', code: 'unsupported',
    });
  });

  it('projects one Runtime snapshot call and never performs a second provider read', async () => {
    const snapshot = vi.fn(async () => ({
      claude: { updatedAt: 2_000, rateLimits: { fiveHour: { usedPercent: 20 } } }, codex: null,
    }));
    const response = await request(app({ snapshot })).get('/usage').expect(200);
    expect(response.body).toMatchObject({
      claude: { updatedAt: 2_000, rateLimits: { fiveHour: { usedPercent: 20 } } },
      codex: null,
    });
    expect(snapshot).toHaveBeenCalledOnce();
  });
});
