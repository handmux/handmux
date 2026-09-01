import { describe, expect, it, vi } from 'vitest';
import { executeRestore } from '../src/workspace/restore.js';

const ID = {
  sA: '00000000-0000-4000-8000-000000000001',
  sB: '00000000-0000-4000-8000-000000000002',
  sC: '00000000-0000-4000-8000-000000000003',
  wShared: '00000000-0000-4000-8000-000000000011',
  wA: '00000000-0000-4000-8000-000000000012',
  wB: '00000000-0000-4000-8000-000000000013',
  wC: '00000000-0000-4000-8000-000000000014',
  pShared: '00000000-0000-4000-8000-000000000021',
  pA: '00000000-0000-4000-8000-000000000022',
  pB: '00000000-0000-4000-8000-000000000023',
  pC: '00000000-0000-4000-8000-000000000024',
  agent: 'aaaaaaaa-0000-4000-8000-000000000001',
};

function pane(id, runtimeId, cwd, agent = null) {
  return { id, runtimeId, index: 0, cwd, agent };
}

function checkpoint() {
  return {
    id: 'cp-a',
    sessions: [
      { id: ID.sA, runtimeId: '$1', name: 'alpha', windowLinks: [{ windowId: ID.wShared, index: 0 }, { windowId: ID.wA, index: 1 }], activeWindowId: ID.wA },
      { id: ID.sB, runtimeId: '$2', name: 'beta', windowLinks: [{ windowId: ID.wShared, index: 0 }, { windowId: ID.wB, index: 1 }], activeWindowId: ID.wShared },
      { id: ID.sC, runtimeId: '$3', name: 'gamma', windowLinks: [{ windowId: ID.wC, index: 0 }], activeWindowId: ID.wC },
    ],
    windows: [
      { id: ID.wShared, runtimeId: '@1', name: 'shared', index: 0, layout: 'layout-shared', activePaneId: ID.pShared, panes: [pane(ID.pShared, '%1', '/shared')] },
      { id: ID.wA, runtimeId: '@2', name: 'work', index: 1, layout: 'layout-a', activePaneId: ID.pA, panes: [pane(ID.pA, '%2', '/alpha', { id: 'claude', sessionId: ID.agent, transcriptPath: '/sessions/a.jsonl' })] },
      { id: ID.wB, runtimeId: '@3', name: 'work', index: 1, layout: 'layout-b', activePaneId: ID.pB, panes: [pane(ID.pB, '%3', '/beta')] },
      { id: ID.wC, runtimeId: '@4', name: 'work', index: 0, layout: 'layout-c', activePaneId: ID.pC, panes: [pane(ID.pC, '%4', '/gamma')] },
    ],
  };
}

function plan(actions = [
  { id: ID.sA, name: 'alpha', target: 'alpha' },
  { id: ID.sB, name: 'beta', target: 'beta' },
]) {
  return {
    checkpointId: 'cp-a',
    preExistingRuntimeIds: { sessions: ['$90'], windows: ['@90'], panes: ['%90'] },
    sessions: actions.map(({ id, name, target, action = 'create' }) => ({
      logicalId: id,
      sourceName: name,
      targetName: target,
      action,
      windowLinks: checkpoint().sessions.find((session) => session.id === id)?.windowLinks || [],
      activeWindowId: checkpoint().sessions.find((session) => session.id === id)?.activeWindowId || null,
    })),
    windows: [
      { logicalId: ID.wShared, action: 'create', ownerSessionId: ID.sA },
      { logicalId: ID.wA, action: 'create', ownerSessionId: ID.sA },
      { logicalId: ID.wB, action: 'create', ownerSessionId: ID.sB },
      { logicalId: ID.wC, action: 'create', ownerSessionId: ID.sC },
    ],
  };
}

