export interface PaneAgentItem {
  id: string;
  agent?: string | null;
}

type PaneStates = Record<string, { agent?: string | null; window?: string | null } | undefined>;

interface PaneWorkspace {
  window?: { id?: string | null } | null;
  panes?: PaneAgentItem[];
}

export function currentPaneAgent(
  current: { paneId?: string | null; panes?: PaneAgentItem[] } | null | undefined,
  states: PaneStates = {},
  pinnedCodexPanes: ReadonlySet<string> | null = null,
): string | null {
  const paneId = current?.paneId;
  if (!paneId) return null;
  // Controlled takeover owns this pane's product identity until the exact managed thread appears or the
  // user explicitly returns to terminal. Transient shell/stale process scans must never hide chat midway.
  if (pinnedCodexPanes?.has(paneId)) return 'codex';
  const pane = current.panes?.find((candidate) => candidate.id === paneId);
  // New /panes responses always carry `agent: string | null` from Runtime identity. Only an older Server
  // that omits the field may fall back to the compatibility /states identity.
  if (pane && Object.hasOwn(pane, 'agent')) return pane.agent || null;
  return states[paneId]?.agent || null;
}

export function hasCanonicalCurrentPaneAgent(
  current: { paneId?: string | null; panes?: PaneAgentItem[] } | null | undefined,
): boolean {
  const paneId = current?.paneId;
  if (!paneId) return false;
  const pane = current.panes?.find((candidate) => candidate.id === paneId);
  return !!pane && Object.hasOwn(pane, 'agent');
}

export function clearPaneConversationIdentities<V>(cache: Map<string, V>, paneId: string): void {
  const prefix = `${paneId}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function navigationAgentMaps(
  current: PaneWorkspace | null | undefined,
  states: PaneStates = {},
): {
  windowAgents: Record<string, string | null>;
  paneAgents: Record<string, string | null>;
} {
  const windowAgents: Record<string, string | null> = {};
  const paneAgents: Record<string, string | null> = {};
  for (const [paneId, state] of Object.entries(states)) {
    if (!state?.agent) continue;
    paneAgents[paneId] = state.agent;
    if (state.window) windowAgents[state.window] = state.agent;
  }

  const windowId = current?.window?.id;
  let hasCanonicalWindowIdentity = false;
  let canonicalWindowAgent: string | null = null;
  for (const pane of current?.panes || []) {
    if (!Object.hasOwn(pane, 'agent')) continue;
    hasCanonicalWindowIdentity = true;
    paneAgents[pane.id] = pane.agent || null;
    if (pane.agent) canonicalWindowAgent = pane.agent;
  }
  if (windowId && hasCanonicalWindowIdentity) windowAgents[windowId] = canonicalWindowAgent;
  return { windowAgents, paneAgents };
}
