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
});
