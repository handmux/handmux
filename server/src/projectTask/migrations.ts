import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_TASK_SCHEMA_VERSION, ProjectTaskError } from './schema.js';

const V2_AUTH_SCHEMA = `
CREATE TABLE auth_devices (
 id TEXT PRIMARY KEY, pairing_request_id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 browser_summary TEXT NOT NULL, authorized_at INTEGER NOT NULL,
 expires_at INTEGER, last_used_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE TABLE auth_sessions (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES auth_devices(id),
 secret_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport IN ('http', 'https')),
 created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX auth_sessions_device ON auth_sessions(device_id);
CREATE INDEX auth_devices_expiry ON auth_devices(expires_at) WHERE revoked_at IS NULL;
CREATE TABLE auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

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
      `Project data requires a newer handmux version (schema ${current})`,
    );
  }
  if (current === PROJECT_TASK_SCHEMA_VERSION) return current;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (current === 0) db.exec(V1_SCHEMA);
    if (current < 2) {
      db.exec(V2_AUTH_SCHEMA);
      // Public releases before trusted-device/auth-origin protection used schema 1 and
      // allowed a valid Token from every known entry point. Preserve that behavior when
      // upgrading an existing schema-1 database; a brand-new database (version 0) keeps
      // the secure defaults applied by DeviceAuthService.
      if (current === 1) {
        db.exec("INSERT INTO auth_meta(key,value) VALUES('trusted_device_enabled','0'),('trusted_origin_enabled','0')");
      }
    }
    if (current < 3) db.exec('ALTER TABLE auth_devices ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)');
    db.exec(`PRAGMA user_version = ${PROJECT_TASK_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  return PROJECT_TASK_SCHEMA_VERSION;
}
