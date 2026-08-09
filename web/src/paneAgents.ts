export interface PaneAgentItem {
  id: string;
  agent?: string | null;
  [key: string]: unknown;
}

type PaneStates = Record<string, { agent?: string | null } | undefined>;

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
  return current.panes?.find((pane) => pane.id === paneId)?.agent
    || states[paneId]?.agent
    || null;
}

// A successful /states response is the later live truth. Reconcile it back into the navigation snapshot so
// a stopped agent does not leave the startup identity from /panes latched after it exits.
export function reconcilePaneAgents<TPane extends PaneAgentItem>(
  panes: TPane[] = [],
  states: PaneStates = {},
): TPane[] {
  let changed = false;
  const next = panes.map((pane) => {
    const agent = states[pane.id]?.agent || null;
    if ((pane.agent || null) === agent) return pane;
    changed = true;
    return { ...pane, agent } as TPane;
  });
  return changed ? next : panes;
}
