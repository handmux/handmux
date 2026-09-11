import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_TASK_SCHEMA_VERSION, ProjectTaskError } from './schema.js';

const V1_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  root_path TEXT NOT NULL,
  repository_root TEXT,
  default_agent TEXT CHECK(default_agent IN ('codex', 'claude') OR default_agent IS NULL),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('project-root', 'worktree')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX projects_active_root
ON projects(root_path)
WHERE archived_at IS NULL;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
  objective TEXT NOT NULL DEFAULT '',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(acceptance_criteria_json)),
  scope TEXT,
  constraints TEXT,
  references_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(references_json)),
  status TEXT NOT NULL CHECK(status IN ('draft', 'ready', 'canceled')),
  priority TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none', 'high', 'medium', 'low')),
  brief_version INTEGER NOT NULL DEFAULT 1 CHECK(brief_version >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX tasks_project_status_updated
ON tasks(project_id, status, archived_at, updated_at DESC);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK(type IN (
    'task.created', 'task.updated', 'task.promoted', 'task.canceled', 'task.archived'
  )),
  actor TEXT NOT NULL CHECK(actor IN ('user', 'system')),
  task_version INTEGER NOT NULL CHECK(task_version >= 1),
  brief_version INTEGER NOT NULL CHECK(brief_version >= 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_events_task_created
ON task_events(task_id, created_at, id);
`;

export function pragmaValue(db: DatabaseSync, name: string): number | string | null {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : null;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

export function configureProjectDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
}

export function migrateProjectDatabase(db: DatabaseSync): number {
  const current = Number(pragmaValue(db, 'user_version') ?? 0);
  if (current > PROJECT_TASK_SCHEMA_VERSION) {
    throw new ProjectTaskError(
      'PROJECT_STORE_TOO_NEW',
      503,
      `Project data requires a newer HandMux version (schema ${current})`,
    );
  }
  if (current === PROJECT_TASK_SCHEMA_VERSION) return current;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (current === 0) db.exec(V1_SCHEMA);
    db.exec(`PRAGMA user_version = ${PROJECT_TASK_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  return PROJECT_TASK_SCHEMA_VERSION;
}
