export interface PaneAgentItem {
  id: string;
  agent?: string | null;
}

type PaneStates = Record<string, { agent?: string | null; window?: string | null } | undefined>;

interface PaneWorkspace {
  window?: { id?: string | null } | null;
  paneId?: string | null;
  panes?: PaneAgentItem[];
  windows?: readonly { id?: string | null; activePaneId?: string | null }[] | null;
}

export interface PaneAgentPin {
  paneId: string;
  agentId: string;
}

// Carry each pane's last confirmed Agent forward when a fresh /panes response does not carry the field for it.
// The server omits `agent` when its process probe was inconclusive — its own comment documents that as
// "preserve the last confirmed owner in consumers" — but this response replaces the pane list wholesale, so
// without this the value is lost: the badge blanks for a beat and then flips to whatever the compatibility
// roster happens to say, which is the flicker users see on the pane they are actually looking at. An explicit
// `null` still clears, because that is the server saying there is no Agent on this pane.
export function mergePaneAgents<T extends PaneAgentItem>(
  previous: readonly T[] | null | undefined,
  next: readonly T[],
): T[] {
  const before = new Map((previous ?? []).map((pane) => [pane.id, pane]));
  return next.map((pane) => {
    if (Object.hasOwn(pane, 'agent')) return pane;
    const kept = before.get(pane.id);
    return kept && Object.hasOwn(kept, 'agent') ? { ...pane, agent: kept.agent } : pane;
  });
}

export function currentPaneAgent(
  current: { paneId?: string | null; panes?: PaneAgentItem[] } | null | undefined,
  states: PaneStates = {},
  pin: PaneAgentPin | null = null,
): string | null {
  const paneId = current?.paneId;
  if (!paneId) return null;
  // Controlled takeover owns this pane's product identity until the exact managed thread appears or the
  // user explicitly returns to terminal. Transient shell/stale process scans must never hide chat midway.
  if (pin?.paneId === paneId) return pin.agentId;
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
  // The pane this client last chose for a window — the one selecting it opens. Only a fallback: tmux's own
  // active pane decides nothing here while we know which pane the user picked.
  chosenPane: (windowId: string) => string | null = () => null,
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
  // A window's badge is the Agent of the pane the user selected — nothing else. Which pane that is comes from
  // this client (the pane it is on, or the one it chose for that window last), never from tmux: the two
  // disagree whenever nothing has selected the pane in tmux, and tmux naming a shell is what hid the logo on a
  // window the user was looking at Claude in. A selected pane that runs no Agent shows no badge, including a
  // shell pane of a window that runs one somewhere else — the badge answers what the user is on, and the pane
  // map is what shows the rest. tmux's active pane is used only for a window this client has never opened.
  for (const win of current?.windows ?? []) {
    if (!win?.id) continue;
    const chosen = win.id === windowId ? current?.paneId || null : chosenPane(win.id);
    const paneId = chosen || (typeof win.activePaneId === 'string' ? win.activePaneId : null);
    if (!paneId) continue;
    windowAgents[win.id] = paneAgents[paneId] ?? null;
  }
  return { windowAgents, paneAgents };
}