function fakeTmux({ failCreateWindowFor, failAgent = false, failLayout = false, failCleanup = false } = {}) {
  const calls = [];
  let nextSession = 10;
  let nextWindow = 20;
  let nextPane = 30;
  const call = (kind, method, target, detail = {}) => calls.push({ kind, method, target, ...detail });
  return {
    calls,
    async createTemporarySession(input) {
      const sessionId = `$${nextSession++}`;
      const windowId = `@${nextWindow++}`;
      const paneId = `%${nextPane++}`;
      call('mutate', 'createTemporarySession', sessionId, { input, sessionId, windowId, paneId });
      return { sessionId, windowId, paneId, name: `hm-r-${sessionId.slice(1)}` };
    },
    async createWindow(sessionId, input) {
      call('mutate', 'createWindow', sessionId, { input });
      if (input.windowLogicalId === failCreateWindowFor) throw new Error('injected topology failure');
      return { windowId: `@${nextWindow++}`, paneId: `%${nextPane++}` };
    },
    async splitPane(target, input) {
      call('mutate', 'splitPane', target, { input });
      return `%${nextPane++}`;
    },
    async linkWindow(source, sessionId, index, options) { call('mutate', 'linkWindow', sessionId, { source, index, options }); },
    async applyLayout(target, layout) {
      call('mutate', 'applyLayout', target, { layout });
      if (failLayout && layout === 'layout-a') throw new Error('bad layout');
    },
    async selectPane(target) { call('mutate', 'selectPane', target); },
    async selectWindow(target) { call('mutate', 'selectWindow', target); },
    async selectWindowInSession(sessionId, index) { call('mutate', 'selectWindowInSession', sessionId, { index }); },
    async renameCreatedSession(target, name) { call('mutate', 'renameCreatedSession', target, { name }); },
    async startAgent(target, cmd, args) {
      call('mutate', 'startAgent', target, { cmd, args });
      if (failAgent) throw new Error('agent executable unavailable');
    },
    async killCreatedSession(target) {
      call('mutate', 'killCreatedSession', target);
      if (failCleanup) throw new Error('injected cleanup failure');
    },
    async killCreatedWindow(target) { call('mutate', 'killCreatedWindow', target); },
    revokeCreatedTargets() { call('internal', 'revokeCreatedTargets', null); },
  };
}

const agents = [{
  id: 'claude',
  sessions: {
    isId: (id) => id === ID.agent,
    resumeArgs: (id) => ['claude', '--resume', id],
  },
}];

