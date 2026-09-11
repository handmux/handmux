export const PROJECT_TASK_SCHEMA_VERSION = 1;

export type ProjectAgent = 'codex' | 'claude';
export type ProjectExecutionMode = 'project-root' | 'worktree';
export type TaskStatus = 'draft' | 'ready' | 'canceled';
export type TaskPriority = 'none' | 'high' | 'medium' | 'low';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  repositoryRoot: string | null;
  defaultAgent: ProjectAgent | null;
  executionMode: ProjectExecutionMode;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReference {
  kind: 'url' | 'path';
  value: string;
  label: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  scope: string | null;
  constraints: string | null;
  references: TaskReference[];
  status: TaskStatus;
  priority: TaskPriority;
  briefVersion: number;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskEventType = 'task.created' | 'task.updated' | 'task.promoted'
  | 'task.canceled' | 'task.archived';

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  actor: 'user' | 'system';
  taskVersion: number;
  briefVersion: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ProjectTaskErrorCode =
  | 'PROJECT_VALIDATION'
  | 'TASK_VALIDATION'
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'PROJECT_ROOT_EXISTS'
  | 'VERSION_CONFLICT'
  | 'TASK_TRANSITION_INVALID'
  | 'PROJECT_STORE_TOO_NEW'
  | 'PROJECT_STORE_LOCKED'
  | 'PROJECT_STORE_CORRUPT'
  | 'PROJECT_STORE_PERMISSION'
  | 'PROJECT_STORE_FULL';

export class ProjectTaskError extends Error {
  readonly code: ProjectTaskErrorCode;
  readonly status: number;

  constructor(code: ProjectTaskErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ProjectTaskError';
    this.code = code;
    this.status = status;
  }
}

function sqlitePrimaryErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('errcode' in error)) return null;
  const value = error.errcode;
  return typeof value === 'number' && Number.isInteger(value) ? value & 0xff : null;
}

export function isProjectDatabaseCorruption(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
  const primary = sqlitePrimaryErrorCode(error);
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || primary === 11 || primary === 26;
}

export function projectStorageError(error: unknown): ProjectTaskError | null {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
  const detail = error instanceof Error ? error.message.toLowerCase() : '';
  const primary = sqlitePrimaryErrorCode(error);
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || primary === 5 || primary === 6) {
    return new ProjectTaskError(
      'PROJECT_STORE_LOCKED',
      503,
      'Project data is temporarily busy; close other processes using it and try again',
    );
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_READONLY' || primary === 8) {
    return new ProjectTaskError(
      'PROJECT_STORE_PERMISSION',
      503,
      'HandMux cannot access Project data; fix ~/.handmux permissions and restart',
    );
  }
  if (code === 'ENOSPC' || code === 'SQLITE_FULL' || primary === 13
    || detail.includes('database or disk is full')) {
    return new ProjectTaskError(
      'PROJECT_STORE_FULL',
      507,
      'The disk is full; free space and try again',
    );
  }
  return null;
}

export function requireTrimmedString(
  value: unknown,
  field: string,
  maximum: number,
  code: 'PROJECT_VALIDATION' | 'TASK_VALIDATION',
): string {
  if (typeof value !== 'string') {
    throw new ProjectTaskError(code, 400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    throw new ProjectTaskError(code, 400, `${field} must contain 1-${maximum} characters`);
  }
  return trimmed;
}

export function requireExpectedVersion(
  value: unknown,
  code: 'PROJECT_VALIDATION' | 'TASK_VALIDATION' = 'PROJECT_VALIDATION',
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectTaskError(code, 400, 'expectedVersion must be a positive integer');
  }
  return value as number;
}
