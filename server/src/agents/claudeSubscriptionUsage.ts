import { homedir } from 'node:os';
import { claudeUsagePath } from '../usagePaths.js';
import { PrivateStateStore } from '../privateStateStore.js';
import type {
  AgentSubscriptionUsageAdapterSnapshot,
  AgentSubscriptionUsageAdapterV1,
  AgentSubscriptionUsageGroup,
  AgentSubscriptionUsageWindow,
} from '../agent-runtime/subscriptionUsage.js';
import type { DeprecatedSubscriptionUsageLegacyProjector } from '../agent-runtime/subscriptionUsageLegacy.js';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function readClaudeSubscriptionUsage(home: string = homedir()): Record<string, unknown> | null {
  try {
    const snapshot = new PrivateStateStore<unknown>(claudeUsagePath(home)).read();
    return isRecord(snapshot) ? snapshot : null;
  } catch { return null; }
}

function windowOf(
  value: unknown,
  id: string,
  windowMinutes: number,
): AgentSubscriptionUsageWindow | null {
  if (!isRecord(value) || !finite(value.usedPercent)) return null;
  return {
    id,
    usedPercent: value.usedPercent,
    windowMinutes,
    ...(finite(value.resetsAt) ? { resetsAt: value.resetsAt } : {}),
  };
}

export function createClaudeSubscriptionUsageAdapter({
  home = homedir(),
}: { home?: string } = {}): AgentSubscriptionUsageAdapterV1 & DeprecatedSubscriptionUsageLegacyProjector {
  let legacy: Record<string, unknown> | null = null;
  return {
    apiVersion: 1,
    async snapshot(): Promise<AgentSubscriptionUsageAdapterSnapshot> {
      const source = readClaudeSubscriptionUsage(home);
      legacy = source ? structuredClone(source) : null;
      if (!source) {
        return {
          groups: [], updatedAt: null, status: 'setup_required', setupCommand: 'handmux agent enable claude',
        };
      }
      const limits = isRecord(source.rateLimits) ? source.rateLimits : {};
      const accountWindows = [
        windowOf(limits.fiveHour, 'five-hour', 300),
        windowOf(limits.sevenDay, 'weekly', 10_080),
      ].filter((window): window is AgentSubscriptionUsageWindow => window !== null);
      const groups: AgentSubscriptionUsageGroup[] = accountWindows.length ? [{
        kind: 'account', id: 'account', windows: accountWindows,
      }] : [];
      for (const [id, label, value] of [
        ['opus', 'Opus', limits.sevenDayOpus],
        ['sonnet', 'Sonnet', limits.sevenDaySonnet],
      ] as const) {
        const window = windowOf(value, 'weekly', 10_080);
        if (window) groups.push({ kind: 'model', id, label, windows: [window] });
      }
      return {
        groups,
        updatedAt: finite(source.updatedAt) ? source.updatedAt : null,
        status: groups.length ? 'ready' : 'pending',
      };
    },
    legacySnapshot: () => legacy ? structuredClone(legacy) : null,
  };
}
