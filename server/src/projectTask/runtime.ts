import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { createProjectStoreLock } from './lock.js';
import { configureProjectDatabase, migrateProjectDatabase, pragmaValue } from './migrations.js';
import { createProjectTaskStore } from './store.js';
import type { ProjectTaskStore, ProjectTaskStoreOptions } from './store.js';
import {
  isProjectDatabaseCorruption,
  PROJECT_TASK_SCHEMA_VERSION,
  ProjectTaskError,
  projectStorageError,
} from './schema.js';
import type { ProjectTaskErrorCode } from './schema.js';
import {
  completeProjectDatabasePreservation,
  createProjectBackupManager,
  latestVerifiedProjectBackup,
  preserveCorruptProjectDatabase,
  recoveryMarkerPath,
  restoreProjectBackup,
} from './backup.js';

// Vite 5 (used by the current test harness) predates node:sqlite and rewrites a value import to a
// third-party `sqlite` package. Requiring the builtin keeps production and tests on Node's one backend.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface ProjectTaskRuntimeStatus {
  status: 'ready' | 'recovering' | 'unavailable';
  schemaVersion: number;
  recoveryNotice?: string;
  error?: { code: ProjectTaskErrorCode; message: string };
}

export interface ProjectTaskRuntime {
  status(): ProjectTaskRuntimeStatus;
  requireStore(): ProjectTaskStore;
  close(): Promise<void>;
}

