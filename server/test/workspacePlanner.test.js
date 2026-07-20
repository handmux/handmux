import { describe, expect, it } from 'vitest';
import { buildRestorePlan } from '../src/workspace/planner.js';

const pane = (id, runtimeId, agent = null) => ({ id, runtimeId, index: 0, cwd: `/work/${id}`, agent });

function checkpoint() {
  return {
    id: 'cp-a',
    capturedAt: '2026-07-20T01:00:00.000Z',
    archivedAt: '2026-07-20T01:05:00.000Z',
    environment: { id: 'cp-a', bootIdentity: 'boot-a', tmuxServerId: 'server-a', endedReason: 'boot-changed' },
    active: { sessionId: 's-api', windowId: 'w-api', paneId: 'p-api' },
    sessions: [
      {
        id: 's-api', runtimeId: '$1', name: 'api', activeWindowId: 'w-api',
        windowLinks: [{ windowId: 'w-api', index: 0 }, { windowId: 'w-shared', index: 1 }],
      },
      {
        id: 's-docs', runtimeId: '$2', name: 'docs', activeWindowId: 'w-docs',
        windowLinks: [{ windowId: 'w-docs', index: 0 }, { windowId: 'w-shared', index: 4 }],
      },
      {
        id: 's-ops', runtimeId: '$3', name: 'ops', activeWindowId: 'w-ops',
        windowLinks: [{ windowId: 'w-ops', index: 0 }],
      },
    ],
    windows: [
      {
        id: 'w-api', runtimeId: '@1', name: 'api-main', index: 0, layout: 'layout-api', activePaneId: 'p-api',
        panes: [pane('p-api', '%1', { id: 'claude', sessionId: 'agent-api', transcriptPath: '/private/api.jsonl' })],
      },
      {
        id: 'w-docs', runtimeId: '@2', name: 'docs-main', index: 0, layout: 'layout-docs', activePaneId: 'p-docs',
        panes: [pane('p-docs', '%2')],
      },
      {
        id: 'w-shared', runtimeId: '@3', name: 'shared', index: 1, layout: 'layout-shared', activePaneId: 'p-shared',
        panes: [pane('p-shared', '%3', { id: 'codex', sessionId: 'agent-shared', transcriptPath: '/private/shared.jsonl' })],
      },
      {
        id: 'w-ops', runtimeId: '@4', name: 'ops-main', index: 0, layout: 'layout-ops', activePaneId: 'p-ops',
        panes: [pane('p-ops', '%4')],
      },
    ],
  };
}

function live(sessions = [], windows = []) {
  return { sessions, windows };
}

const liveSession = (id, runtimeId, name) => ({ id, runtimeId, name, windowLinks: [], activeWindowId: '' });

