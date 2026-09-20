import { requestJson } from './apiRequest.js';

export type AgentIntegrationName = 'claude' | 'pi' | 'codebuddy' | 'codex';
export type AgentIntegrationStatus =
  | 'ready'
  | 'not-installed'
  | 'not-enabled'
  | 'needs-repair'
  | 'conflict';

export interface AgentIntegrationSnapshot {
  name: AgentIntegrationName;
  status: AgentIntegrationStatus;
  reason?: 'initialize-first';
}

export interface AgentIntegrationEnableResult extends AgentIntegrationSnapshot {
  changed: boolean;
}

const NAMES = new Set<AgentIntegrationName>(['claude', 'pi', 'codebuddy', 'codex']);
const STATUSES = new Set<AgentIntegrationStatus>([
  'ready', 'not-installed', 'not-enabled', 'needs-repair', 'conflict',
]);

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function snapshotOf(value: unknown): AgentIntegrationSnapshot | null {
  const item = recordOf(value);
  if (!item || typeof item.name !== 'string' || !NAMES.has(item.name as AgentIntegrationName)
    || typeof item.status !== 'string'
    || !STATUSES.has(item.status as AgentIntegrationStatus)) return null;
  return {
    name: item.name as AgentIntegrationName,
    status: item.status as AgentIntegrationStatus,
    ...(item.reason === 'initialize-first' ? { reason: item.reason } : {}),
  };
}

export function parseAgentIntegrations(value: unknown): AgentIntegrationSnapshot[] | null {
  const response = recordOf(value);
  if (!Array.isArray(response?.integrations)) return null;
  // A newer Server may add more Agents. Older Web clients keep managing their known rows instead of
  // rejecting the entire response, while malformed or duplicate known rows still fail closed.
  const known = response.integrations.filter((value) => {
    const item = recordOf(value);
    return typeof item?.name === 'string' && NAMES.has(item.name as AgentIntegrationName);
  });
  const items = known.map(snapshotOf);
  if (items.some((item) => item === null)) return null;
  const snapshots = items as AgentIntegrationSnapshot[];
  // Keep whichever known rows the Server reports, as long as they are well formed and unique. A fixed
  // count/set here is what made the whole panel unreadable the day the product grew a third Agent: the
  // Server answered perfectly well and the client rejected the response. Manage what is reported; a row
  // the Server does not send is simply not shown.
  if (snapshots.length === 0) return null;
  if (new Set(snapshots.map((item) => item.name)).size !== snapshots.length) return null;
  return snapshots;
}

function parseEnableResult(value: unknown): AgentIntegrationEnableResult | null {
  const result = recordOf(value);
  const snapshot = snapshotOf(result);
  if (!snapshot || typeof result?.changed !== 'boolean') return null;
  return { ...snapshot, changed: result.changed };
}

export async function readAgentIntegrations(): Promise<AgentIntegrationSnapshot[]> {
  const parsed = parseAgentIntegrations(await requestJson('/api/agent-integrations', { timeoutMs: 8_000 }));
  if (!parsed) throw new Error('Invalid Agent integration response');
  return parsed;
}

export async function enableAgentIntegration(
  name: AgentIntegrationName,
): Promise<AgentIntegrationEnableResult> {
  const parsed = parseEnableResult(await requestJson(
    `/api/agent-integrations/${encodeURIComponent(name)}/enable`,
    { method: 'POST', timeoutMs: 15_000 },
  ));
  if (!parsed || parsed.name !== name) throw new Error('Invalid Agent integration response');
  return parsed;
}
