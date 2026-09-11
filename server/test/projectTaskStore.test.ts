import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpHome } from './tmphome.js';
import {
  configureProjectDatabase,
  migrateProjectDatabase,
  pragmaValue,
} from '../src/projectTask/migrations.js';
import { createProjectTaskRuntime } from '../src/projectTask/runtime.js';
import { ProjectTaskError, projectStorageError } from '../src/projectTask/schema.js';
import {
  createProjectBackupManager,
  preserveCorruptProjectDatabase,
  recoveryMarkerPath,
  verifyProjectBackup,
} from '../src/projectTask/backup.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('Project Task schema', () => {
  it('creates v1 once and applies the required SQLite pragmas', () => {
    const home = tmpHome('hm-project-schema-');
    const file = path.join(home, 'project.sqlite');
    const db = new DatabaseSync(file);
    try {
      configureProjectDatabase(db);
      expect(migrateProjectDatabase(db)).toBe(1);
      expect(migrateProjectDatabase(db)).toBe(1);
      expect(pragmaValue(db, 'user_version')).toBe(1);
      expect(pragmaValue(db, 'journal_mode')).toBe('wal');
      expect(pragmaValue(db, 'foreign_keys')).toBe(1);
      expect(pragmaValue(db, 'busy_timeout')).toBe(5000);
      expect(pragmaValue(db, 'synchronous')).toBe(1);
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(['projects', 'task_events', 'tasks']);
    } finally {
      db.close();
    }
  });

  it('refuses a database from a newer schema without changing it', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA user_version = 2');
      expect(() => migrateProjectDatabase(db)).toThrowError(ProjectTaskError);
      expect(pragmaValue(db, 'user_version')).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('Project Task runtime and Project store', () => {
  it('persists a realpath Project across runtime restart', async () => {
    const home = tmpHome('hm-project-restart-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const first = await createProjectTaskRuntime({
      home,
      storeOptions: { resolveRepositoryRoot: async () => root },
    });
    expect(first.status()).toEqual({ status: 'ready', schemaVersion: 1 });
    const created = await first.requireStore().createProject({ name: ' HandMux ', rootPath: root });
    expect(created).toMatchObject({
      name: 'HandMux',
      rootPath: await fsp.realpath(root),
      repositoryRoot: root,
      version: 1,
      archivedAt: null,
    });
    await first.close();

    const second = await createProjectTaskRuntime({ home });
    expect(await second.requireStore().listProjects()).toEqual([
      expect.objectContaining({ id: created.id, name: 'HandMux', rootPath: await fsp.realpath(root) }),
    ]);
    expect(fs.statSync(path.join(home, '.handmux')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, '.handmux', 'handmux.sqlite')).mode & 0o777).toBe(0o600);
    await second.close();
  });

  it('holds one process lock for the runtime lifetime and releases only its own token', async () => {
    const home = tmpHome('hm-project-lock-');
    const first = await createProjectTaskRuntime({ home });
    const second = await createProjectTaskRuntime({ home });
    expect(first.status().status).toBe('ready');
    expect(second.status()).toMatchObject({
      status: 'unavailable',
      error: { code: 'PROJECT_STORE_LOCKED' },
    });
    await first.close();

    const third = await createProjectTaskRuntime({ home });
    expect(third.status().status).toBe('ready');
    await second.close();
    expect(third.status().status).toBe('ready');
    await third.close();
  });

  it('deduplicates active realpaths, uses optimistic versions, and permits re-add after archive', async () => {
    const home = tmpHome('hm-project-domain-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({ home });
    const store = runtime.requireStore();
    const project = await store.createProject({ name: 'One', rootPath: root });

    await expect(store.createProject({ name: 'Duplicate', rootPath: root })).rejects.toMatchObject({
      code: 'PROJECT_ROOT_EXISTS',
    });
    const renamed = await store.updateProject(project.id, { name: 'Two', expectedVersion: 1 });
    expect(renamed).toMatchObject({ name: 'Two', version: 2 });
    await expect(store.updateProject(project.id, { name: 'Stale', expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const archived = await store.archiveProject(project.id, { expectedVersion: 2 });
    expect(archived).toMatchObject({ version: 3, archivedAt: expect.any(String) });
    expect(await store.listProjects()).toEqual([]);

    const replacement = await store.createProject({ name: 'Replacement', rootPath: root });
    expect(replacement.id).not.toBe(project.id);
    await runtime.close();
  });

  it('maps concurrent Add Project requests for one realpath to the same domain conflict', async () => {
    const home = tmpHome('hm-project-concurrent-root-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    let resolving = 0;
    let release!: () => void;
    const bothResolving = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await createProjectTaskRuntime({
      home,
      storeOptions: {
        resolveRepositoryRoot: async () => {
          resolving += 1;
          if (resolving === 2) release();
          await bothResolving;
          return root;
        },
      },
    });
    const store = runtime.requireStore();

    const results = await Promise.allSettled([
      store.createProject({ name: 'First', rootPath: root }),
      store.createProject({ name: 'Second', rootPath: root }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'PROJECT_ROOT_EXISTS', status: 409 });
    expect(await store.listProjects()).toHaveLength(1);
    await runtime.close();
  });

  it('creates a verified daily online backup after a successful write', async () => {
    const home = tmpHome('hm-project-backup-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({ home });
    await runtime.requireStore().createProject({ name: 'Project', rootPath: root });
    await runtime.close();
    const backupDir = path.join(home, '.handmux', 'backups', 'project-task');
    const files = (await fsp.readdir(backupDir)).filter((name) => name.startsWith('daily-'));
    expect(files).toHaveLength(1);
    expect(verifyProjectBackup(path.join(backupDir, files[0] ?? 'missing'))).toBe(true);
  });

  it('backs up before migration and keeps standalone backup permissions', async () => {
    const home = tmpHome('hm-project-pre-migration-');
    const handmux = path.join(home, '.handmux');
    const database = path.join(handmux, 'handmux.sqlite');
    await fsp.mkdir(handmux);
    new DatabaseSync(database).close();
    const runtime = await createProjectTaskRuntime({ home });
    expect(runtime.status()).toMatchObject({ status: 'ready', schemaVersion: 1 });
    await runtime.close();

    const backupDir = path.join(handmux, 'backups', 'project-task');
    const files = (await fsp.readdir(backupDir)).filter((name) => name.startsWith('pre-v1-'));
    expect(files).toHaveLength(1);
    expect(verifyProjectBackup(path.join(backupDir, files[0] ?? 'missing'))).toBe(true);
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(backupDir, files[0] ?? 'missing')).mode & 0o777).toBe(0o600);
  });

  it('retains only seven daily and three pre-migration verified backups', async () => {
    const home = tmpHome('hm-project-backup-retention-');
    const database = path.join(home, 'source.sqlite');
    const backupDir = path.join(home, 'backups');
    const db = new DatabaseSync(database);
    configureProjectDatabase(db);
    migrateProjectDatabase(db);
    let current = new Date('2026-08-01T01:00:00.000Z');
    const manager = createProjectBackupManager({ db, databasePath: database, directory: backupDir, now: () => current });
    for (let day = 1; day <= 9; day += 1) {
      current = new Date(`2026-08-${String(day).padStart(2, '0')}T01:00:00.000Z`);
      manager.successfulWrite();
      await manager.flush();
    }
    for (let version = 2; version <= 6; version += 1) {
      current = new Date(`2026-09-0${version}T01:00:00.000Z`);
      await manager.preMigration(version);
    }
    db.close();
    const files = await fsp.readdir(backupDir);
    expect(files.filter((name) => /^daily-.*\.sqlite$/.test(name))).toHaveLength(7);
    expect(files.filter((name) => /^pre-v.*\.sqlite$/.test(name))).toHaveLength(3);
    expect(files.some((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toBe(false);
  });

  it('restores the latest verified backup and preserves the corrupt database set', async () => {
    const home = tmpHome('hm-project-recover-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const handmux = path.join(home, '.handmux');
    const database = path.join(handmux, 'handmux.sqlite');
    await fsp.mkdir(handmux);
    // Starting from a legacy v0 file creates a pre-migration backup before the later daily write.
    // Recovery must compare both families by recency, not let the `pre-v*` prefix win lexically.
    new DatabaseSync(database).close();
    const first = await createProjectTaskRuntime({ home });
    const project = await first.requireStore().createProject({ name: 'Project', rootPath: root });
    await first.close();
    const backupDir = path.join(handmux, 'backups', 'project-task');
    const backups = await fsp.readdir(backupDir);
    const pre = backups.find((name) => name.startsWith('pre-v'));
    const daily = backups.find((name) => name.startsWith('daily-'));
    expect(pre).toBeTruthy();
    expect(daily).toBeTruthy();
    await fsp.utimes(path.join(backupDir, pre!), new Date('2026-08-19T00:00:00Z'), new Date('2026-08-19T00:00:00Z'));
    await fsp.utimes(path.join(backupDir, daily!), new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T00:00:00Z'));
    await fsp.writeFile(database, 'not a sqlite database');

    const recovered = await createProjectTaskRuntime({ home });
    expect(recovered.status()).toMatchObject({
      status: 'ready',
      schemaVersion: 1,
      recoveryNotice: expect.stringContaining('daily-'),
    });
    expect(await recovered.requireStore().getProject(project.id)).toMatchObject({ id: project.id, name: 'Project' });
    const names = await fsp.readdir(path.dirname(database));
    expect(names.some((name) => name.startsWith('handmux.sqlite.corrupt.'))).toBe(true);
    await recovered.close();
  });

  it('never creates an empty replacement when corruption has no verified backup', async () => {
    const home = tmpHome('hm-project-no-backup-');
    const handmux = path.join(home, '.handmux');
    await fsp.mkdir(handmux);
    const database = path.join(handmux, 'handmux.sqlite');
    await fsp.writeFile(database, 'broken');
    const first = await createProjectTaskRuntime({ home });
    expect(first.status()).toMatchObject({ status: 'unavailable', error: { code: 'PROJECT_STORE_CORRUPT' } });
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.existsSync(`${database}.recovery-required.json`)).toBe(true);
    await first.close();

    const second = await createProjectTaskRuntime({ home });
    expect(second.status()).toMatchObject({ status: 'unavailable', error: { code: 'PROJECT_STORE_CORRUPT' } });
    expect(fs.existsSync(database)).toBe(false);
    await second.close();
  });

  it('keeps the database in place when recovery intent cannot be persisted', async () => {
    const home = tmpHome('hm-project-recovery-intent-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const first = await createProjectTaskRuntime({ home });
    const project = await first.requireStore().createProject({ name: 'Project', rootPath: root });
    await first.close();

    const database = path.join(home, '.handmux', 'handmux.sqlite');
    const marker = recoveryMarkerPath(database);
    await fsp.writeFile(database, 'not a sqlite database');
    let markerWriteAttempted = false;
    const failingFs = {
      ...fsp,
      async writeFile(...args: Parameters<typeof fsp.writeFile>) {
        if (args[0] === `${marker}.partial`) {
          markerWriteAttempted = true;
          throw Object.assign(new Error('simulated marker write failure'), { code: 'ENOSPC' });
        }
        return fsp.writeFile(...args);
      },
    } as typeof fsp;

    const unavailable = await createProjectTaskRuntime({ home, fs: failingFs });
    expect(unavailable.status()).toMatchObject({
      status: 'unavailable', error: { code: 'PROJECT_STORE_FULL' },
    });
    await unavailable.close();
    expect(markerWriteAttempted).toBe(true);
    expect(await fsp.readFile(database, 'utf8')).toBe('not a sqlite database');
    expect(fs.existsSync(marker)).toBe(false);
    expect((await fsp.readdir(path.dirname(database))).some((name) => name.includes('.corrupt.'))).toBe(false);

    const recovered = await createProjectTaskRuntime({ home });
    expect(recovered.status()).toMatchObject({ status: 'ready', recoveryNotice: expect.stringContaining('daily-') });
    expect(await recovered.requireStore().getProject(project.id)).toMatchObject({ id: project.id, name: 'Project' });
    await recovered.close();
  });

  it('finishes an interrupted DB/WAL/SHM preservation before restoring a verified backup', async () => {
    const home = tmpHome('hm-project-recovery-resume-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const first = await createProjectTaskRuntime({ home });
    const project = await first.requireStore().createProject({ name: 'Project', rootPath: root });
    await first.close();

    const database = path.join(home, '.handmux', 'handmux.sqlite');
    const marker = recoveryMarkerPath(database);
    await fsp.writeFile(database, 'not a sqlite database');
    await fsp.writeFile(`${database}-wal`, 'stale wal');
    await fsp.writeFile(`${database}-shm`, 'stale shm');
    let interrupted = false;
    const interruptedFs = {
      ...fsp,
      async rename(...args: Parameters<typeof fsp.rename>) {
        if (!interrupted && args[0] === `${database}-wal`) {
          interrupted = true;
          throw Object.assign(new Error('simulated crash between database moves'), { code: 'EIO' });
        }
        return fsp.rename(...args);
      },
    } as typeof fsp;

    await expect(preserveCorruptProjectDatabase({
      databasePath: database,
      fs: interruptedFs,
    })).rejects.toThrow('simulated crash between database moves');
    expect(interrupted).toBe(true);
    expect(fs.existsSync(database)).toBe(false);
    expect(await fsp.readFile(`${database}-wal`, 'utf8')).toBe('stale wal');
    const recovery = JSON.parse(await fsp.readFile(marker, 'utf8')) as { preserved: string[] };

    const recovered = await createProjectTaskRuntime({ home });
    expect(recovered.status()).toMatchObject({
      status: 'ready', recoveryNotice: expect.stringContaining('daily-'),
    });
    expect(await recovered.requireStore().getProject(project.id)).toMatchObject({ id: project.id });
    await recovered.close();
    expect(fs.existsSync(marker)).toBe(false);
    const preserved = new Map(recovery.preserved.map((file) => [
      file,
      fs.readFileSync(file, 'utf8'),
    ]));
    expect([...preserved.values()]).toEqual(expect.arrayContaining([
      'not a sqlite database', 'stale wal', 'stale shm',
    ]));
  });

  it('accepts a verified backup installed just before recovery marker cleanup', async () => {
    const home = tmpHome('hm-project-recovery-installed-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const first = await createProjectTaskRuntime({ home });
    const project = await first.requireStore().createProject({ name: 'Project', rootPath: root });
    await first.close();

    const database = path.join(home, '.handmux', 'handmux.sqlite');
    const backupDir = path.join(home, '.handmux', 'backups', 'project-task');
    const daily = (await fsp.readdir(backupDir)).find((name) => name.startsWith('daily-'))!;
    await fsp.writeFile(database, 'not a sqlite database');
    await preserveCorruptProjectDatabase({ databasePath: database });
    await fsp.copyFile(path.join(backupDir, daily), database);

    const recovered = await createProjectTaskRuntime({ home });
    expect(recovered.status()).toMatchObject({
      status: 'ready', recoveryNotice: 'Completed Project data recovery',
    });
    expect(await recovered.requireStore().getProject(project.id)).toMatchObject({ id: project.id });
    expect(fs.existsSync(recoveryMarkerPath(database))).toBe(false);
    await recovered.close();
  });

  it('leaves a healthy database untouched when its startup check is temporarily busy', async () => {
    const home = tmpHome('hm-project-busy-check-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const first = await createProjectTaskRuntime({ home });
    const project = await first.requireStore().createProject({ name: 'Project', rootPath: root });
    await first.close();
    const second = await createProjectTaskRuntime({ home });
    const task = await second.requireStore().createTask({
      projectId: project.id, title: 'Must survive', status: 'draft',
    });
    await second.close();
    const database = path.join(home, '.handmux', 'handmux.sqlite');
    const blocker = new DatabaseSync(database);
    try {
      blocker.exec('PRAGMA journal_mode = DELETE');
      blocker.exec('PRAGMA locking_mode = EXCLUSIVE');
      blocker.exec('BEGIN EXCLUSIVE');
      const unavailable = await createProjectTaskRuntime({ home });
      expect(unavailable.status()).toMatchObject({
        status: 'unavailable', error: { code: 'PROJECT_STORE_LOCKED' },
      });
      await unavailable.close();
      const handmuxFiles = await fsp.readdir(path.join(home, '.handmux'));
      expect(handmuxFiles.some((name) => name.includes('.corrupt.'))).toBe(false);
      expect(handmuxFiles).not.toContain('handmux.sqlite.recovery-required.json');
    } finally {
      try { blocker.exec('ROLLBACK'); } catch {}
      blocker.close();
    }

    const reopened = await createProjectTaskRuntime({ home });
    expect(await reopened.requireStore().getTask(task.id)).toMatchObject({
      id: task.id, title: 'Must survive', version: 1,
    });
    await reopened.close();
  });

  it('maps node:sqlite numeric READONLY and FULL errors to actionable storage failures', () => {
    const db = new DatabaseSync(':memory:');
    try {
      configureProjectDatabase(db);
      migrateProjectDatabase(db);
      db.exec('PRAGMA query_only = ON');
      let readonly: unknown;
      try { db.exec("INSERT INTO projects (id, name, root_path, execution_mode, version, created_at, updated_at) VALUES ('p', 'P', '/', 'project-root', 1, 'now', 'now')"); }
      catch (error) { readonly = error; }
      expect(projectStorageError(readonly)).toMatchObject({
        code: 'PROJECT_STORE_PERMISSION', status: 503,
      });
      expect(projectStorageError(Object.assign(new Error('attempt to write a readonly database'), {
        code: 'ERR_SQLITE_ERROR', errcode: 8, errstr: 'attempt to write a readonly database',
      }))).toMatchObject({ code: 'PROJECT_STORE_PERMISSION', status: 503 });
      expect(projectStorageError(Object.assign(new Error('SQL logic error'), {
        code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'SQL logic error',
      }))).toBeNull();
      expect(projectStorageError(Object.assign(new Error('disk full'), {
        code: 'ERR_SQLITE_ERROR', errcode: 13,
      }))).toMatchObject({ code: 'PROJECT_STORE_FULL', status: 507 });
    } finally {
      db.close();
    }
  });
});

describe('Task draft control plane', () => {
  it('keeps one Task id from incomplete draft through edit and promote', async () => {
    const home = tmpHome('hm-task-promote-');
    const root = path.join(home, 'repo');
    const ids = ['project', 'task', 'z-created', 'm-updated', 'a-promoted'];
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({
      home,
      storeOptions: {
        now: () => new Date('2026-08-25T00:00:00.000Z'),
        randomUUID: () => ids.shift() ?? 'unexpected',
      },
    });
    const store = runtime.requireStore();
    const project = await store.createProject({ name: 'Project', rootPath: root });
    const draft = await store.createTask({ projectId: project.id, title: ' Login idea ', status: 'draft' });
    expect(draft).toMatchObject({
      title: 'Login idea',
      objective: '',
      acceptanceCriteria: [],
      status: 'draft',
      briefVersion: 1,
      version: 1,
    });
    await expect(store.promoteTask(draft.id, { expectedVersion: 1 })).rejects.toMatchObject({
      code: 'TASK_VALIDATION',
    });

    const edited = await store.updateTask(draft.id, {
      objective: 'Show the real login failure',
      acceptanceCriteria: [' Invalid token explains what to do ', ' ', 'Retry succeeds'],
      priority: 'high',
      expectedVersion: 1,
    });
    expect(edited).toMatchObject({
      id: draft.id,
      objective: 'Show the real login failure',
      acceptanceCriteria: ['Invalid token explains what to do', 'Retry succeeds'],
      priority: 'high',
      briefVersion: 2,
      version: 2,
    });
    const promoted = await store.promoteTask(draft.id, { expectedVersion: 2 });
    expect(promoted).toMatchObject({ id: draft.id, status: 'ready', briefVersion: 2, version: 3 });
    expect((await store.listTaskEvents(draft.id)).map((event) => event.type)).toEqual([
      'task.created',
      'task.updated',
      'task.promoted',
    ]);
    expect(await store.listTasks({ projectId: project.id, bucket: 'drafts' })).toEqual([]);
    expect(await store.listTasks({ projectId: project.id, bucket: 'tasks' })).toEqual([promoted]);
    await runtime.close();
  });

  it('creates a ready task without prefilled acceptance criteria and keeps canceled tasks read-only', async () => {
    const home = tmpHome('hm-task-cancel-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({ home });
    const store = runtime.requireStore();
    const project = await store.createProject({ name: 'Project', rootPath: root });
    await expect(store.createTask({ projectId: project.id, title: 'No proof', status: 'ready' }))
      .rejects.toMatchObject({ code: 'TASK_VALIDATION' });
    const task = await store.createTask({
      projectId: project.id,
      title: 'Ready',
      objective: 'Finish it',
      status: 'ready',
    });
    expect(task.acceptanceCriteria).toEqual([]);
    const canceled = await store.cancelTask(task.id, { expectedVersion: 1 });
    expect(canceled).toMatchObject({ status: 'canceled', version: 2 });
    await expect(store.updateTask(task.id, { title: 'Rewrite', expectedVersion: 2 }))
      .rejects.toMatchObject({ code: 'TASK_TRANSITION_INVALID' });
    const archived = await store.archiveTask(task.id, { expectedVersion: 2 });
    expect(archived).toMatchObject({ status: 'canceled', version: 3, archivedAt: expect.any(String) });
    expect(await store.listTasks({ projectId: project.id, bucket: 'canceled' })).toEqual([]);
    expect(await store.listTasks({ projectId: project.id, bucket: 'archived' })).toEqual([archived]);
    await runtime.close();
  });

  it('keeps every Task mutation read-only after its Project is archived', async () => {
    const home = tmpHome('hm-task-archived-project-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const runtime = await createProjectTaskRuntime({ home });
    const store = runtime.requireStore();
    const project = await store.createProject({ name: 'Project', rootPath: root });
    const task = await store.createTask({ projectId: project.id, title: 'Draft', status: 'draft' });
    await store.archiveProject(project.id, { expectedVersion: project.version });

    for (const mutation of [
      store.updateTask(task.id, { title: 'Changed', expectedVersion: task.version }),
      store.promoteTask(task.id, { expectedVersion: task.version }),
      store.cancelTask(task.id, { expectedVersion: task.version }),
      store.archiveTask(task.id, { expectedVersion: task.version }),
    ]) {
      await expect(mutation).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    }
    expect(await store.getTask(task.id)).toMatchObject({
      title: 'Draft', status: 'draft', version: task.version, archivedAt: null,
    });
    await runtime.close();
  });

  it('rolls back the Task row when its append-only event cannot commit', async () => {
    const home = tmpHome('hm-task-atomic-');
    const root = path.join(home, 'repo');
    await fsp.mkdir(root);
    const ids = ['project', 'task-one', 'event', 'task-two', 'event'];
    const runtime = await createProjectTaskRuntime({
      home,
      storeOptions: { randomUUID: () => ids.shift() ?? 'unexpected' },
    });
    const store = runtime.requireStore();
    const project = await store.createProject({ name: 'Project', rootPath: root });
    await store.createTask({ projectId: project.id, title: 'One', status: 'draft' });
    await expect(store.createTask({ projectId: project.id, title: 'Two', status: 'draft' })).rejects.toThrow();
    expect((await store.listTasks({ projectId: project.id, bucket: 'drafts' })).map((task) => task.title))
      .toEqual(['One']);
    await runtime.close();
  });
});
