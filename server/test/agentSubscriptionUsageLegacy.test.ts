import { describe, expect, it } from 'vitest';
import { DeprecatedSubscriptionUsageFacade } from '../src/agent-runtime/subscriptionUsageLegacy.js';

describe('legacy subscription Usage projection', () => {
  it('reads Core once before returning exact provider-owned sidecars', async () => {
    let ready = false;
    const snapshots = async () => { ready = true; return []; };
    const codex = { legacySnapshot: () => ready ? {
      updatedAt: 2_000,
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      rateLimits: { primary: { usedPercent: 12 }, secondary: null },
      modelRateLimits: [], rateLimitResetCredits: null,
      tokens: { total: 20 }, contextWindow: 100,
    } : null };
    const facade = new DeprecatedSubscriptionUsageFacade({
      usage: { snapshots } as never, projectors: { codex },
    });
    expect(await facade.snapshot()).toEqual({
      claude: null,
      codex: {
        updatedAt: 2_000,
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
        rateLimits: { primary: { usedPercent: 12 }, secondary: null },
        modelRateLimits: [], rateLimitResetCredits: null,
        tokens: { total: 20 }, contextWindow: 100,
      },
    });
  });
});
