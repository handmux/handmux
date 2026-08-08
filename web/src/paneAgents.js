export function currentPaneAgent(current, states = {}) {
  const paneId = current?.paneId;
  if (!paneId) return null;
  return current.panes?.find((pane) => pane.id === paneId)?.agent
    || states[paneId]?.agent
    || null;
}

// A successful /states response is the later live truth. Reconcile it back into the navigation snapshot so
// a stopped agent does not leave the startup identity from /panes latched after it exits.
export function reconcilePaneAgents(panes = [], states = {}) {
  let changed = false;
  const next = panes.map((pane) => {
    const agent = states[pane.id]?.agent || null;
    if ((pane.agent || null) === agent) return pane;
    changed = true;
    return { ...pane, agent };
  });
  return changed ? next : panes;
}
