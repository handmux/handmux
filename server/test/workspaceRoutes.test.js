import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRouter } from '../src/httpApi.js';
import { buildRecoveryMapping } from '../src/workspace/mapping.js';

const auth = (call) => call.set('Authorization', 'Bearer good');
const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_OK = '20000000-0000-4000-8000-000000000001';
const SESSION_FAILED = '20000000-0000-4000-8000-000000000002';
const WINDOW_ID = '20000000-0000-4000-8000-000000000011';
const PANE_ID = '20000000-0000-4000-8000-000000000021';

const mapping = buildRecoveryMapping('checkpoint-a', null, [{
  names: { api: 'api-restored' },
  runtime: { sessions: { '$1': '$10' }, windows: { '@1': '@10' }, panes: { '%1': '%10' } },
  logical: { sessions: { [SESSION_OK]: '$10' }, windows: { [WINDOW_ID]: '@10' }, panes: { [PANE_ID]: '%10' } },
}], () => Date.parse('2026-07-20T02:03:00.000Z'));

function fakeWorkspace(overrides = {}) {
  return {
    getProtectionStatus: vi.fn(async () => ({
      status: 'degraded',
      lastSuccessfulCaptureAt: '2026-07-20T01:00:00.000Z',
      errorCode: 'live-corrupt',
    })),
    listCheckpoints: vi.fn(async () => [
      {
        status: 'ok',
        id: 'checkpoint-a',
        value: {
          capturedAt: '2026-07-20T01:00:00.000Z',
          archivedAt: '2026-07-20T01:01:00.000Z',
          environment: { endedReason: 'boot-changed', bootIdentity: '/Users/secret/boot' },
          sessions: [{ id: SESSION_OK, name: 'api', runtimeId: '$1', cwd: '/Users/secret/session' }],
          windows: [{
            id: WINDOW_ID,
            panes: [
              { id: PANE_ID, cwd: '/Users/secret/project', agent: null },
              {
                id: '20000000-0000-4000-8000-000000000022',
                cwd: '/Users/secret/agent',
                agent: { id: 'claude', sessionId: 'secret-agent-session', transcriptPath: '/Users/secret/transcript.jsonl' },
              },
            ],
          }],
          extra: 'checkpoint-secret-extra',
        },
      },
      { status: 'corrupt', id: 'checkpoint-b', error: '/Users/secret/checkpoint.json stack-secret' },
    ]),
    getRestorePlan: vi.fn(async () => ({
      checkpointId: 'checkpoint-a',
      serverNow: '2026-07-20T02:00:00.000Z',
      expiresAt: '2026-07-20T01:59:59.000Z',
      promptEligible: false,
      pendingCount: 1,
      mapping: { id: 'mapping-a' },
    })),
    startRestore: vi.fn(async () => ({ operationId: 'operation-a', status: 'pending', reused: false })),
    getOperation: vi.fn(async () => null),
    ...overrides,
  };
}

function makeApp(workspace) {
  const app = express();
  app.use('/api', createApiRouter({
    token: 'good',
    commands: {},
    events: { getStates: vi.fn(async () => []) },
    workspace,
  }));
  return app;
}