describe('workspace restore planner', () => {
  it.each([
    { names: [], action: 'create', targetName: 'api' },
    { names: ['api'], action: 'create-renamed', targetName: 'api-restored' },
    { names: ['api', 'api-restored'], action: 'create-renamed', targetName: 'api-restored-2' },
    { names: ['api', 'api-restored', 'api-restored-2'], action: 'create-renamed', targetName: 'api-restored-3' },
  ])('uses the first available non-destructive name for $names', ({ names, action, targetName }) => {
    const current = names.map((name, index) => liveSession(`live-${index}`, `$${index + 8}`, name));
    const plan = buildRestorePlan(checkpoint(), live(current), { sessionNames: ['api'] });

    expect(plan.sessions).toMatchObject([{ logicalId: 's-api', sourceName: 'api', action, targetName }]);
  });

  it('uses logical id only for already-present and still suffixes a name collision', () => {
    const plan = buildRestorePlan(checkpoint(), live([
      liveSession('new-logical-id', '$8', 'api'),
      liveSession('s-docs', '$9', 'other'),
    ]), { historical: true, sessionNames: ['api', 'docs'] });

    expect(plan.sessions).toMatchObject([
      { logicalId: 's-api', action: 'create-renamed', targetName: 'api-restored' },
      { logicalId: 's-docs', action: 'already-present' },
    ]);
    expect(plan.planSummary).toMatchObject({ create: 0, renamed: 1, alreadyPresent: 1, unsupported: 0 });
  });

  it('deduplicates repeated session filters and defaults to recovery pending scope', () => {
    const recovery = {
      checkpointId: 'cp-a',
      detectedAt: '2026-07-20T02:00:00.000Z',
      expiresAt: '2026-07-20T03:00:00.000Z',
      pendingSessionIds: ['s-docs'],
      resolvedAt: null,
    };

    const pending = buildRestorePlan(checkpoint(), live(), { sessionNames: ['docs', 'docs', 'api'], recovery });
    const historical = buildRestorePlan(checkpoint(), live(), { sessionNames: ['docs', 'docs', 'api'], recovery, historical: true });

    expect(pending.sessions.map((item) => item.logicalId)).toEqual(['s-docs']);
    expect(historical.sessions.map((item) => item.logicalId)).toEqual(['s-api', 's-docs']);
    expect(pending).toMatchObject({
      detectedAt: recovery.detectedAt,
      expiresAt: recovery.expiresAt,
      resolved: false,
      pendingCount: 1,
    });
  });

  it('fails closed when recovery belongs to a different checkpoint', () => {
    const recovery = {
      checkpointId: 'cp-other',
      detectedAt: '2026-07-20T02:00:00.000Z',
      expiresAt: '2026-07-20T03:00:00.000Z',
      pendingSessionIds: ['s-api'],
      resolvedAt: null,
    };

    expect(() => buildRestorePlan(checkpoint(), live(), { recovery })).toThrow(/recovery checkpoint id mismatch/i);
  });

  it('counts a linked window once and fails closed when linked windows are unsupported', () => {
    const supported = buildRestorePlan(checkpoint(), live(), { sessionNames: ['api', 'docs'], historical: true });
    const unsupported = buildRestorePlan(checkpoint(), live(), {
      sessionNames: ['api', 'docs'], historical: true, supportsLinkedWindows: false,
    });

    expect(supported.planSummary).toEqual({
      create: 2, renamed: 0, alreadyPresent: 0, unsupported: 0, windows: 3, panes: 3, agents: 2,
    });
    expect(supported.sessions.every((item) => item.action === 'create')).toBe(true);
    expect(unsupported.sessions).toMatchObject([
      { logicalId: 's-api', action: 'unsupported', reason: 'linked-windows-unsupported' },
      { logicalId: 's-docs', action: 'unsupported', reason: 'linked-windows-unsupported' },
    ]);
    expect(unsupported.planSummary).toEqual({
      create: 0, renamed: 0, alreadyPresent: 0, unsupported: 2, windows: 0, panes: 0, agents: 0,
    });
  });

  it('reuses a live shared window for a missing owner without assigning the already-present owner', () => {
    const current = live(
      [liveSession('s-api', '$8', 'api')],
      [
        { id: 'w-api', runtimeId: '@8', panes: [pane('live-api', '%8')] },
        { id: 'w-shared', runtimeId: '@9', panes: [pane('live-shared', '%9')] },
      ],
    );

    const plan = buildRestorePlan(checkpoint(), current, { historical: true, sessionNames: ['api', 'docs'] });

    expect(plan.sessions.map(({ logicalId, action }) => ({ logicalId, action }))).toEqual([
      { logicalId: 's-api', action: 'already-present' },
      { logicalId: 's-docs', action: 'create' },
    ]);
    expect(plan.windows).toEqual([
      { logicalId: 'w-docs', action: 'create', ownerSessionId: 's-docs' },
      { logicalId: 'w-shared', action: 'reuse', runtimeId: '@9' },
    ]);
  });

  it('creates a window shared by two missing owners once under the first creating session', () => {
    const plan = buildRestorePlan(checkpoint(), live(), { historical: true, sessionNames: ['api', 'docs'] });

    expect(plan.windows).toEqual([
      { logicalId: 'w-api', action: 'create', ownerSessionId: 's-api' },
      { logicalId: 'w-shared', action: 'create', ownerSessionId: 's-api' },
      { logicalId: 'w-docs', action: 'create', ownerSessionId: 's-docs' },
    ]);
    expect(Object.isFrozen(plan.windows)).toBe(true);
    expect(Object.isFrozen(plan.windows[0])).toBe(true);
  });

  it('fails closed on a malformed live window runtime id without freezing it', () => {
    const runtimeId = { value: '@8' };
    const current = live([], [{ id: 'w-api', runtimeId, panes: [] }]);

    expect(() => buildRestorePlan(checkpoint(), current, { historical: true, sessionNames: ['api'] }))
      .toThrow(/invalid live window runtime id/i);
    expect(Object.isFrozen(runtimeId)).toBe(false);
    runtimeId.mutated = true;
  });

  it('marks malformed session topology unsupported instead of planning a partial restore', () => {
    const source = checkpoint();
    source.sessions[2].windowLinks = [{ windowId: 'w-missing', index: 0 }];

    const plan = buildRestorePlan(source, live(), { sessionNames: ['ops'], historical: true });

    expect(plan.sessions).toMatchObject([
      { logicalId: 's-ops', sourceName: 'ops', action: 'unsupported', reason: 'dangling-window-link' },
    ]);
  });

  it('returns checkpoint and selected-plan summaries, metadata, active logical ids, and fallback warnings', () => {
    const source = { status: 'ok', value: checkpoint(), warning: 'latest pointer is corrupt; using cp-a' };
    const recovery = {
      checkpointId: 'cp-a',
      detectedAt: '2026-07-20T02:00:00.000Z',
      expiresAt: '2026-07-20T03:00:00.000Z',
      pendingSessionIds: [],
      resolvedAt: '2026-07-20T02:30:00.000Z',
    };

    const plan = buildRestorePlan(source, live(), { recovery, historical: true, sessionNames: ['ops'] });

    expect(plan).toMatchObject({
      checkpointId: 'cp-a',
      capturedAt: '2026-07-20T01:00:00.000Z',
      archivedAt: '2026-07-20T01:05:00.000Z',
      changeReason: 'boot-changed',
      detectedAt: recovery.detectedAt,
      expiresAt: recovery.expiresAt,
      resolved: true,
      pendingCount: 0,
      summary: { sessions: 3, windows: 4, panes: 4, agents: 2 },
      planSummary: { create: 1, renamed: 0, alreadyPresent: 0, unsupported: 0, windows: 1, panes: 1, agents: 0 },
      active: { sessionId: 's-api', windowId: 'w-api', paneId: 'p-api' },
      warnings: ['latest pointer is corrupt; using cp-a'],
    });
  });

  it('projects active and metadata primitives without freezing caller-owned nested objects', () => {
    const source = checkpoint();
    const capturedAt = { value: source.capturedAt };
    const activeExtra = { nested: { value: 'caller-owned' } };
    const detectedAt = { value: '2026-07-20T02:00:00.000Z' };
    source.capturedAt = capturedAt;
    source.active.extra = activeExtra;
    const recovery = {
      checkpointId: 'cp-a',
      detectedAt,
      expiresAt: '2026-07-20T03:00:00.000Z',
      pendingSessionIds: ['s-api'],
      resolvedAt: null,
    };

    const plan = buildRestorePlan(source, live(), { recovery });

    expect(plan.active).not.toBe(source.active);
    expect(plan.active).toEqual({ sessionId: 's-api', windowId: 'w-api', paneId: 'p-api' });
    expect(plan.capturedAt).toBeNull();
    expect(plan.detectedAt).toBeNull();
    expect(Object.isFrozen(capturedAt)).toBe(false);
    expect(Object.isFrozen(activeExtra)).toBe(false);
    expect(Object.isFrozen(detectedAt)).toBe(false);

    capturedAt.value = 'mutated';
    activeExtra.nested.value = 'mutated';
    detectedAt.value = 'mutated';
    expect(plan.active).toEqual({ sessionId: 's-api', windowId: 'w-api', paneId: 'p-api' });
  });

  it('fails malformed session and link fields closed without freezing caller-owned objects', () => {
    const source = checkpoint();
    const logicalId = { value: 's-api' };
    const sourceName = { value: 'api' };
    const activeWindowId = { value: 'w-api' };
    const windowId = { value: 'w-api' };
    const index = { value: 0 };
    const sourceSession = source.sessions[0];
    const sourceLink = sourceSession.windowLinks[0];
    sourceSession.id = logicalId;
    sourceSession.name = sourceName;
    sourceSession.activeWindowId = activeWindowId;
    sourceLink.windowId = windowId;
    sourceLink.index = index;
    source.sessions = [sourceSession];

    const plan = buildRestorePlan(source, live(), { historical: true });

    expect(plan.sessions[0]).not.toBe(sourceSession);
    expect(plan.sessions[0].windowLinks[0]).not.toBe(sourceLink);
    expect(plan.sessions[0]).toEqual({
      logicalId: null,
      sourceName: null,
      activeWindowId: null,
      windowLinks: [{ windowId: null, index: null }, { windowId: 'w-shared', index: 1 }],
      action: 'unsupported',
      reason: 'invalid-session-id',
    });
    for (const callerValue of [logicalId, sourceName, activeWindowId, windowId, index]) {
      expect(Object.isFrozen(callerValue)).toBe(false);
      callerValue.mutated = true;
    }
    expect(plan.windows).toEqual([]);
  });

  it('deep-freezes the plan and snapshots every pre-existing runtime id', () => {
    const source = checkpoint();
    const current = live(
      [liveSession('live-a', '$8', 'current')],
      [{ id: 'live-w', runtimeId: '@8', panes: [pane('live-p', '%8')] }],
    );
    const plan = buildRestorePlan(source, current, { historical: true });

    expect(plan.preExistingRuntimeIds).toEqual({ sessions: ['$8'], windows: ['@8'], panes: ['%8'] });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.sessions)).toBe(true);
    expect(Object.isFrozen(plan.sessions[0])).toBe(true);
    expect(Object.isFrozen(plan.sessions[0].windowLinks)).toBe(true);
    expect(Object.isFrozen(plan.preExistingRuntimeIds)).toBe(true);
    expect(Object.isFrozen(plan.preExistingRuntimeIds.sessions)).toBe(true);
    expect(Object.isFrozen(plan.active)).toBe(true);

    source.sessions[0].windowLinks[0].windowId = 'mutated';
    current.sessions[0].runtimeId = '$mutated';
    expect(plan.sessions[0].windowLinks[0].windowId).toBe('w-api');
    expect(plan.preExistingRuntimeIds.sessions).toEqual(['$8']);
    expect(() => plan.sessions.push({})).toThrow();
  });

  it.each(['session', 'window', 'pane'])('fails closed on a malformed live %s runtime id without freezing it', (kind) => {
    const runtimeId = { value: kind };
    const currentSession = liveSession('live-s', '$8', 'current');
    const currentWindow = { id: 'live-w', runtimeId: '@8', panes: [pane('live-p', '%8')] };
    if (kind === 'session') currentSession.runtimeId = runtimeId;
    if (kind === 'window') currentWindow.runtimeId = runtimeId;
    if (kind === 'pane') currentWindow.panes[0].runtimeId = runtimeId;

    expect(() => buildRestorePlan(checkpoint(), live([currentSession], [currentWindow]), { historical: true }))
      .toThrow(new RegExp(`invalid live ${kind} runtime id`, 'i'));
    expect(Object.isFrozen(runtimeId)).toBe(false);
    runtimeId.mutated = true;
  });

  it.each(['session', 'window', 'pane'])('fails closed on an empty live %s runtime id', (kind) => {
    const currentSession = liveSession('live-s', '$8', 'current');
    const currentWindow = { id: 'live-w', runtimeId: '@8', panes: [pane('live-p', '%8')] };
    if (kind === 'session') currentSession.runtimeId = '';
    if (kind === 'window') currentWindow.runtimeId = '';
    if (kind === 'pane') currentWindow.panes[0].runtimeId = '';

    expect(() => buildRestorePlan(checkpoint(), live([currentSession], [currentWindow]), { historical: true }))
      .toThrow(new RegExp(`invalid live ${kind} runtime id`, 'i'));
  });
});
