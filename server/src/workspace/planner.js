function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function restoredName(sourceName, names) {
  if (!names.has(sourceName)) return sourceName;
  const restored = `${sourceName}-restored`;
  if (!names.has(restored)) return restored;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${restored}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

function runtimeIds(live) {
  const windows = Array.isArray(live?.windows) ? live.windows : [];
  return {
    sessions: uniqueStrings((Array.isArray(live?.sessions) ? live.sessions : []).map((session) => session.runtimeId)),
    windows: uniqueStrings(windows.map((window) => window.runtimeId)),
    panes: uniqueStrings(windows.flatMap((window) => Array.isArray(window.panes) ? window.panes.map((pane) => pane.runtimeId) : [])),
  };
}

function countTopology(windows) {
  const panes = windows.flatMap((window) => Array.isArray(window.panes) ? window.panes : []);
  return {
    windows: windows.length,
    panes: panes.length,
    agents: panes.filter((pane) => pane.agent !== null && pane.agent !== undefined).length,
  };
}

function warningList(...sources) {
  return uniqueStrings(sources.flatMap((source) => Array.isArray(source) ? source : [source]));
}

function unwrapCheckpoint(input) {
  if (input?.status === 'ok' && input.value) {
    return { checkpoint: input.value, warnings: warningList(input.warnings, input.warning) };
  }
  return { checkpoint: input, warnings: warningList(input?.warnings, input?.warning) };
}

function linkedOwners(sessions) {
  const owners = new Map();
  for (const session of sessions) {
    if (!Array.isArray(session.windowLinks)) continue;
    for (const link of session.windowLinks) {
      if (typeof link?.windowId !== 'string') continue;
      if (!owners.has(link.windowId)) owners.set(link.windowId, new Set());
      owners.get(link.windowId).add(session.id);
    }
  }
  return owners;
}

function topologyIssue(session, windowsById, owners, supportsLinkedWindows) {
  if (!Array.isArray(session.windowLinks) || session.windowLinks.length === 0) return 'missing-window-links';
  const ids = session.windowLinks.map((link) => link?.windowId);
  const indexes = session.windowLinks.map((link) => link?.index);
  if (ids.some((id) => typeof id !== 'string' || !id)) return 'invalid-window-link';
  if (indexes.some((index) => !Number.isInteger(index) || index < 0)) return 'invalid-window-link-index';
  if (new Set(ids).size !== ids.length) return 'duplicate-window-link';
  if (new Set(indexes).size !== indexes.length) return 'duplicate-window-link-index';
  if (ids.some((id) => !windowsById.has(id))) return 'dangling-window-link';
  if (!ids.includes(session.activeWindowId)) return 'dangling-active-window';
  if (!supportsLinkedWindows && ids.some((id) => owners.get(id)?.size > 1)) return 'linked-windows-unsupported';

  for (const id of ids) {
    const window = windowsById.get(id);
    if (!Array.isArray(window.panes) || window.panes.length === 0) return 'missing-window-panes';
    const paneIds = window.panes.map((pane) => pane?.id);
    if (paneIds.some((paneId) => typeof paneId !== 'string' || !paneId)) return 'invalid-pane';
    if (new Set(paneIds).size !== paneIds.length) return 'duplicate-pane';
    if (!paneIds.includes(window.activePaneId)) return 'dangling-active-pane';
  }
  return null;
}

function sourceProjection(session) {
  return {
    activeWindowId: session.activeWindowId,
    windowLinks: Array.isArray(session.windowLinks)
      ? session.windowLinks.map(({ windowId, index }) => ({ windowId, index }))
      : [],
  };
}

function selectedTopology(items, windowsById) {
  const windowIds = new Set();
  for (const item of items) {
    if (item.action !== 'create' && item.action !== 'create-renamed') continue;
    for (const link of item.windowLinks) windowIds.add(link.windowId);
  }
  return [...windowIds].map((id) => windowsById.get(id)).filter(Boolean);
}

export function buildRestorePlan(checkpointInput, live, {
  sessionNames = [],
  recovery = null,
  historical = false,
  supportsLinkedWindows = true,
  warnings = [],
  warning = null,
} = {}) {
  const unwrapped = unwrapCheckpoint(checkpointInput);
  const checkpoint = unwrapped.checkpoint;
  if (!checkpoint || !Array.isArray(checkpoint.sessions) || !Array.isArray(checkpoint.windows)) {
    throw new Error('invalid checkpoint for restore planning');
  }

  const windowsById = new Map(checkpoint.windows.map((window) => [window.id, window]));
  const owners = linkedOwners(checkpoint.sessions);
  const pendingIds = recovery && Array.isArray(recovery.pendingSessionIds)
    ? new Set(recovery.pendingSessionIds)
    : null;
  const requestedNames = new Set(Array.isArray(sessionNames) ? sessionNames : [sessionNames]);
  const selected = checkpoint.sessions.filter((session) => {
    if (!historical && pendingIds && !pendingIds.has(session.id)) return false;
    return requestedNames.size === 0 || requestedNames.has(session.name);
  });

  const currentSessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const logicalIds = new Set(currentSessions.map((session) => session.id));
  const names = new Set(currentSessions.map((session) => session.name));
  const sessions = selected.map((session) => {
    const source = { logicalId: session.id, sourceName: session.name, ...sourceProjection(session) };
    if (logicalIds.has(session.id)) return { ...source, action: 'already-present' };
    const reason = topologyIssue(session, windowsById, owners, supportsLinkedWindows);
    if (reason) return { ...source, action: 'unsupported', reason };
    const targetName = restoredName(session.name, names);
    names.add(targetName);
    return {
      ...source,
      targetName,
      action: targetName === session.name ? 'create' : 'create-renamed',
    };
  });

  const actions = { create: 0, renamed: 0, alreadyPresent: 0, unsupported: 0 };
  for (const session of sessions) {
    if (session.action === 'create') actions.create += 1;
    else if (session.action === 'create-renamed') actions.renamed += 1;
    else if (session.action === 'already-present') actions.alreadyPresent += 1;
    else if (session.action === 'unsupported') actions.unsupported += 1;
  }

  const checkpointTopology = countTopology(checkpoint.windows);
  const planTopology = countTopology(selectedTopology(sessions, windowsById));
  const plan = {
    checkpointId: checkpoint.id,
    capturedAt: checkpoint.capturedAt,
    archivedAt: checkpoint.archivedAt,
    changeReason: checkpoint.environment?.endedReason ?? null,
    detectedAt: recovery?.detectedAt ?? null,
    expiresAt: recovery?.expiresAt ?? null,
    resolved: Boolean(recovery?.resolvedAt),
    pendingCount: pendingIds?.size ?? null,
    summary: { sessions: checkpoint.sessions.length, ...checkpointTopology },
    planSummary: { ...actions, ...planTopology },
    sessions,
    active: checkpoint.active === null || checkpoint.active === undefined ? null : { ...checkpoint.active },
    preExistingRuntimeIds: runtimeIds(live),
    warnings: warningList(unwrapped.warnings, checkpoint.warnings, checkpoint.warning, warnings, warning),
  };
  return deepFreeze(plan);
}
