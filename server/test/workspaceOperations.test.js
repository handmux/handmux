import { describe, expect, it, vi } from 'vitest';
import { createOperationManager } from '../src/workspace/operations.js';
import { createWorkspaceRuntime } from '../src/workspace/runtime.js';

const UUIDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function operationStore(seed = []) {
  const values = new Map(seed.map((value) => [value.id, structuredClone(value)]));
  const writes = [];
  return {
    values,
    writes,
    async writeOperation(value) { values.set(value.id, structuredClone(value)); writes.push(structuredClone(value)); return value; },
    async readOperation(id) { return values.has(id) ? { status: 'ok', value: structuredClone(values.get(id)) } : { status: 'missing' }; },
    async listOperations() { return [...values.values()].map((value) => ({ status: 'ok', id: value.id, value: structuredClone(value) })); },
  };
}

describe('workspace operation persistence', () => {
  it('persists pending, running and a successful terminal result while deduplicating the running request', async () => {
    const store = operationStore();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const manager = createOperationManager({ store, now: () => 1_000, randomUUID: () => UUIDS[0], pid: 77 });
    const runner = vi.fn(async ({ onProgress }) => {
      await onProgress({ completed: 1, total: 2, result: { logicalId: 's-a', status: 'restored' } });
      await gate;
      return { status: 'succeeded', results: [{ logicalId: 's-a', status: 'restored' }], mapping: { id: 'map-a' } };
    });

    const first = await manager.start({ checkpointId: 'cp-a', sessions: ['b', 'a', 'a'] }, runner);
    const duplicate = await manager.start({ sessions: ['a', 'b'], checkpointId: 'cp-a' }, runner);
    expect(duplicate).toMatchObject({ operationId: first.operationId, reused: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(store.writes.map((row) => row.status)).toEqual(expect.arrayContaining(['pending', 'running']));

    release();
    await flush();
    expect((await manager.get(first.operationId)).status).toBe('succeeded');
    expect(store.writes.at(-1)).toMatchObject({ status: 'succeeded', results: [{ logicalId: 's-a', status: 'restored' }], mapping: { id: 'map-a' } });
  });

  it.each([
    ['partial', { status: 'partial', results: [{ status: 'restored' }, { status: 'failed' }] }],
    ['failed', { status: 'failed', results: [{ status: 'failed' }] }],
  ])('persists %s terminal state', async (status, result) => {
    const store = operationStore();
    const manager = createOperationManager({ store, now: () => 2_000, randomUUID: () => UUIDS[1] });
    const started = await manager.start({ checkpointId: 'cp-a' }, async () => result);
    await flush();
    expect(await manager.get(started.operationId)).toMatchObject({ status, results: result.results });
  });

  it('marks orphaned pending/running operations interrupted and preserves completed results', async () => {
    const seed = [
      { id: UUIDS[0], status: 'running', requestHash: 'a', results: [{ logicalId: 's-ok', status: 'restored' }], updatedAt: 'old' },
      { id: UUIDS[1], status: 'succeeded', requestHash: 'b', results: [], updatedAt: 'old' },
    ];
    const store = operationStore(seed);
    const manager = createOperationManager({ store, now: () => 3_000 });

    expect(await manager.interruptOrphans()).toBe(1);
    expect(store.values.get(UUIDS[0])).toMatchObject({ status: 'interrupted', results: seed[0].results });
    expect(store.values.get(UUIDS[1]).status).toBe('succeeded');
  });

  it('releases request deduplication when persisting running state fails', async () => {
    const store = operationStore();
    const write = store.writeOperation;
    let failRunning = true;
    store.writeOperation = async (operation) => {
      if (operation.status === 'running' && failRunning) {
        failRunning = false;
        throw new Error('disk full');
      }
      return write(operation);
    };
    const ids = [...UUIDS];
    const manager = createOperationManager({ store, randomUUID: () => ids.shift() });
    const runner = vi.fn(async () => ({ status: 'succeeded', results: [] }));

    const first = await manager.start({ checkpointId: 'cp-a' }, runner);
    await flush();
    expect((await manager.get(first.operationId)).status).toBe('failed');
    const retry = await manager.start({ checkpointId: 'cp-a' }, runner);
    await flush();
    expect(retry).toMatchObject({ reused: false });
    expect(retry.operationId).not.toBe(first.operationId);
    expect(runner).toHaveBeenCalledTimes(1);
    expect((await manager.get(retry.operationId)).status).toBe('succeeded');
  });
});

function workspaceFixture({ recoveryPending = ['s-ok', 's-fail', 's-already'] } = {}) {
  const checkpoint = {
    id: 'cp-a', capturedAt: '2026-07-20T01:00:00.000Z', archivedAt: '2026-07-20T01:01:00.000Z',
    environment: { endedReason: 'boot-changed' }, active: null,
    sessions: [
      { id: 's-ok', runtimeId: '$1', name: 'api', windowLinks: [{ windowId: 'w-ok', index: 0 }], activeWindowId: 'w-ok' },
      { id: 's-fail', runtimeId: '$2', name: 'fail', windowLinks: [{ windowId: 'w-fail', index: 0 }], activeWindowId: 'w-fail' },
      { id: 's-already', runtimeId: '$3', name: 'docs', windowLinks: [{ windowId: 'w-already', index: 0 }], activeWindowId: 'w-already' },
    ],
    windows: [
      { id: 'w-ok', runtimeId: '@1', name: 'ok', index: 0, layout: 'x', activePaneId: 'p-ok', panes: [{ id: 'p-ok', runtimeId: '%1', index: 0, cwd: '/ok', agent: null }] },
      { id: 'w-fail', runtimeId: '@2', name: 'fail', index: 0, layout: 'x', activePaneId: 'p-fail', panes: [{ id: 'p-fail', runtimeId: '%2', index: 0, cwd: '/fail', agent: null }] },
      { id: 'w-already', runtimeId: '@3', name: 'docs', index: 0, layout: 'x', activePaneId: 'p-already', panes: [{ id: 'p-already', runtimeId: '%3', index: 0, cwd: '/docs', agent: null }] },
    ],
  };
  const recovery = {
    checkpointId: 'cp-a', detectedAt: '2026-07-20T02:00:00.000Z', expiresAt: '2026-07-20T03:00:00.000Z',
    initialSessionIds: checkpoint.sessions.map((session) => session.id), pendingSessionIds: recoveryPending,
    resolvedAt: recoveryPending.length ? null : '2026-07-20T02:30:00.000Z', mapping: null,
  };
  const operations = operationStore();
  const store = {
    ...operations,
    readLatestCheckpoint: vi.fn(async () => ({ status: 'ok', value: checkpoint })),
    readCheckpoint: vi.fn(async () => ({ status: 'ok', value: checkpoint })),
    readRecovery: vi.fn(async () => ({ status: 'ok', value: recovery })),
    listCheckpoints: vi.fn(async () => []),
    resolveSessions: vi.fn(async () => ({ status: 'ok', value: recovery })),
    mergeRecoveryMapping: vi.fn(async (_id, mapping) => ({ status: 'ok', value: { ...recovery, mapping } })),
    archiveEnvironment: vi.fn(),
  };
  return { checkpoint, recovery, store };
}

describe('workspace runtime orchestration', () => {
  it('replans under the filesystem lock, resolves only successful/already sessions, persists mapping, and only reconciles live', async () => {
    const { store } = workspaceFixture();
    const captures = [
      { status: 'ok', sessions: [], windows: [] },
      { status: 'ok', sessions: [{ id: 'new', runtimeId: '$90', name: 'api' }, { id: 's-already', runtimeId: '$91', name: 'docs' }], windows: [] },
    ];
    const tmux = { captureTopology: vi.fn(async () => captures.shift() || captures.at(-1)) };
    const lock = { withLock: vi.fn(async (_owner, fn) => fn()) };
    const checkpointer = {
      start: vi.fn(async () => {}), stop: vi.fn(async () => {}), requestReconcile: vi.fn(), confirmEmpty: vi.fn(),
      reconcile: vi.fn(async () => ({ status: 'written' })),
    };
    const executor = vi.fn(async ({ plan }) => ({
      status: 'partial',
      results: plan.sessions.map((item) => item.logicalId === 's-fail'
        ? { logicalId: item.logicalId, status: 'failed' }
        : { logicalId: item.logicalId, sourceName: item.sourceName, targetName: item.targetName, status: item.action === 'already-present' ? 'already-present' : 'restored' }),
      mapping: { names: { api: 'api-restored' }, runtime: { sessions: { '$1': '$10' }, windows: {}, panes: {} }, logical: { sessions: { 's-ok': '$10' }, windows: {}, panes: {} } },
    }));
    const runtime = createWorkspaceRuntime({ store, tmux, lock, checkpointer, executor, now: () => Date.parse('2026-07-20T02:10:00.000Z'), randomUUID: () => UUIDS[2] });

    const preview = await runtime.getRestorePlan({ checkpointId: 'latest' });
    expect(preview.sessions.find((item) => item.logicalId === 's-ok').targetName).toBe('api');

    const { operationId } = await runtime.startRestore({ checkpointId: 'latest' });
    await flush();
    const operation = await runtime.getOperation(operationId);
    expect(operation.status).toBe('partial');
    expect(executor.mock.calls[0][0].plan.sessions.find((item) => item.logicalId === 's-ok').targetName).toBe('api-restored');
    expect(store.resolveSessions).toHaveBeenCalledWith('cp-a', ['s-ok', 's-already']);
    expect(store.mergeRecoveryMapping).toHaveBeenCalledWith('cp-a', expect.objectContaining({ id: expect.any(String), checkpointId: 'cp-a' }));
    expect(checkpointer.reconcile).toHaveBeenCalledWith('restore-complete');
    expect(store.archiveEnvironment).not.toHaveBeenCalled();
  });

  it('keeps globally resolved default restores empty but historical restores may replan missing sessions', async () => {
    const { store } = workspaceFixture({ recoveryPending: [] });
    const tmux = { captureTopology: vi.fn(async () => ({ status: 'ok', sessions: [], windows: [] })) };
    const executor = vi.fn(async ({ plan }) => ({ status: 'succeeded', results: plan.sessions.map((item) => ({ logicalId: item.logicalId, status: 'restored' })), mapping: null }));
    const runtime = createWorkspaceRuntime({
      store, tmux, lock: { withLock: async (_owner, fn) => fn() },
      checkpointer: { start: async () => {}, stop: async () => {}, requestReconcile() {}, confirmEmpty() {}, reconcile: async () => ({}) },
      executor, randomUUID: (() => { const values = [...UUIDS]; return () => values.shift(); })(),
    });

    await runtime.restoreNow({ checkpointId: 'latest' });
    await runtime.restoreNow({ checkpointId: 'cp-a', historical: true });
    expect(executor.mock.calls[0][0].plan.sessions).toEqual([]);
    expect(executor.mock.calls[1][0].plan.sessions).toHaveLength(3);
  });

  it('keeps a successful restore terminal when the follow-up live reconcile fails', async () => {
    const { store } = workspaceFixture({ recoveryPending: [] });
    const runtime = createWorkspaceRuntime({
      store,
      tmux: { captureTopology: async () => ({ status: 'ok', sessions: [], windows: [] }) },
      lock: { withLock: async (_owner, fn) => fn() },
      checkpointer: {
        start: async () => {}, stop: async () => {}, requestReconcile() {}, confirmEmpty() {},
        reconcile: async () => { throw new Error('live write failed'); },
      },
      executor: async () => ({ status: 'succeeded', results: [], mapping: null }),
      randomUUID: () => UUIDS[0],
    });

    expect(await runtime.restoreNow({ checkpointId: 'latest' })).toMatchObject({
      status: 'succeeded', warnings: [expect.stringMatching(/reconcile.*live write failed/i)],
    });
  });
});
