import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import request, { type Test } from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApiRouter } from '../src/httpApi.js';
import { createProjectTaskRuntime } from '../src/projectTask/runtime.js';
import type { ProjectTaskRuntime } from '../src/projectTask/runtime.js';
import { tmpHome } from './tmphome.js';

const auth = (value: Test): Test => value.set('Authorization', 'Bearer good');

function appWith(projectTask: Awaited<ReturnType<typeof createProjectTaskRuntime>>) {
  const app = express();
  app.use('/api', createApiRouter({ token: 'good', projectTask }));
  return app;
}

describe('Project Task API', () => {
  it('keeps status and Project persistence behind existing authentication', async () => {
    const home = tmpHome('hm-project-api-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({ home });
    const app = appWith(runtime);

    await request(app).get('/api/project-task/status').expect(401);
    await auth(request(app).get('/api/project-task/status')).expect(200, {
      status: 'ready',
      schemaVersion: 1,
    });
    const created = await auth(request(app).post('/api/projects'))
      .send({ name: 'HandMux', rootPath: root })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'HandMux', rootPath: await fsp.realpath(root), version: 1 });
    await auth(request(app).get('/api/projects')).expect(200, [created.body]);

    const renamed = await auth(request(app).patch(`/api/projects/${created.body.id}`))
      .send({ name: 'HandMux Next', expectedVersion: 1 })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'HandMux Next', version: 2 });
    const stale = await auth(request(app).patch(`/api/projects/${created.body.id}`))
      .send({ name: 'Old page', expectedVersion: 1 })
      .expect(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', requestId: expect.any(String) });

    const quickTask = await auth(request(app).post('/api/tasks'))
      .send({
        projectId: created.body.id,
        title: 'Fix conversation loading',
        objective: 'Fix conversation loading and add regression coverage',
        status: 'ready',
      })
      .expect(201);
    expect(quickTask.body).toMatchObject({ status: 'ready', acceptanceCriteria: [] });

    const draft = await auth(request(app).post('/api/tasks'))
      .send({ projectId: created.body.id, title: 'Login copy', status: 'draft' })
      .expect(201);
    const edited = await auth(request(app).patch(`/api/tasks/${draft.body.id}`))
      .send({ objective: 'Explain the failure', acceptanceCriteria: ['Message is actionable'], expectedVersion: 1 })
      .expect(200);
    const promoted = await auth(request(app).post(`/api/tasks/${draft.body.id}/promote`))
      .send({ expectedVersion: edited.body.version })
      .expect(200);
    expect(promoted.body).toMatchObject({ id: draft.body.id, status: 'ready', version: 3 });
    const ready = await auth(request(app).get(`/api/tasks?projectId=${created.body.id}&bucket=tasks`)).expect(200);
    expect(ready.body).toEqual(expect.arrayContaining([quickTask.body, promoted.body]));
    const events = await auth(request(app).get(`/api/tasks/${draft.body.id}/events`)).expect(200);
    expect(events.body.map((event: { type: string }) => event.type)).toEqual([
      'task.created', 'task.updated', 'task.promoted',
    ]);

    await runtime.close();
  });

  it('rejects generic status mutation and leaves Session routes reachable when the store is locked', async () => {
    const home = tmpHome('hm-project-api-lock-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const owner = await createProjectTaskRuntime({ home });
    const locked = await createProjectTaskRuntime({ home });
    const app = appWith(locked);

    const status = await auth(request(app).get('/api/project-task/status')).expect(200);
    expect(status.body).toMatchObject({ status: 'unavailable', error: { code: 'PROJECT_STORE_LOCKED' } });
    const unavailable = await auth(request(app).get('/api/projects')).expect(503);
    expect(unavailable.body).toMatchObject({ code: 'PROJECT_STORE_LOCKED' });
    await auth(request(app).get('/api/sessions')).expect(200);

    const project = await owner.requireStore().createProject({ name: 'Owner', rootPath: root });
    const mutation = await auth(request(appWith(owner)).patch(`/api/projects/${project.id}`))
      .send({ status: 'ready', expectedVersion: 1 })
      .expect(400);
    expect(mutation.body).toMatchObject({ code: 'PROJECT_VALIDATION' });
    const task = await owner.requireStore().createTask({ projectId: project.id, title: 'Draft', status: 'draft' });
    const taskMutation = await auth(request(appWith(owner)).patch(`/api/tasks/${task.id}`))
      .send({ status: 'ready', expectedVersion: 1 })
      .expect(400);
    expect(taskMutation.body).toMatchObject({ code: 'TASK_VALIDATION' });

    await locked.close();
    await owner.close();
  });

  it.each([
    ['SQLITE_FULL', 507, 'PROJECT_STORE_FULL'],
    ['EACCES', 503, 'PROJECT_STORE_PERMISSION'],
  ])('maps %s writes to an actionable public error without hiding Session routes', async (code, status, publicCode) => {
    const runtime = {
      status: () => ({ status: 'ready' as const, schemaVersion: 1 }),
      requireStore: () => ({
        createProject: async () => { throw Object.assign(new Error(code), { code }); },
      }),
      close: async () => {},
    } as unknown as ProjectTaskRuntime;
    const app = appWith(runtime);
    const response = await auth(request(app).post('/api/projects'))
      .send({ name: 'Project', rootPath: '/tmp/project' })
      .expect(status);
    expect(response.body).toMatchObject({ code: publicCode, requestId: expect.any(String) });
    await auth(request(app).get('/api/sessions')).expect(200);
  });
});
