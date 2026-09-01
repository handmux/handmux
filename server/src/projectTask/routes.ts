import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import { PublicApiError } from '../apiErrors.js';
import type { ProjectTaskRuntime } from './runtime.js';
import { ProjectTaskError, projectStorageError } from './schema.js';

function bodyRecord(
  value: unknown,
  code: 'PROJECT_VALIDATION' | 'TASK_VALIDATION' = 'PROJECT_VALIDATION',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectTaskError(code, 400, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function onlyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  code: 'PROJECT_VALIDATION' | 'TASK_VALIDATION' = 'PROJECT_VALIDATION',
): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ProjectTaskError(code, 400, `${unexpected} cannot be changed here`);
  }
}

function forward(error: unknown, next: NextFunction): void {
  const safe = error instanceof ProjectTaskError ? error : projectStorageError(error);
  if (safe) {
    next(new PublicApiError(safe.status, safe.code, safe.message));
  } else {
    next(error);
  }
}

export function projectTaskRoutes({ runtime }: { runtime: ProjectTaskRuntime }): Router {
  const router = express.Router();

  router.get('/project-task/status', (_req: Request, res: Response) => {
    res.json(runtime.status());
  });

  router.get('/projects', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const archived = req.query.archived === 'true';
      res.json(await runtime.requireStore().listProjects({ archived }));
    } catch (error) { forward(error, next); }
  });

  router.post('/projects', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = bodyRecord(req.body);
      onlyFields(body, ['name', 'rootPath']);
      const project = await runtime.requireStore().createProject({
        name: body.name,
        rootPath: body.rootPath,
      });
      res.status(201).json(project);
    } catch (error) { forward(error, next); }
  });

  router.get('/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runtime.requireStore().getProject(req.params.id ?? ''));
    } catch (error) { forward(error, next); }
  });

  router.patch('/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = bodyRecord(req.body);
      onlyFields(body, ['name', 'expectedVersion']);
      res.json(await runtime.requireStore().updateProject(req.params.id ?? '', {
        name: body.name,
        expectedVersion: body.expectedVersion,
      }));
    } catch (error) { forward(error, next); }
  });

  router.post('/projects/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = bodyRecord(req.body);
      onlyFields(body, ['expectedVersion']);
      res.json(await runtime.requireStore().archiveProject(req.params.id ?? '', {
        expectedVersion: body.expectedVersion,
      }));
    } catch (error) { forward(error, next); }
  });

  router.get('/tasks', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runtime.requireStore().listTasks({
        projectId: req.query.projectId,
        bucket: req.query.bucket,
      }));
    } catch (error) { forward(error, next); }
  });

  router.post('/tasks', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = bodyRecord(req.body, 'TASK_VALIDATION');
      onlyFields(body, [
        'projectId', 'title', 'objective', 'acceptanceCriteria', 'scope', 'constraints',
        'references', 'status', 'priority',
      ], 'TASK_VALIDATION');
      res.status(201).json(await runtime.requireStore().createTask(body));
    } catch (error) { forward(error, next); }
  });

  router.get('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runtime.requireStore().getTask(req.params.id ?? ''));
    } catch (error) { forward(error, next); }
  });

  router.patch('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = bodyRecord(req.body, 'TASK_VALIDATION');
      onlyFields(body, [
        'title', 'objective', 'acceptanceCriteria', 'scope', 'constraints', 'references',
        'priority', 'expectedVersion',
      ], 'TASK_VALIDATION');
      res.json(await runtime.requireStore().updateTask(req.params.id ?? '', body));
    } catch (error) { forward(error, next); }
  });

  const taskCommand = (
    command: 'promoteTask' | 'cancelTask' | 'archiveTask',
  ) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = bodyRecord(req.body, 'TASK_VALIDATION');
      onlyFields(body, ['expectedVersion'], 'TASK_VALIDATION');
      res.json(await runtime.requireStore()[command](req.params.id ?? '', {
        expectedVersion: body.expectedVersion,
      }));
    } catch (error) { forward(error, next); }
  };

  router.post('/tasks/:id/promote', taskCommand('promoteTask'));
  router.post('/tasks/:id/cancel', taskCommand('cancelTask'));
  router.post('/tasks/:id/archive', taskCommand('archiveTask'));

  router.get('/tasks/:id/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await runtime.requireStore().listTaskEvents(req.params.id ?? ''));
    } catch (error) { forward(error, next); }
  });

  return router;
}
