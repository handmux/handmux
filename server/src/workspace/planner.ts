type UnknownRecord = Record<string, unknown>;
type RestoreAction = 'create' | 'create-renamed' | 'already-present' | 'unsupported';
interface ProjectedLink { windowId: string | null; index: number | null }
interface ProjectedSource {
  logicalId: string | null;
  sourceName: string | null;
  activeWindowId: string | null;
  windowLinks: ProjectedLink[];
}
export interface PlanSession extends ProjectedSource {
  action: RestoreAction;
  targetName?: string;
  reason?: string;
}
export interface WindowDisposition {
  logicalId: string | null;
  action: 'reuse' | 'create';
  runtimeId?: string;
  ownerSessionId?: string | null;
}

const recordOf = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
);

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value)))];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function indexOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function restoredName(sourceName: string, names: ReadonlySet<unknown>): string {
  if (!names.has(sourceName)) return sourceName;
  const restored = `${sourceName}-restored`;
  if (!names.has(restored)) return restored;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${restored}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

function runtimeIdList(items: unknown[], kind: string): string[] {
  return items.map((item) => {
    const runtimeId = nonEmptyStringOrNull(recordOf(item)?.runtimeId);
    if (runtimeId === null) throw new Error(`invalid live ${kind} runtime id`);
    return runtimeId;
  });
}

function runtimeIds(live: unknown): { sessions: string[]; windows: string[]; panes: string[] } {
  const record = recordOf(live);
  const sessions = Array.isArray(record?.sessions) ? record.sessions : [];
  const windows = Array.isArray(record?.windows) ? record.windows : [];
  const panes = windows.flatMap((window) => {
    const panesValue = recordOf(window)?.panes;
    return Array.isArray(panesValue) ? panesValue : [];
  });
  return {
    sessions: runtimeIdList(sessions, 'session'),
    windows: runtimeIdList(windows, 'window'),
    panes: runtimeIdList(panes, 'pane'),
  };
}

function countTopology(windows: unknown[]): { windows: number; panes: number; agents: number } {
  const panes = windows.flatMap((window) => {
    const panesValue = recordOf(window)?.panes;
    return Array.isArray(panesValue) ? panesValue : [];
  });
  return {
    windows: windows.length,
    panes: panes.length,
    agents: panes.filter((pane) => {
      const agent = recordOf(pane)?.agent;
      return agent !== null && agent !== undefined;
    }).length,
  };
}

function warningList(...sources: unknown[]): string[] {
  return uniqueStrings(sources.flatMap((source) => Array.isArray(source) ? source : [source]));
}

function unwrapCheckpoint(input: unknown): { checkpoint: unknown; warnings: string[] } {
  const record = recordOf(input);
  if (record?.status === 'ok' && record.value) {
    return { checkpoint: record.value, warnings: warningList(record.warnings, record.warning) };
  }
  return { checkpoint: input, warnings: warningList(record?.warnings, record?.warning) };
}

function linkedOwners(sessions: unknown[]): Map<string, Set<unknown>> {
  const owners = new Map<string, Set<unknown>>();
  for (const candidate of sessions) {
    const session = recordOf(candidate);
    if (!session || !Array.isArray(session.windowLinks)) continue;
    for (const candidateLink of session.windowLinks) {
      const link = recordOf(candidateLink);
      if (typeof link?.windowId !== 'string') continue;
      if (!owners.has(link.windowId)) owners.set(link.windowId, new Set());
      owners.get(link.windowId)?.add(session.id);
    }
  }
  return owners;
}

function topologyIssue(
  session: ProjectedSource,
  windowsById: ReadonlyMap<unknown, UnknownRecord>,
  owners: ReadonlyMap<string, Set<unknown>>,
  supportsLinkedWindows: boolean,
): string | null {
  if (!Array.isArray(session.windowLinks) || session.windowLinks.length === 0) return 'missing-window-links';
  const ids = session.windowLinks.map((link) => link?.windowId);
  const indexes = session.windowLinks.map((link) => link?.index);
  if (ids.some((id) => typeof id !== 'string' || !id)) return 'invalid-window-link';
  if (indexes.some((index) => typeof index !== 'number' || !Number.isInteger(index) || index < 0)) return 'invalid-window-link-index';
  const validIds = ids as string[];
  const validIndexes = indexes as number[];
  if (new Set(validIds).size !== validIds.length) return 'duplicate-window-link';
  if (new Set(validIndexes).size !== validIndexes.length) return 'duplicate-window-link-index';
  if (validIds.some((id) => !windowsById.has(id))) return 'dangling-window-link';
  if (!validIds.includes(session.activeWindowId as string)) return 'dangling-active-window';
  if (!supportsLinkedWindows && validIds.some((id) => (owners.get(id)?.size ?? 0) > 1)) return 'linked-windows-unsupported';

  for (const id of validIds) {
    const window = windowsById.get(id);
    if (!window || !Array.isArray(window.panes) || window.panes.length === 0) return 'missing-window-panes';
    const paneIds = window.panes.map((pane) => recordOf(pane)?.id);
    if (paneIds.some((paneId) => typeof paneId !== 'string' || !paneId)) return 'invalid-pane';
    if (new Set(paneIds).size !== paneIds.length) return 'duplicate-pane';
    if (!paneIds.includes(window.activePaneId)) return 'dangling-active-pane';
  }
  return null;
}

function sourceProjection(session: unknown): { source: ProjectedSource; issue: string | null } {
  const validSession = session && typeof session === 'object' && !Array.isArray(session);
  const record = validSession ? session as UnknownRecord : null;
  const rawLinks = record && Array.isArray(record.windowLinks) ? record.windowLinks : [];
  const source = {
    logicalId: nonEmptyStringOrNull(record?.id),
    sourceName: nonEmptyStringOrNull(record?.name),
    activeWindowId: nonEmptyStringOrNull(record?.activeWindowId),
    windowLinks: rawLinks.map((link) => ({
      windowId: nonEmptyStringOrNull(recordOf(link)?.windowId),
      index: indexOrNull(recordOf(link)?.index),
    })),
  };
  let issue = null;
  if (!validSession) issue = 'invalid-session';
  else if (source.logicalId === null) issue = 'invalid-session-id';
  else if (source.sourceName === null) issue = 'invalid-session-name';
  else if (source.activeWindowId === null) issue = 'invalid-active-window-id';
  else if (!Array.isArray(record?.windowLinks)) issue = 'invalid-window-links';
  else if (source.windowLinks.some((link) => link.windowId === null)) issue = 'invalid-window-link';
  else if (source.windowLinks.some((link) => link.index === null)) issue = 'invalid-window-link-index';
  return { source, issue };
}

function activeProjection(active: unknown): { sessionId: string | null; windowId: string | null; paneId: string | null } | null {
  if (active === null || active === undefined) return null;
  const record = recordOf(active) ?? {};
  return {
    sessionId: stringOrNull(record.sessionId),
    windowId: stringOrNull(record.windowId),
    paneId: stringOrNull(record.paneId),
  };
}

function selectedTopology(items: PlanSession[], windowsById: ReadonlyMap<unknown, UnknownRecord>): UnknownRecord[] {
  const windowIds = new Set<string | null>();
  for (const item of items) {
    if (item.action !== 'create' && item.action !== 'create-renamed') continue;
    for (const link of item.windowLinks) windowIds.add(link.windowId);
  }
  return [...windowIds].flatMap((id) => {
    const window = windowsById.get(id);
    return window ? [window] : [];
  });
}

function windowDispositions(items: PlanSession[], live: unknown): WindowDisposition[] {
  const liveRecord = recordOf(live);
  const liveWindows = new Map<unknown, unknown>((Array.isArray(liveRecord?.windows) ? liveRecord.windows : []).map((window) => {
    const record = recordOf(window);
    return [record?.id, record?.runtimeId];
  }));
  const dispositions = new Map<string | null, WindowDisposition>();
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

export function buildRestorePlan(checkpointInput: unknown, live: unknown, {
  sessionNames = [],
  recovery = null,
  historical = false,
  supportsLinkedWindows = true,
  warnings = [],
  warning = null,
}: {
  sessionNames?: unknown[] | unknown;
  recovery?: unknown;
  historical?: boolean;
  supportsLinkedWindows?: boolean;
  warnings?: unknown;
  warning?: unknown;
} = {}) {
  const unwrapped = unwrapCheckpoint(checkpointInput);
  const checkpoint = recordOf(unwrapped.checkpoint);
  if (!checkpoint || !Array.isArray(checkpoint.sessions) || !Array.isArray(checkpoint.windows)) {
    throw new Error('invalid checkpoint for restore planning');
  }
  const recoveryRecord = recordOf(recovery);
  if (recovery !== null && recoveryRecord?.checkpointId !== checkpoint.id) {
    throw new Error('recovery checkpoint id mismatch');
  }

  const windowsById = new Map<unknown, UnknownRecord>(checkpoint.windows.flatMap((window) => {
    const record = recordOf(window);
    return record ? [[record.id, record] as const] : [];
  }));
  const owners = linkedOwners(checkpoint.sessions);
  const pendingIds = recoveryRecord && Array.isArray(recoveryRecord.pendingSessionIds)
    ? new Set(recoveryRecord.pendingSessionIds)
    : null;
  const requestedNames = new Set(Array.isArray(sessionNames) ? sessionNames : [sessionNames]);
  const selected = checkpoint.sessions.filter((session) => {
    const record = recordOf(session);
    if (!historical && pendingIds && !pendingIds.has(record?.id)) return false;
    return requestedNames.size === 0 || requestedNames.has(record?.name);
  });

  const liveRecord = recordOf(live);
  const currentSessions = Array.isArray(liveRecord?.sessions) ? liveRecord.sessions : [];
  const logicalIds = new Set(currentSessions.map((session) => recordOf(session)?.id));
  const names = new Set(currentSessions.map((session) => recordOf(session)?.name));
  const sessions: PlanSession[] = selected.map((session): PlanSession => {
    const { source, issue } = sourceProjection(session);
    if (issue) return { ...source, action: 'unsupported', reason: issue };
    if (logicalIds.has(source.logicalId)) return { ...source, action: 'already-present' };
    const reason = topologyIssue(source, windowsById, owners, supportsLinkedWindows);
    if (reason) return { ...source, action: 'unsupported', reason };
    const targetName = restoredName(source.sourceName as string, names);
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
    changeReason: stringOrNull(recordOf(checkpoint.environment)?.endedReason),
    detectedAt: stringOrNull(recoveryRecord?.detectedAt),
    expiresAt: stringOrNull(recoveryRecord?.expiresAt),
    resolved: Boolean(recoveryRecord?.resolvedAt),
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