describe('workspace API routes', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = fakeWorkspace();
    app = makeApp(workspace);
  });

  it('protects every workspace endpoint with bearer authentication', async () => {
    await request(app).get('/api/workspace/status').expect(401, { error: 'unauthorized' });
    await request(app).get('/api/workspace/checkpoints').expect(401, { error: 'unauthorized' });
    await request(app).get('/api/workspace/restore-plan').expect(401, { error: 'unauthorized' });
    await request(app).post('/api/workspace/restore').send({ checkpointId: 'latest' }).expect(401, { error: 'unauthorized' });
    await request(app).get('/api/workspace/restore/operation-a').expect(401, { error: 'unauthorized' });
    expect(workspace.getProtectionStatus).not.toHaveBeenCalled();
    expect(workspace.listCheckpoints).not.toHaveBeenCalled();
    expect(workspace.getRestorePlan).not.toHaveBeenCalled();
    expect(workspace.startRestore).not.toHaveBeenCalled();
    expect(workspace.getOperation).not.toHaveBeenCalled();
  });

  it('returns the current runtime protection status contract', async () => {
    const status = await auth(request(app).get('/api/workspace/status')).expect(200);
    expect(status.body).toEqual({
      status: 'degraded',
      lastSuccessfulCaptureAt: '2026-07-20T01:00:00.000Z',
      errorCode: 'live-corrupt',
    });
  });

  it('projects checkpoint rows to safe diagnostic summaries', async () => {
    const response = await auth(request(app).get('/api/workspace/checkpoints')).expect(200);
    expect(response.body).toEqual([
      {
        status: 'ok',
        id: 'checkpoint-a',
        capturedAt: '2026-07-20T01:00:00.000Z',
        archivedAt: '2026-07-20T01:01:00.000Z',
        sessionCount: 1,
        windowCount: 1,
        paneCount: 2,
        agentCount: 1,
        endedReason: 'boot-changed',
        errorCode: null,
      },
      {
        status: 'corrupt',
        id: 'checkpoint-b',
        capturedAt: null,
        archivedAt: null,
        sessionCount: 0,
        windowCount: 0,
        paneCount: 0,
        agentCount: 0,
        endedReason: null,
        errorCode: 'checkpoint-corrupt',
      },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/Users|secret|cwd|transcript|sessionId|bootIdentity|stack|extra/);
  });

  it('requests latest by default and preserves the runtime-authored clock, eligibility, and mapping', async () => {
    const response = await auth(request(app).get('/api/workspace/restore-plan')).expect(200);
    expect(workspace.getRestorePlan).toHaveBeenCalledWith({ checkpointId: 'latest' });
    expect(response.body).toMatchObject({
      serverNow: '2026-07-20T02:00:00.000Z',
      expiresAt: '2026-07-20T01:59:59.000Z',
      promptEligible: false,
      pendingCount: 1,
      mapping: { id: 'mapping-a' },
    });
  });

  it('accepts an explicit safe checkpoint id', async () => {
    await auth(request(app).get('/api/workspace/restore-plan?checkpoint=checkpoint-2')).expect(200);
    expect(workspace.getRestorePlan).toHaveBeenCalledWith({ checkpointId: 'checkpoint-2' });
  });

  it('rejects malformed checkpoint ids before calling the runtime', async () => {
    await auth(request(app).get('/api/workspace/restore-plan?checkpoint=../../secret'))
      .expect(400, { error: 'bad checkpoint id' });
    expect(workspace.getRestorePlan).not.toHaveBeenCalled();
  });

  it('returns 404 for a checkpoint the runtime cannot find', async () => {
    const error = Object.assign(new Error('/private/home/.handmux/checkpoints/missing.json'), {
      code: 'WORKSPACE_CHECKPOINT_NOT_FOUND',
    });
    workspace.getRestorePlan.mockRejectedValueOnce(error);
    await auth(request(app).get('/api/workspace/restore-plan?checkpoint=missing'))
      .expect(404, { error: 'checkpoint not found' });
  });

  it('starts a validated restore asynchronously with HTTP 202', async () => {
    const response = await auth(request(app).post('/api/workspace/restore'))
      .send({ checkpointId: 'latest', sessions: ['api', 'web'] })
      .expect(202);
    expect(response.body).toEqual({ operationId: 'operation-a', status: 'pending', reused: false });
    expect(workspace.startRestore).toHaveBeenCalledTimes(1);
    expect(workspace.startRestore).toHaveBeenCalledWith({ checkpointId: 'latest', sessions: ['api', 'web'] });
  });

  it('rejects invalid restore bodies without starting an operation', async () => {
    for (const body of [
      { checkpointId: '../../secret' },
      { checkpointId: 'latest', sessions: 'api' },
      { checkpointId: 'latest', sessions: [''] },
      { checkpointId: 'latest', historical: true },
    ]) {
      await auth(request(app).post('/api/workspace/restore')).send(body).expect(400, { error: 'bad request' });
    }
    expect(workspace.startRestore).not.toHaveBeenCalled();
  });

  it('returns the same runtime operation for a repeated double tap', async () => {
    workspace.startRestore
      .mockResolvedValueOnce({ operationId: 'operation-a', status: 'pending', reused: false })
      .mockResolvedValueOnce({ operationId: 'operation-a', status: 'running', reused: true });
    const first = await auth(request(app).post('/api/workspace/restore')).send({ checkpointId: 'latest' }).expect(202);
    const second = await auth(request(app).post('/api/workspace/restore')).send({ checkpointId: 'latest' }).expect(202);
    expect(first.body.operationId).toBe('operation-a');
    expect(second.body).toMatchObject({ operationId: 'operation-a', reused: true });
  });

  it('returns persisted terminal operation state and 404 for an unknown operation', async () => {
    workspace.getOperation
      .mockResolvedValueOnce({
        id: OPERATION_ID,
        kind: 'workspace-restore',
        status: 'partial',
        request: { checkpointId: 'checkpoint-a', sessions: ['api', 'web'], historical: false, extra: '/Users/secret/request' },
        requestHash: 'secret-request-hash',
        ownerPid: 4242,
        createdAt: '2026-07-20T02:00:00.000Z',
        updatedAt: '2026-07-20T02:03:00.000Z',
        startedAt: '2026-07-20T02:01:00.000Z',
        completedAt: '2026-07-20T02:03:00.000Z',
        progress: { completed: 2, total: 2, extra: 'progress-secret' },
        results: [
          {
            logicalId: SESSION_OK,
            sourceName: 'api',
            targetName: 'api-restored',
            status: 'restored',
            warnings: ['/Users/secret/project was missing'],
            cwd: '/Users/secret/project',
            transcriptPath: '/Users/secret/transcript.jsonl',
            extra: 'result-secret-extra',
          },
          {
            logicalId: SESSION_FAILED,
            sourceName: 'web',
            status: 'failed',
            stage: 'topology',
            error: 'tmux command failed at /Users/secret/project; stack-secret',
            stack: 'Error: stack-secret at /Users/secret/source.js',
          },
        ],
        error: 'tmux command failed at /Users/secret/project; raw-error-secret',
        warnings: ['live reconcile failed: EACCES /Users/secret/live.json'],
        mapping,
        cwd: '/Users/secret/top-level',
        transcriptPath: '/Users/secret/top-level.jsonl',
        extra: 'operation-secret-extra',
      })
      .mockResolvedValueOnce(null);
    const terminal = await auth(request(app).get(`/api/workspace/restore/${OPERATION_ID}`)).expect(200);
    expect(terminal.body).toEqual({
      id: OPERATION_ID,
      status: 'partial',
      request: { checkpointId: 'checkpoint-a', sessions: ['api', 'web'], historical: false },
      createdAt: '2026-07-20T02:00:00.000Z',
      updatedAt: '2026-07-20T02:03:00.000Z',
      startedAt: '2026-07-20T02:01:00.000Z',
      completedAt: '2026-07-20T02:03:00.000Z',
      progress: { completed: 2, total: 2 },
      results: [
        {
          logicalId: SESSION_OK,
          sourceName: 'api',
          targetName: 'api-restored',
          status: 'restored',
          stage: null,
          errorCode: null,
          errorMessage: null,
          warningCodes: ['restore-warning'],
        },
        {
          logicalId: SESSION_FAILED,
          sourceName: 'web',
          targetName: null,
          status: 'failed',
          stage: 'topology',
          errorCode: 'tmux-unavailable',
          errorMessage: 'tmux is unavailable; retry the restore',
          warningCodes: [],
        },
      ],
      errorCode: 'tmux-unavailable',
      errorMessage: 'tmux is unavailable; retry the restore',
      warningCodes: ['live-reconcile-failed'],
      mapping,
    });
    expect(JSON.stringify(terminal.body)).not.toMatch(/Users|secret|ownerPid|requestHash|cwd|transcript|stack|raw-error|extra|EACCES/);
    await auth(request(app).get('/api/workspace/restore/operation-missing'))
      .expect(404, { error: 'operation not found' });
  });

  it('drops an operation mapping that does not pass the Task 7 validator', async () => {
    workspace.getOperation.mockResolvedValueOnce({
      id: OPERATION_ID,
      status: 'succeeded',
      request: { checkpointId: 'checkpoint-a', sessions: [], historical: false },
      progress: { completed: 0, total: 0 },
      results: [],
      mapping: { ...mapping, transcriptPath: '/Users/secret/transcript.jsonl' },
    });
    const response = await auth(request(app).get(`/api/workspace/restore/${OPERATION_ID}`)).expect(200);
    expect(response.body.mapping).toBeNull();
    expect(JSON.stringify(response.body)).not.toMatch(/Users|secret|transcript/);
  });

  it('rejects malformed operation ids before touching persisted storage', async () => {
    await auth(request(app).get('/api/workspace/restore/bad%20operation'))
      .expect(400, { error: 'bad operation id' });
    expect(workspace.getOperation).not.toHaveBeenCalled();
  });

  it('redacts unexpected workspace errors instead of exposing paths or stack details', async () => {
    workspace.getProtectionStatus.mockRejectedValueOnce(new Error('/Users/me/.handmux secret-token EACCES'));
    const response = await auth(request(app).get('/api/workspace/status')).expect(500);
    expect(response.body).toEqual({ error: 'workspace unavailable' });
    expect(response.text).not.toContain('/Users/me');
    expect(response.text).not.toContain('secret-token');
  });

  it('does not mount workspace routes when no runtime was injected', async () => {
    await auth(request(makeApp(undefined)).get('/api/workspace/status')).expect(404);
  });
});

describe('workspace production composition', () => {
  it('wraps the background checkpointer in the unified runtime used by events and API', () => {
    const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    expect(source).toContain("import { createWorkspaceRuntime } from './workspace/runtime.js';");
    expect(source).toMatch(/const workspaceBackground = createWorkspaceBackground\(/);
    expect(source).toMatch(/const workspace = createWorkspaceRuntime\(\{[\s\S]*checkpointer: workspaceBackground/);
    expect(source).toContain('onStateChange: workspace.requestReconcile');
    expect(source).toContain('createApiRouter({ token, events, uploadExts, previews, previewDomain, workspace })');
  });
});
