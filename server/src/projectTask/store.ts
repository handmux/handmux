import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { DatabaseSync, StatementResultingChanges } from 'node:sqlite';
import {
  ProjectTaskError,
  requireExpectedVersion,
  requireTrimmedString,
} from './schema.js';
import type { Project } from './schema.js';
import type {
  Task,
  TaskEvent,
  TaskPriority,
  TaskReference,
  TaskStatus,
} from './schema.js';

interface ProjectRow extends Record<string, unknown> {
  id: string;
  name: string;
  root_path: string;
  repository_root: string | null;
  default_agent: 'codex' | 'claude' | null;
  execution_mode: 'project-root' | 'worktree';
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  title: string;
  objective: string;
  acceptance_criteria_json: string;
  scope: string | null;
  constraints: string | null;
  references_json: string;
  status: TaskStatus;
  priority: TaskPriority;
  brief_version: number;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskEventRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  type: TaskEvent['type'];
  actor: TaskEvent['actor'];
  task_version: number;
  brief_version: number;
  payload_json: string;
  created_at: string;
}

export interface ProjectTaskStoreOptions {
  realpath?: (path: string) => Promise<string>;
  isDirectory?: (path: string) => Promise<boolean>;
  resolveRepositoryRoot?: (path: string) => Promise<string | null>;
  randomUUID?: () => string;
  now?: () => Date;
  onSuccessfulWrite?: () => void | Promise<void>;
}

export interface ProjectTaskStore {
  listProjects(options?: { archived?: boolean }): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: { name?: unknown; rootPath?: unknown }): Promise<Project>;
  updateProject(id: string, input: { name?: unknown; expectedVersion?: unknown }): Promise<Project>;
  archiveProject(id: string, input: { expectedVersion?: unknown }): Promise<Project>;
  listTasks(options: { projectId?: unknown; bucket?: unknown }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: Record<string, unknown>): Promise<Task>;
  updateTask(id: string, input: Record<string, unknown>): Promise<Task>;
  promoteTask(id: string, input: { expectedVersion?: unknown }): Promise<Task>;
  cancelTask(id: string, input: { expectedVersion?: unknown }): Promise<Task>;
  archiveTask(id: string, input: { expectedVersion?: unknown }): Promise<Task>;
  listTaskEvents(id: string): Promise<TaskEvent[]>;
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    repositoryRoot: row.repository_root,
    defaultAgent: row.default_agent,
    executionMode: row.execution_mode,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOf(value: unknown): ProjectRow | null {
  return value && typeof value === 'object' ? value as ProjectRow : null;
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    objective: row.objective,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    scope: row.scope,
    constraints: row.constraints,
    references: JSON.parse(row.references_json) as TaskReference[],
    status: row.status,
    priority: row.priority,
    briefVersion: row.brief_version,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskEventFromRow(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    actor: row.actor,
    taskVersion: row.task_version,
    briefVersion: row.brief_version,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

const TASK_PRIORITIES = new Set<TaskPriority>(['none', 'high', 'medium', 'low']);
const BRIEF_FIELDS = ['title', 'objective', 'acceptanceCriteria', 'scope', 'constraints', 'references'] as const;

function optionalText(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ProjectTaskError('TASK_VALIDATION', 400, `${field} must be text or null`);
  }
  return value.trim() || null;
}

function objective(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new ProjectTaskError('TASK_VALIDATION', 400, 'objective must be text');
  }
  return value.trim();
}

function acceptanceCriteria(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ProjectTaskError('TASK_VALIDATION', 400, 'acceptanceCriteria must be a list of text items');
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function references(value: unknown): TaskReference[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ProjectTaskError('TASK_VALIDATION', 400, 'references must be a list');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProjectTaskError('TASK_VALIDATION', 400, 'each reference must be an object');
    }
    const record = item as Record<string, unknown>;
    if (record.kind !== 'url' && record.kind !== 'path') {
      throw new ProjectTaskError('TASK_VALIDATION', 400, 'reference kind must be url or path');
    }
    if (typeof record.value !== 'string' || !record.value.trim()) {
      throw new ProjectTaskError('TASK_VALIDATION', 400, 'reference value is required');
    }
    if (record.label != null && typeof record.label !== 'string') {
      throw new ProjectTaskError('TASK_VALIDATION', 400, 'reference label must be text or null');
    }
    return {
      kind: record.kind,
      value: record.value.trim(),
      label: typeof record.label === 'string' ? record.label.trim() || null : null,
    };
  });
}

