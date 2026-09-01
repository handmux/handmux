import type { SubscriptionUsageService } from './subscriptionUsage.js';

export interface DeprecatedSubscriptionUsageLegacyProjector {
  legacySnapshot(): Record<string, unknown> | null;
}

// Explicit migration exception for the historical /api/usage wire. Core remains provider-neutral: this
// facade first goes through the one Core cache/read, then asks each owning Adapter for the sidecar captured
// during that same read. Sidecars never enter capability snapshots, health, discovery, or the new Web API.
export class DeprecatedSubscriptionUsageFacade {
  readonly #usage: SubscriptionUsageService;
  readonly #projectors: Readonly<Record<string, DeprecatedSubscriptionUsageLegacyProjector>>;

  constructor({
    usage,
    projectors,
  }: {
    usage: SubscriptionUsageService;
    projectors: Readonly<Record<string, DeprecatedSubscriptionUsageLegacyProjector>>;
  }) {
    this.#usage = usage;
    this.#projectors = projectors;
  }

  async snapshot(): Promise<{ claude: Record<string, unknown> | null; codex: Record<string, unknown> | null }> {
    await this.#usage.snapshots();
    return {
      claude: this.#projectors.claude?.legacySnapshot() ?? null,
      codex: this.#projectors.codex?.legacySnapshot() ?? null,
    };
  }
}