interface DatabaseConstructor {
  new(path: string, options?: ConstructorParameters<typeof DatabaseSync>[1]): NodeDatabaseSync;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

function publicStoreError(error: unknown): ProjectTaskError {
  if (error instanceof ProjectTaskError) return error;
  const storage = projectStorageError(error);
  if (storage) return storage;
  return new ProjectTaskError(
    'PROJECT_STORE_CORRUPT',
    503,
    'Project data could not be opened safely; the existing database was left unchanged',
  );
}

function quickCheck(db: NodeDatabaseSync): boolean {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  return rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok';
}

async function pathExists(fs: typeof fsp, target: string): Promise<boolean> {
  try { await fs.stat(target); return true; } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function createProjectTaskRuntime({
  home,
  databasePath = path.join(home, '.handmux', 'handmux.sqlite'),
  lockDirectory = path.join(home, '.handmux', 'locks', 'project-store'),
  backupDirectory = path.join(home, '.handmux', 'backups', 'project-task'),
  Database = DatabaseSync,
  fs = fsp,
  storeOptions = {},
}: {
  home: string;
  databasePath?: string;
  lockDirectory?: string;
  backupDirectory?: string;
  Database?: DatabaseConstructor;
  fs?: typeof fsp;
  storeOptions?: ProjectTaskStoreOptions;
}): Promise<ProjectTaskRuntime> {
  let state: ProjectTaskRuntimeStatus = { status: 'recovering', schemaVersion: 0 };
  let db: NodeDatabaseSync | null = null;
  let store: ProjectTaskStore | null = null;
  let backups: ReturnType<typeof createProjectBackupManager> | null = null;
  let lock: Awaited<ReturnType<ReturnType<typeof createProjectStoreLock>['acquire']>> | null = null;
  let closed = false;

  try {
    const handmuxDirectory = path.dirname(databasePath);
    await fs.mkdir(handmuxDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(handmuxDirectory, 0o700);
    lock = await createProjectStoreLock({ dir: lockDirectory, fs }).acquire();
    const openDatabase = (): NodeDatabaseSync => new Database(databasePath, {
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false,
    });
    let databaseExisted = await pathExists(fs, databasePath);
    const markerExists = await pathExists(fs, recoveryMarkerPath(databasePath));
    let recoveryNotice: string | undefined;
    if (markerExists) {
      // The prior process may have stopped after moving only part of DB/WAL/SHM. Finish the durable move
      // plan before restoring so SQLite can never attach an old companion file to the verified backup.
      const recovery = await completeProjectDatabasePreservation({ databasePath, fs });
      if (recovery.databaseReady) {
        await fs.rm(recoveryMarkerPath(databasePath), { force: true });
        recoveryNotice = 'Completed Project data recovery';
      } else {
        const candidate = await latestVerifiedProjectBackup({ directory: backupDirectory, fs });
        if (!candidate) {
          throw new ProjectTaskError(
            'PROJECT_STORE_CORRUPT',
            503,
            'Project data is damaged and no verified backup is available; preserved files were left untouched',
          );
        }
        await restoreProjectBackup({ backupPath: candidate, databasePath, fs });
        recoveryNotice = `Recovered Project data from ${path.basename(candidate)}`;
      }
      databaseExisted = true;
    }
    db = openDatabase();
    await fs.chmod(databasePath, 0o600);
    let healthy = false;
    try {
      configureProjectDatabase(db);
      healthy = quickCheck(db);
    } catch (error) {
      // BUSY, IO and other transient/open failures do not prove corruption. Preserve the live database
      // byte-for-byte and surface unavailable; only SQLite's explicit CORRUPT/NOTADB diagnoses may enter
      // the destructive preserve-and-restore path below.
      if (!isProjectDatabaseCorruption(error)) throw error;
    }
    if (!healthy) {
      db.close();
      db = null;
      await preserveCorruptProjectDatabase({ databasePath, fs });
      const candidate = await latestVerifiedProjectBackup({ directory: backupDirectory, fs });
      if (!candidate) {
        throw new ProjectTaskError(
          'PROJECT_STORE_CORRUPT',
          503,
          'Project data is damaged and no verified backup is available; the damaged files were preserved',
        );
      }
      await restoreProjectBackup({ backupPath: candidate, databasePath, fs });
      db = openDatabase();
      configureProjectDatabase(db);
      if (!quickCheck(db)) throw new Error('Restored Project backup failed quick_check');
      recoveryNotice = `Recovered Project data from ${path.basename(candidate)}`;
    }
    backups = createProjectBackupManager({ db, databasePath, directory: backupDirectory, fs });
    const currentVersion = Number(pragmaValue(db, 'user_version') ?? 0);
    if (databaseExisted && currentVersion < PROJECT_TASK_SCHEMA_VERSION) {
      await backups.preMigration(PROJECT_TASK_SCHEMA_VERSION);
    }
    const schemaVersion = migrateProjectDatabase(db);
    if (!quickCheck(db)) {
      throw new ProjectTaskError(
        'PROJECT_STORE_CORRUPT',
        503,
        'Project data failed verification after migration; the migration was rolled back',
      );
    }
    const externalWrite = storeOptions.onSuccessfulWrite;
    store = createProjectTaskStore(db, {
      ...storeOptions,
      onSuccessfulWrite: async () => {
        backups?.successfulWrite();
        await externalWrite?.();
      },
    });
    state = {
      status: 'ready',
      schemaVersion,
      ...(recoveryNotice ? { recoveryNotice } : {}),
    };
  } catch (error) {
    const safe = publicStoreError(error);
    let observedVersion = 0;
    if (db) {
      try { observedVersion = Number(pragmaValue(db, 'user_version') ?? 0); } catch {}
    }
    await backups?.flush().catch(() => {});
    backups = null;
    try { db?.close(); } catch {}
    db = null;
    await lock?.release().catch(() => {});
    lock = null;
    state = {
      status: 'unavailable',
      schemaVersion: Number.isFinite(observedVersion) ? observedVersion : PROJECT_TASK_SCHEMA_VERSION,
      error: { code: safe.code, message: safe.message },
    };
  }

  return {
    status: () => ({ ...state }),
    requireStore(): ProjectTaskStore {
      if (closed || !store || state.status !== 'ready') {
        const error = state.error ?? {
          code: 'PROJECT_STORE_CORRUPT' as const,
          message: 'Project data is unavailable; restart HandMux and try again',
        };
        throw new ProjectTaskError(error.code, error.code === 'PROJECT_STORE_FULL' ? 507 : 503, error.message);
      }
      return store;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (state.status === 'ready') state = { status: 'unavailable', schemaVersion: state.schemaVersion };
      store = null;
      try {
        await backups?.flush().catch(() => {});
        backups = null;
        db?.close();
      } finally {
        db = null;
        await lock?.release().catch(() => {});
        lock = null;
      }
    },
  };
}