function priority(value: unknown): TaskPriority {
  const result = value ?? 'none';
  if (typeof result !== 'string' || !TASK_PRIORITIES.has(result as TaskPriority)) {
    throw new ProjectTaskError('TASK_VALIDATION', 400, 'priority is invalid');
  }
  return result as TaskPriority;
}

function status(value: unknown): Exclude<TaskStatus, 'canceled'> {
  if (value !== 'draft' && value !== 'ready') {
    throw new ProjectTaskError('TASK_VALIDATION', 400, 'status must be draft or ready');
  }
  return value;
}

function validateReady(task: Pick<Task, 'title' | 'objective'>): void {
  if (!task.objective) {
    throw new ProjectTaskError(
      'TASK_VALIDATION',
      400,
      'A task needs a goal',
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createProjectTaskStore(
  db: DatabaseSync,
  {
    realpath = fsp.realpath,
    isDirectory = async (target) => (await fsp.stat(target)).isDirectory(),
    resolveRepositoryRoot = async () => null,
    randomUUID = crypto.randomUUID,
    now = () => new Date(),
    onSuccessfulWrite = () => {},
  }: ProjectTaskStoreOptions = {},
): ProjectTaskStore {
  const selectProject = db.prepare(`
    SELECT id, name, root_path, repository_root, default_agent, execution_mode,
           version, archived_at, created_at, updated_at
    FROM projects WHERE id = ?
  `);
  const selectTask = db.prepare(`
    SELECT id, project_id, title, objective, acceptance_criteria_json, scope, constraints,
           references_json, status, priority, brief_version, version, archived_at, created_at, updated_at
    FROM tasks WHERE id = ?
  `);
  const selectActiveProjectRoot = db.prepare(`
    SELECT id FROM projects WHERE root_path = ? AND archived_at IS NULL
  `);
  const insertTaskEvent = db.prepare(`
    INSERT INTO task_events (
      id, task_id, type, actor, task_version, brief_version, payload_json, created_at
    ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
  `);

  const notifyWrite = (): void => {
    Promise.resolve(onSuccessfulWrite()).catch(() => {});
  };

  const requireProject = (id: string): Project => {
    const row = rowOf(selectProject.get(id));
    if (!row) throw new ProjectTaskError('PROJECT_NOT_FOUND', 404, 'Project no longer exists');
    return projectFromRow(row);
  };

  const requireTask = (id: string): Task => {
    const row = selectTask.get(id) as TaskRow | undefined;
    if (!row) throw new ProjectTaskError('TASK_NOT_FOUND', 404, 'Task no longer exists');
    return taskFromRow(row);
  };

  const assertTaskProjectActive = (task: Task): void => {
    if (requireProject(task.projectId).archivedAt) {
      throw new ProjectTaskError('PROJECT_NOT_FOUND', 404, 'Project is archived');
    }
  };

  const transaction = <T>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };

  const appendTaskEvent = (
    task: Task,
    type: TaskEvent['type'],
    payload: Record<string, unknown>,
  ): void => {
    insertTaskEvent.run(
      randomUUID(),
      task.id,
      type,
      task.version,
      task.briefVersion,
      JSON.stringify(payload),
      task.updatedAt,
    );
  };

  const assertTaskVersion = (task: Task, rawVersion: unknown): number => {
    const expectedVersion = requireExpectedVersion(rawVersion, 'TASK_VALIDATION');
    if (task.version !== expectedVersion) {
      throw new ProjectTaskError('VERSION_CONFLICT', 409, 'Task changed; refresh before saving again');
    }
    return expectedVersion;
  };

  return {
    async listProjects({ archived = false } = {}): Promise<Project[]> {
      const rows = db.prepare(`
        SELECT id, name, root_path, repository_root, default_agent, execution_mode,
               version, archived_at, created_at, updated_at
        FROM projects
        WHERE ${archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'}
        ORDER BY updated_at DESC, id
      `).all() as ProjectRow[];
      return rows.map(projectFromRow);
    },

    async getProject(id: string): Promise<Project> {
      return requireProject(id);
    },

    async createProject(input): Promise<Project> {
      const name = requireTrimmedString(input.name, 'name', 120, 'PROJECT_VALIDATION');
      if (typeof input.rootPath !== 'string' || !input.rootPath) {
        throw new ProjectTaskError('PROJECT_VALIDATION', 400, 'rootPath must be an absolute directory');
      }
      let rootPath: string;
      try {
        rootPath = await realpath(input.rootPath);
        if (!await isDirectory(rootPath)) throw new Error('not a directory');
      } catch {
        throw new ProjectTaskError('PROJECT_VALIDATION', 400, 'rootPath must be an existing directory');
      }
      const existing = selectActiveProjectRoot.get(rootPath);
      if (existing) {
        throw new ProjectTaskError('PROJECT_ROOT_EXISTS', 409, 'This directory is already a Project');
      }

      const id = randomUUID();
      const timestamp = now().toISOString();
      const repositoryRoot = await resolveRepositoryRoot(rootPath);
      // Repository discovery is async. Recheck at the synchronous write boundary so two concurrent
      // Add Project requests cannot both pass the first lookup and leak a raw SQLite constraint error.
      if (selectActiveProjectRoot.get(rootPath)) {
        throw new ProjectTaskError('PROJECT_ROOT_EXISTS', 409, 'This directory is already a Project');
      }
      db.prepare(`
        INSERT INTO projects (
          id, name, root_path, repository_root, default_agent, execution_mode,
          version, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'project-root', 1, NULL, ?, ?)
      `).run(id, name, rootPath, repositoryRoot, timestamp, timestamp);
      notifyWrite();
      return requireProject(id);
    },

    async updateProject(id, input): Promise<Project> {
      const name = requireTrimmedString(input.name, 'name', 120, 'PROJECT_VALIDATION');
      const expectedVersion = requireExpectedVersion(input.expectedVersion);
      const timestamp = now().toISOString();
      const result = db.prepare(`
        UPDATE projects
        SET name = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND archived_at IS NULL
      `).run(name, timestamp, id, expectedVersion) as StatementResultingChanges;
      if (result.changes === 0) {
        const current = requireProject(id);
        if (current.archivedAt) {
          throw new ProjectTaskError('PROJECT_NOT_FOUND', 404, 'Project is archived');
        }
        throw new ProjectTaskError('VERSION_CONFLICT', 409, 'Project changed; refresh before saving again');
      }
      notifyWrite();
      return requireProject(id);
    },

    async archiveProject(id, input): Promise<Project> {
      const expectedVersion = requireExpectedVersion(input.expectedVersion);
      const timestamp = now().toISOString();
      const result = db.prepare(`
        UPDATE projects
        SET archived_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND archived_at IS NULL
      `).run(timestamp, timestamp, id, expectedVersion) as StatementResultingChanges;
      if (result.changes === 0) {
        const current = requireProject(id);
        if (current.archivedAt) return current;
        throw new ProjectTaskError('VERSION_CONFLICT', 409, 'Project changed; refresh before archiving');
      }
      notifyWrite();
      return requireProject(id);
    },

    async listTasks({ projectId, bucket }): Promise<Task[]> {
      if (typeof projectId !== 'string' || !projectId) {
        throw new ProjectTaskError('TASK_VALIDATION', 400, 'projectId is required');
      }
      requireProject(projectId);
      const clauses: Record<string, string> = {
        tasks: "archived_at IS NULL AND status = 'ready'",
        drafts: "archived_at IS NULL AND status = 'draft'",
        canceled: "archived_at IS NULL AND status = 'canceled'",
        archived: 'archived_at IS NOT NULL',
      };
      if (typeof bucket !== 'string' || !Object.hasOwn(clauses, bucket)) {
        throw new ProjectTaskError('TASK_VALIDATION', 400, 'bucket must be tasks, drafts, canceled, or archived');
      }
      const rows = db.prepare(`
        SELECT id, project_id, title, objective, acceptance_criteria_json, scope, constraints,
               references_json, status, priority, brief_version, version, archived_at, created_at, updated_at
        FROM tasks
        WHERE project_id = ? AND ${clauses[bucket]}
        ORDER BY updated_at DESC, id
      `).all(projectId) as TaskRow[];
      return rows.map(taskFromRow);
    },

    async getTask(id: string): Promise<Task> {
      return requireTask(id);
    },

    async createTask(input): Promise<Task> {
      if (typeof input.projectId !== 'string' || !input.projectId) {
        throw new ProjectTaskError('TASK_VALIDATION', 400, 'projectId is required');
      }
      const project = requireProject(input.projectId);
      if (project.archivedAt) throw new ProjectTaskError('PROJECT_NOT_FOUND', 404, 'Project is archived');
      const taskStatus = status(input.status);
      const task: Task = {
        id: randomUUID(),
        projectId: project.id,
        title: requireTrimmedString(input.title, 'title', 240, 'TASK_VALIDATION'),
        objective: objective(input.objective),
        acceptanceCriteria: acceptanceCriteria(input.acceptanceCriteria),
        scope: optionalText(input.scope, 'scope'),
        constraints: optionalText(input.constraints, 'constraints'),
        references: references(input.references),
        status: taskStatus,
        priority: priority(input.priority),
        briefVersion: 1,
        version: 1,
        archivedAt: null,
        createdAt: now().toISOString(),
        updatedAt: '',
      };
      task.updatedAt = task.createdAt;
      if (task.status === 'ready') validateReady(task);

      transaction(() => {
        db.prepare(`
          INSERT INTO tasks (
            id, project_id, title, objective, acceptance_criteria_json, scope, constraints,
            references_json, status, priority, brief_version, version, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)
        `).run(
          task.id,
          task.projectId,
          task.title,
          task.objective,
          JSON.stringify(task.acceptanceCriteria),
          task.scope,
          task.constraints,
          JSON.stringify(task.references),
          task.status,
          task.priority,
          task.createdAt,
          task.updatedAt,
        );
        appendTaskEvent(task, 'task.created', { status: task.status });
      });
      notifyWrite();
      return requireTask(task.id);
    },

    async updateTask(id, input): Promise<Task> {
      const current = requireTask(id);
      assertTaskProjectActive(current);
      assertTaskVersion(current, input.expectedVersion);
      if (current.archivedAt) throw new ProjectTaskError('TASK_NOT_FOUND', 404, 'Task is archived');
      if (current.status === 'canceled') {
        throw new ProjectTaskError('TASK_TRANSITION_INVALID', 409, 'Canceled tasks are read-only');
      }

      const next: Task = {
        ...current,
        title: Object.hasOwn(input, 'title')
          ? requireTrimmedString(input.title, 'title', 240, 'TASK_VALIDATION') : current.title,
        objective: Object.hasOwn(input, 'objective') ? objective(input.objective) : current.objective,
        acceptanceCriteria: Object.hasOwn(input, 'acceptanceCriteria')
          ? acceptanceCriteria(input.acceptanceCriteria) : current.acceptanceCriteria,
        scope: Object.hasOwn(input, 'scope') ? optionalText(input.scope, 'scope') : current.scope,
        constraints: Object.hasOwn(input, 'constraints')
          ? optionalText(input.constraints, 'constraints') : current.constraints,
        references: Object.hasOwn(input, 'references') ? references(input.references) : current.references,
        priority: Object.hasOwn(input, 'priority') ? priority(input.priority) : current.priority,
      };
      if (next.status === 'ready') validateReady(next);
      const changedFields = [
        ...BRIEF_FIELDS.filter((field) => !sameJson(current[field], next[field])),
        ...(current.priority === next.priority ? [] : ['priority']),
      ];
      if (changedFields.length === 0) return current;
      const briefChanged = changedFields.some((field) => BRIEF_FIELDS.includes(field as typeof BRIEF_FIELDS[number]));
      next.version += 1;
      if (briefChanged) next.briefVersion += 1;
      next.updatedAt = now().toISOString();

      transaction(() => {
        db.prepare(`
          UPDATE tasks SET
            title = ?, objective = ?, acceptance_criteria_json = ?, scope = ?, constraints = ?,
            references_json = ?, priority = ?, brief_version = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(
          next.title,
          next.objective,
          JSON.stringify(next.acceptanceCriteria),
          next.scope,
          next.constraints,
          JSON.stringify(next.references),
          next.priority,
          next.briefVersion,
          next.version,
          next.updatedAt,
          next.id,
          current.version,
        );
        appendTaskEvent(next, 'task.updated', { changedFields });
      });
      notifyWrite();
      return requireTask(id);
    },

    async promoteTask(id, input): Promise<Task> {
      const current = requireTask(id);
      assertTaskProjectActive(current);
      assertTaskVersion(current, input.expectedVersion);
      if (current.archivedAt) throw new ProjectTaskError('TASK_NOT_FOUND', 404, 'Task is archived');
      if (current.status !== 'draft') {
        throw new ProjectTaskError('TASK_TRANSITION_INVALID', 409, 'Only a draft can become a task');
      }
      validateReady(current);
      const next = { ...current, status: 'ready' as const, version: current.version + 1, updatedAt: now().toISOString() };
      transaction(() => {
        db.prepare(`
          UPDATE tasks SET status = 'ready', version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(next.version, next.updatedAt, id, current.version);
        appendTaskEvent(next, 'task.promoted', { from: 'draft', to: 'ready' });
      });
      notifyWrite();
      return requireTask(id);
    },

    async cancelTask(id, input): Promise<Task> {
      const current = requireTask(id);
      assertTaskProjectActive(current);
      assertTaskVersion(current, input.expectedVersion);
      if (current.archivedAt) throw new ProjectTaskError('TASK_NOT_FOUND', 404, 'Task is archived');
      if (current.status === 'canceled') {
        throw new ProjectTaskError('TASK_TRANSITION_INVALID', 409, 'Task is already canceled');
      }
      const next = { ...current, status: 'canceled' as const, version: current.version + 1, updatedAt: now().toISOString() };
      transaction(() => {
        db.prepare(`
          UPDATE tasks SET status = 'canceled', version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(next.version, next.updatedAt, id, current.version);
        appendTaskEvent(next, 'task.canceled', { from: current.status, to: 'canceled' });
      });
      notifyWrite();
      return requireTask(id);
    },

    async archiveTask(id, input): Promise<Task> {
      const current = requireTask(id);
      assertTaskProjectActive(current);
      assertTaskVersion(current, input.expectedVersion);
      if (current.archivedAt) return current;
      const next = {
        ...current,
        version: current.version + 1,
        archivedAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
      transaction(() => {
        db.prepare(`
          UPDATE tasks SET archived_at = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(next.archivedAt, next.version, next.updatedAt, id, current.version);
        appendTaskEvent(next, 'task.archived', { archived: true });
      });
      notifyWrite();
      return requireTask(id);
    },

    async listTaskEvents(id: string): Promise<TaskEvent[]> {
      requireTask(id);
      const rows = db.prepare(`
        SELECT id, task_id, type, actor, task_version, brief_version, payload_json, created_at
        FROM task_events WHERE task_id = ? ORDER BY task_version, created_at, id
      `).all(id) as TaskEventRow[];
      return rows.map(taskEventFromRow);
    },
  };
}
