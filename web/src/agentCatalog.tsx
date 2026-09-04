import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

export interface AgentCatalogDescriptor {
  id: string;
  label: string;
  iconId?: string;
  capabilities: {
    inbox: boolean;
    conversation: boolean;
    conversationActivation?: boolean;
    conversationGoal?: boolean;
    conversationPlan?: boolean;
    conversationContext?: boolean;
    conversationPermission?: boolean;
    conversationCommands?: boolean;
    interaction: boolean;
    sessionControl?: boolean;
    subscriptionUsage: boolean;
  };
  capabilityMetadata?: {
    conversation?: { experimental: boolean };
  };
}

export interface AgentRunRef {
  agentId: string;
  paneId: string;
  runId: string;
  sessionId?: string;
}

export type AgentAvailability = 'starting' | 'ready' | 'degraded' | 'unavailable';

export interface AgentHealthEntry {
  adapterId: string;
  capability?: string;
  availability: AgentAvailability;
  message?: string;
  lastSuccessAt?: number;
}

export interface AgentDiscoverySnapshot {
  descriptors: AgentCatalogDescriptor[];
  runs: AgentRunRef[];
  health: AgentHealthEntry[];
}

// The global reconnect pill means the Inbox as a whole cannot currently provide a usable view. A degraded
// provider is still serving the Inbox while isolating one bad pane, and an empty Inbox is itself a usable
// result, so only a source that has not started or is fully unavailable gets the global warning.
export function inboxReconnectNeeded(snapshot: AgentDiscoverySnapshot | null): boolean {
  return snapshot?.health.some((entry) => (
    entry.capability === 'inbox'
    && snapshot.descriptors.some((descriptor) => (
      descriptor.id === entry.adapterId && descriptor.capabilities.inbox
    ))
    && (entry.availability === 'starting' || entry.availability === 'unavailable')
  )) ?? false;
}

interface AgentCatalogValue {
  loaded: boolean;
  descriptors: ReadonlyMap<string, AgentCatalogDescriptor>;
  runsByPane: ReadonlyMap<string, AgentRunRef>;
}

const AgentCatalogContext = createContext<AgentCatalogValue | null>(null);

export function AgentCatalogProvider({
  descriptors,
  runs = [],
  loaded,
  children,
}: {
  descriptors: readonly AgentCatalogDescriptor[];
  runs?: readonly AgentRunRef[];
  loaded: boolean;
  children: ReactNode;
}) {
  const value = useMemo<AgentCatalogValue>(() => ({
    loaded,
    descriptors: new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
    runsByPane: new Map(runs.map((run) => [run.paneId, run])),
  }), [descriptors, runs, loaded]);
  return (
    <AgentCatalogContext.Provider value={value}>
      {children}
    </AgentCatalogContext.Provider>
  );
}

export function useAgentRun(
  paneId: string | null | undefined,
  agentId?: string | null,
): AgentRunRef | null {
  const catalog = useContext(AgentCatalogContext);
  if (!paneId) return null;
  const run = catalog?.runsByPane.get(paneId) ?? null;
  return run && (!agentId || run.agentId === agentId) ? run : null;
}

export function useAgentCatalogDescriptor(agentId: string): {
  loaded: boolean;
  descriptor: AgentCatalogDescriptor | null;
} {
  const catalog = useContext(AgentCatalogContext);
  return {
    loaded: catalog?.loaded ?? false,
    descriptor: catalog?.descriptors.get(agentId) ?? null,
  };
}