describe('workspace restore executor', () => {
  it('builds each session under a temp name, creates a shared window once, renames, then resumes agents', async () => {
    const tmux = fakeTmux();
    const progress = vi.fn();
    const result = await executeRestore({
      plan: plan(), checkpoint: checkpoint(), tmux, agents,
      access: async () => {}, home: '/home/me', onProgress: progress,
    });

    expect(result.status).toBe('succeeded');
    expect(result.results.map(({ logicalId, status }) => ({ logicalId, status }))).toEqual([
      { logicalId: ID.sA, status: 'restored' },
      { logicalId: ID.sB, status: 'restored' },
    ]);
    expect(result.summary).toEqual({ sessions: 2, windows: 3, panes: 3 });
    const tempCalls = tmux.calls.filter((call) => call.method === 'createTemporarySession');
    expect(tempCalls).toHaveLength(2);
    expect(tempCalls[0].input.windowLogicalId).toBe(ID.wShared);
    expect(tempCalls[1].input.windowLogicalId).toBe(ID.wB);
    expect(tmux.calls.filter((call) => call.input?.windowLogicalId === ID.wShared)).toHaveLength(1);
    expect(tmux.calls).toContainEqual(expect.objectContaining({ method: 'linkWindow', source: tempCalls[0].windowId, target: tempCalls[1].sessionId }));
    expect(tmux.calls.at(-1)).toMatchObject({ method: 'revokeCreatedTargets' });

    const renameIndex = tmux.calls.findIndex((call) => call.method === 'renameCreatedSession' && call.target === tempCalls[0].sessionId);
    const agentIndex = tmux.calls.findIndex((call) => call.method === 'startAgent');
    expect(renameIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(renameIndex);
    expect(tmux.calls[agentIndex]).toMatchObject({ cmd: 'claude', args: ['--resume', ID.agent] });
    expect(progress).toHaveBeenCalledTimes(2);

    const preExisting = new Set(['$90', '@90', '%90']);
    expect(tmux.calls.filter((call) => call.kind === 'mutate').every((call) => !preExisting.has(call.target))).toBe(true);
    expect(result.mapping).toMatchObject({
      names: { alpha: 'alpha', beta: 'beta' },
      runtime: { sessions: { '$1': tempCalls[0].sessionId, '$2': tempCalls[1].sessionId } },
      logical: { windows: { [ID.wShared]: tempCalls[0].windowId } },
    });
  });

  it('kills only the failed temp topology and continues restoring later sessions', async () => {
    const tmux = fakeTmux({ failCreateWindowFor: ID.wA });
    const result = await executeRestore({
      plan: plan([
        { id: ID.sA, name: 'alpha', target: 'alpha' },
        { id: ID.sC, name: 'gamma', target: 'gamma' },
      ]),
      checkpoint: checkpoint(), tmux, agents, access: async () => {}, home: '/home/me',
    });

    expect(result.status).toBe('partial');
    expect(result.results).toMatchObject([
      { logicalId: ID.sA, status: 'failed', stage: 'topology' },
      { logicalId: ID.sC, status: 'restored' },
    ]);
    expect(result.summary).toEqual({ sessions: 1, windows: 1, panes: 1 });
    const temps = tmux.calls.filter((call) => call.method === 'createTemporarySession');
    expect(tmux.calls.filter((call) => call.method === 'killCreatedSession').map((call) => call.target)).toEqual([temps[0].sessionId]);
    expect(tmux.calls).toContainEqual(expect.objectContaining({ method: 'renameCreatedSession', target: temps[1].sessionId, name: 'gamma' }));
  });

  it('reports both topology and cleanup failures instead of leaving a silent partial logical session', async () => {
    const tmux = fakeTmux({ failCreateWindowFor: ID.wA, failCleanup: true });
    const result = await executeRestore({
      plan: plan([{ id: ID.sA, name: 'alpha', target: 'alpha' }]),
      checkpoint: checkpoint(), tmux, agents, access: async () => {}, home: '/home/me',
    });
    expect(result.results[0]).toMatchObject({
      status: 'failed', stage: 'topology', error: expect.stringMatching(/topology failure.*cleanup failure/i),
    });
  });

  it('honours a pre-existing shared-window disposition without laying out or sending to that window', async () => {
    const tmux = fakeTmux();
    const sourcePlan = plan([{ id: ID.sB, name: 'beta', target: 'beta' }]);
    sourcePlan.windows = [
      { logicalId: ID.wShared, action: 'reuse', runtimeId: '@90' },
      { logicalId: ID.wB, action: 'create', ownerSessionId: ID.sB },
    ];
    const result = await executeRestore({ plan: sourcePlan, checkpoint: checkpoint(), tmux, agents, access: async () => {}, home: '/home/me' });

    expect(result.status).toBe('succeeded');
    expect(tmux.calls).toContainEqual(expect.objectContaining({ method: 'linkWindow', source: '@90', options: { existing: true } }));
    expect(tmux.calls.some((call) => call.method === 'applyLayout' && call.target === '@90')).toBe(false);
    expect(tmux.calls.some((call) => call.method === 'startAgent' && call.target === '%90')).toBe(false);
    expect(result.mapping).toMatchObject({
      runtime: { windows: { '@1': '@90' } },
      logical: { windows: { [ID.wShared]: '@90' } },
    });
  });

  it('keeps restored shell/cwd when agent resume fails and never starts ordinary panes', async () => {
    const tmux = fakeTmux({ failAgent: true });
    const source = checkpoint();
    const result = await executeRestore({
      plan: plan(), checkpoint: source, tmux, agents, access: async () => {}, home: '/home/me',
    });

    expect(result.status).toBe('succeeded');
    expect(result.results[0]).toMatchObject({ status: 'restored', warnings: [expect.stringMatching(/agent executable unavailable/i)] });
    expect(tmux.calls.filter((call) => call.method === 'killCreatedSession')).toHaveLength(0);
    expect(tmux.calls.filter((call) => call.method === 'startAgent')).toHaveLength(1);
    expect(tmux.calls.find((call) => call.method === 'startAgent')).toMatchObject({ cmd: 'claude', args: ['--resume', ID.agent] });
  });

  it('shares one executable wait across every pane in the restore and skips launches when it stays unavailable', async () => {
    const tmux = fakeTmux();
    const source = checkpoint();
    source.windows.find((window) => window.id === ID.wB).panes[0].agent = {
      id: 'claude', sessionId: ID.agent, transcriptPath: '/sessions/b.jsonl',
    };
    tmux.waitForAgents = vi.fn((commands) => new Map(commands.map((command) => [
      command,
      Promise.resolve({ status: 'failed', error: `${command} executable unavailable after startup wait` }),
    ])));

    const result = await executeRestore({
      plan: plan(), checkpoint: source, tmux, agents, access: async () => {}, home: '/home/me',
    });

    expect(tmux.waitForAgents).toHaveBeenCalledTimes(1);
    expect(tmux.waitForAgents).toHaveBeenCalledWith(['claude']);
    expect(tmux.calls.filter((call) => call.method === 'startAgent')).toHaveLength(0);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ warnings: [expect.stringMatching(/claude executable.*shell was restored/i)] }),
      expect.objectContaining({ warnings: [expect.stringMatching(/claude executable.*shell was restored/i)] }),
    ]));
  });

  it('still resumes an available Agent when another required executable stays missing', async () => {
    const tmux = fakeTmux();
    const source = checkpoint();
    source.windows.find((window) => window.id === ID.wB).panes[0].agent = {
      id: 'codex', sessionId: ID.agent, transcriptPath: '/sessions/b.jsonl',
    };
    const mixedAgents = [...agents, {
      id: 'codex',
      sessions: {
        isId: (id) => id === ID.agent,
        resumeArgs: (id) => ['codex', 'resume', id],
      },
    }];
    tmux.waitForAgents = vi.fn((commands) => new Map(commands.map((command) => [
      command,
      Promise.resolve(command === 'claude'
        ? { status: 'ready' }
        : { status: 'failed', error: 'codex executable unavailable after startup wait' }),
    ])));

    const result = await executeRestore({
      plan: plan(), checkpoint: source, tmux, agents: mixedAgents, access: async () => {}, home: '/home/me',
    });

    expect(tmux.waitForAgents).toHaveBeenCalledWith(['claude', 'codex']);
    expect(tmux.calls.filter((call) => call.method === 'startAgent')).toEqual([
      expect.objectContaining({ cmd: 'claude', args: ['--resume', ID.agent] }),
    ]);
    expect(result.results[1].warnings).toEqual([
      expect.stringMatching(/codex executable.*shell was restored/i),
    ]);
  });

  it('falls back missing cwd and invalid layout as warnings without failing topology', async () => {
    const tmux = fakeTmux({ failLayout: true });
    const result = await executeRestore({
      plan: plan([{ id: ID.sA, name: 'alpha', target: 'alpha' }]), checkpoint: checkpoint(), tmux, agents,
      access: async (target) => { if (target === '/alpha') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      home: '/home/me',
    });

    expect(result.status).toBe('succeeded');
    expect(result.results[0].warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/alpha.*\/home\/me/i),
      expect.stringMatching(/layout/i),
    ]));
    expect(tmux.calls.some((call) => call.input?.cwd === '/home/me')).toBe(true);
  });

  it('returns already-present on a repeated restore with zero mutations', async () => {
    const tmux = fakeTmux();
    const sourcePlan = plan([
      { id: ID.sA, name: 'alpha', action: 'already-present' },
      { id: ID.sB, name: 'beta', action: 'already-present' },
    ]);
    const result = await executeRestore({ plan: sourcePlan, checkpoint: checkpoint(), tmux, agents });

    expect(result).toMatchObject({ status: 'succeeded', restored: 0, alreadyPresent: 2, failed: 0 });
    expect(result.results.every((row) => row.status === 'already-present')).toBe(true);
    expect(tmux.calls).toEqual([{ kind: 'internal', method: 'revokeCreatedTargets', target: null }]);
  });
});
