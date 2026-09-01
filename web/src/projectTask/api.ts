import { requestJson } from '../apiRequest.js';
import type { Project, ProjectTaskStatus, Task, TaskDraftInput, TaskStatus } from './contracts.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Project response');
  return value as Record<string, unknown>;
}

function project(value: unknown): Project {
  const row = record(value);
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.rootPath !== 'string'
    || typeof row.version !== 'number' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
    throw new Error('Invalid Project response');
  }
  return row as unknown as Project;
}

function task(value: unknown): Task {
  const row = record(value);
  if (typeof row.id !== 'string' || typeof row.projectId !== 'string' || typeof row.title !== 'string'
    || typeof row.version !== 'number' || !Array.isArray(row.acceptanceCriteria)) {
    throw new Error('Invalid Task response');
  }
  return row as unknown as Task;
}

const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function getProjectTaskStatus(): Promise<ProjectTaskStatus> {
  return record(await requestJson('/api/project-task/status')) as unknown as ProjectTaskStatus;
}

export async function listProjects(archived = false): Promise<Project[]> {
  const value = await requestJson(`/api/projects?archived=${archived}`);
  if (!Array.isArray(value)) throw new Error('Invalid Project list');
  return value.map(project);
}

export const getProject = async (id: string): Promise<Project> => (
  project(await requestJson(`/api/projects/${encodeURIComponent(id)}`))
);

export const createProject = async (name: string, rootPath: string): Promise<Project> => (
  project(await requestJson('/api/projects', json('POST', { name, rootPath })))
);

export const renameProject = async (id: string, name: string, expectedVersion: number): Promise<Project> => (
  project(await requestJson(`/api/projects/${encodeURIComponent(id)}`, json('PATCH', { name, expectedVersion })))
);

export const archiveProject = async (id: string, expectedVersion: number): Promise<Project> => (
  project(await requestJson(`/api/projects/${encodeURIComponent(id)}/archive`, json('POST', { expectedVersion })))
);

export async function listTasks(
  projectId: string,
  bucket: 'tasks' | 'drafts' | 'canceled' | 'archived',
): Promise<Task[]> {
  const value = await requestJson(`/api/tasks?projectId=${encodeURIComponent(projectId)}&bucket=${bucket}`);
  if (!Array.isArray(value)) throw new Error('Invalid Task list');
  return value.map(task);
}

export const getTask = async (id: string): Promise<Task> => (
  task(await requestJson(`/api/tasks/${encodeURIComponent(id)}`))
);

export const createTask = async (
  projectId: string,
  input: TaskDraftInput,
  status: Exclude<TaskStatus, 'canceled'>,
): Promise<Task> => task(await requestJson('/api/tasks', json('POST', { projectId, ...input, status })));

export const updateTask = async (id: string, input: TaskDraftInput, expectedVersion: number): Promise<Task> => (
  task(await requestJson(`/api/tasks/${encodeURIComponent(id)}`, json('PATCH', { ...input, expectedVersion })))
);

export const promoteTask = async (id: string, expectedVersion: number): Promise<Task> => (
  task(await requestJson(`/api/tasks/${encodeURIComponent(id)}/promote`, json('POST', { expectedVersion })))
);

export const cancelTask = async (id: string, expectedVersion: number): Promise<Task> => (
  task(await requestJson(`/api/tasks/${encodeURIComponent(id)}/cancel`, json('POST', { expectedVersion })))
);

export const archiveTask = async (id: string, expectedVersion: number): Promise<Task> => (
  task(await requestJson(`/api/tasks/${encodeURIComponent(id)}/archive`, json('POST', { expectedVersion })))
);
