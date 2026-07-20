function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function nonEmptyStringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function indexOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
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

function runtimeIdList(items, kind) {
  return items.map((item) => {
    const runtimeId = nonEmptyStringOrNull(item?.runtimeId);
    if (runtimeId === null) throw new Error(`invalid live ${kind} runtime id`);
    return runtimeId;
  });
}

function runtimeIds(live) {
  const sessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const windows = Array.isArray(live?.windows) ? live.windows : [];
  const panes = windows.flatMap((window) => Array.isArray(window?.panes) ? window.panes : []);
  return {
    sessions: runtimeIdList(sessions, 'session'),
    windows: runtimeIdList(windows, 'window'),
    panes: runtimeIdList(panes, 'pane'),
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
    if (!Array.isArray(session?.windowLinks)) continue;
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
  const validSession = session && typeof session === 'object' && !Array.isArray(session);
  const rawLinks = validSession && Array.isArray(session.windowLinks) ? session.windowLinks : [];
  const source = {
    logicalId: nonEmptyStringOrNull(validSession ? session.id : null),
    sourceName: nonEmptyStringOrNull(validSession ? session.name : null),
    activeWindowId: nonEmptyStringOrNull(validSession ? session.activeWindowId : null),
    windowLinks: rawLinks.map((link) => ({
      windowId: nonEmptyStringOrNull(link && typeof link === 'object' && !Array.isArray(link) ? link.windowId : null),
      index: indexOrNull(link && typeof link === 'object' && !Array.isArray(link) ? link.index : null),
    })),
  };
  let issue = null;
  if (!validSession) issue = 'invalid-session';
  else if (source.logicalId === null) issue = 'invalid-session-id';
  else if (source.sourceName === null) issue = 'invalid-session-name';
  else if (source.activeWindowId === null) issue = 'invalid-active-window-id';
  else if (!Array.isArray(session.windowLinks)) issue = 'invalid-window-links';
  else if (source.windowLinks.some((link) => link.windowId === null)) issue = 'invalid-window-link';
  else if (source.windowLinks.some((link) => link.index === null)) issue = 'invalid-window-link-index';
  return { source, issue };
}

function activeProjection(active) {
  if (active === null || active === undefined) return null;
  return {
    sessionId: stringOrNull(active.sessionId),
    windowId: stringOrNull(active.windowId),
    paneId: stringOrNull(active.paneId),
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

function windowDispositions(items, live) {
  const liveWindows = new Map((Array.isArray(live?.windows) ? live.windows : []).map((window) => [window.id, window.runtimeId]));
  const dispositions = new Map();
  for (const item of items) {
    if (item.action !== 'create' && item.action !== 'create-renamed') continue;
    for (const { windowId } of item.windowLinks) {
      if (dispositions.has(windowId)) continue;
      if (liveWindows.has(windowId)) {
        const runtimeId = nonEmptyStringOrNull(liveWindows.get(windowId));
        if (runtimeId === null) throw new Error('invalid live window runtime id');
        dispositions.set(windowId, { logicalId: nonEmptyStringOrNull(windowId), action: 'reuse', runtimeId });
      } else {
        dispositions.set(windowId, {
          logicalId: nonEmptyStringOrNull(windowId),
          action: 'create',
          ownerSessionId: nonEmptyStringOrNull(item.logicalId),
        });
      }
    }
  }
  return [...dispositions.values()];
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
  if (recovery !== null && recovery?.checkpointId !== checkpoint.id) {
    throw new Error('recovery checkpoint id mismatch');
  }

  const windowsById = new Map(checkpoint.windows.map((window) => [window.id, window]));
  const owners = linkedOwners(checkpoint.sessions);
  const pendingIds = recovery && Array.isArray(recovery.pendingSessionIds)
    ? new Set(recovery.pendingSessionIds)
    : null;
  const requestedNames = new Set(Array.isArray(sessionNames) ? sessionNames : [sessionNames]);
  const selected = checkpoint.sessions.filter((session) => {
    if (!historical && pendingIds && !pendingIds.has(session?.id)) return false;
    return requestedNames.size === 0 || requestedNames.has(session?.name);
  });

  const currentSessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const logicalIds = new Set(currentSessions.map((session) => session.id));
  const names = new Set(currentSessions.map((session) => session.name));
  const sessions = selected.map((session) => {
    const { source, issue } = sourceProjection(session);
    if (issue) return { ...source, action: 'unsupported', reason: issue };
    if (logicalIds.has(source.logicalId)) return { ...source, action: 'already-present' };
    const reason = topologyIssue(source, windowsById, owners, supportsLinkedWindows);
    if (reason) return { ...source, action: 'unsupported', reason };
    const targetName = restoredName(source.sourceName, names);
    names.add(targetName);
    return {
      ...source,
      targetName,
      action: targetName === source.sourceName ? 'create' : 'create-renamed',
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
    checkpointId: stringOrNull(checkpoint.id),
    capturedAt: stringOrNull(checkpoint.capturedAt),
    archivedAt: stringOrNull(checkpoint.archivedAt),
    changeReason: stringOrNull(checkpoint.environment?.endedReason),
    detectedAt: stringOrNull(recovery?.detectedAt),
    expiresAt: stringOrNull(recovery?.expiresAt),
    resolved: Boolean(recovery?.resolvedAt),
    pendingCount: pendingIds?.size ?? null,
    summary: { sessions: checkpoint.sessions.length, ...checkpointTopology },
    planSummary: { ...actions, ...planTopology },
    sessions,
    windows: windowDispositions(sessions, live),
    active: activeProjection(checkpoint.active),
    preExistingRuntimeIds: runtimeIds(live),
    warnings: warningList(unwrapped.warnings, checkpoint.warnings, checkpoint.warning, warnings, warning),
  };
  return deepFreeze(plan);
}
