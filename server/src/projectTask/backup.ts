import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type BackupKind = 'daily' | 'pre';

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null;
}

async function exists(fs: typeof fsp, target: string): Promise<boolean> {
  try { await fs.stat(target); return true; } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function verifyProjectBackup(file: string): boolean {
  let db: NodeDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0] ?? {})[0] === 'ok';
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function makeStandaloneProjectBackup(file: string): void {
  let db: NodeDatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { allowExtension: false });
    const row = db.prepare('PRAGMA journal_mode = DELETE').get() as Record<string, unknown> | undefined;
    if (Object.values(row ?? {})[0] !== 'delete') {
      throw new Error('Project backup could not be converted to a standalone SQLite file');
    }
  } finally {
    try { db?.close(); } catch {}
  }
}

async function verifiedFiles(fs: typeof fsp, directory: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith('.sqlite')).sort().reverse();
  return files.map((name) => path.join(directory, name)).filter(verifyProjectBackup);
}

export async function latestVerifiedProjectBackup({
  directory,
  fs = fsp,
}: {
  directory: string;
  fs?: typeof fsp;
}): Promise<string | null> {
  const candidates = await Promise.all((await verifiedFiles(fs, directory)).map(async (file) => ({
    file,
    mtimeMs: (await fs.stat(file)).mtimeMs,
  })));
  // `daily-*` and `pre-v*` are separate retention families; their prefixes do not encode a shared
  // chronology (`pre-v*` sorts after every `daily-*`). Recovery must choose the newest verified file
  // by creation/write time or an old pre-migration snapshot can silently replace newer Task data.
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs
    || path.basename(right.file).localeCompare(path.basename(left.file)));
  return candidates[0]?.file ?? null;
}

export function recoveryMarkerPath(databasePath: string): string {
  return `${databasePath}.recovery-required.json`;
}

function recoveryMoves(value: unknown, databasePath: string): Array<{ source: string; target: string }> {
  if (!value || typeof value !== 'object' || !('preserved' in value)
    || !Array.isArray(value.preserved) || value.preserved.length === 0) {
    throw new Error('Project recovery marker is invalid');
  }
  const sources = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const seen = new Set<string>();
  return value.preserved.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error('Project recovery marker is invalid');
    const source = sources.find((entry) => (
      candidate.startsWith(`${entry}.corrupt.`)
      && path.dirname(candidate) === path.dirname(entry)
    ));
    if (!source || candidate.length === `${source}.corrupt.`.length || seen.has(source)) {
      throw new Error('Project recovery marker is invalid');
    }
    seen.add(source);
    return { source, target: candidate };
  });
}

export async function completeProjectDatabasePreservation({
  databasePath,
  fs = fsp,
}: {
  databasePath: string;
  fs?: typeof fsp;
}): Promise<{ preserved: string[]; databaseReady: boolean }> {
  const marker = recoveryMarkerPath(databasePath);
  const moves = recoveryMoves(JSON.parse(await fs.readFile(marker, 'utf8')) as unknown, databasePath);
  let databaseReady = false;
  // Finish companions first. If both live and preserved main files exist, a verified live main file can
  // only be the standalone backup renamed into place just before a crash deleting the marker.
  const ordered = [...moves].sort((left, right) => (
    Number(left.source === databasePath) - Number(right.source === databasePath)
  ));
  for (const { source, target } of ordered) {
    const sourceExists = await exists(fs, source);
    const targetExists = await exists(fs, target);
    if (sourceExists && targetExists) {
      if (source === databasePath && verifyProjectBackup(source)) {
        databaseReady = true;
        continue;
      }
      throw new Error('Project recovery found both live and preserved database files');
    }
    if (sourceExists) await fs.rename(source, target);
    else if (!targetExists) throw new Error('Project recovery is missing a planned database file');
  }
  // Never place a verified standalone backup beside an old live WAL/SHM that was not covered by the
  // durable move plan. Mixing generations is less safe than leaving recovery pending for inspection.
  for (const source of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (source === databasePath && databaseReady) continue;
    if (await exists(fs, source)) throw new Error('Project recovery left an unpreserved database file');
  }
  return { preserved: moves.map(({ target }) => target), databaseReady };
}

export async function preserveCorruptProjectDatabase({
  databasePath,
  fs = fsp,
  now = () => new Date(),
}: {
  databasePath: string;
  fs?: typeof fsp;
  now?: () => Date;
}): Promise<string[]> {
  const suffix = `.corrupt.${stamp(now())}`;
  const planned: Array<{ source: string; target: string }> = [];
  for (const source of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!await exists(fs, source)) continue;
    planned.push({ source, target: `${source}${suffix}` });
  }

  // Persist recovery intent before moving any part of the live SQLite set. If the process or disk
  // fails after a rename, the next startup must see the marker and restore a verified backup rather
  // than treating the missing database as a first run and silently creating an empty one.
  const marker = recoveryMarkerPath(databasePath);
  const temporaryMarker = `${marker}.partial`;
  try {
    await fs.writeFile(
      temporaryMarker,
      `${JSON.stringify({ preserved: planned.map(({ target }) => target) })}\n`,
      { mode: 0o600, flush: true },
    );
    await fs.rename(temporaryMarker, marker);
  } catch (error) {
    await fs.rm(temporaryMarker, { force: true }).catch(() => {});
    throw error;
  }

  for (const { source, target } of planned) await fs.rename(source, target);
  return planned.map(({ target }) => target);
}

export async function restoreProjectBackup({
  backupPath,
  databasePath,
  fs = fsp,
}: {
  backupPath: string;
  databasePath: string;
  fs?: typeof fsp;
}): Promise<void> {
  const temporary = `${databasePath}.restore`;
  await fs.copyFile(backupPath, temporary);
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, databasePath);
  await fs.rm(recoveryMarkerPath(databasePath), { force: true });
}

export function createProjectBackupManager({
  db,
  databasePath,
  directory,
  fs = fsp,
  now = () => new Date(),
  backup = sqlite.backup,
}: {
  db: NodeDatabaseSync;
  databasePath: string;
  directory: string;
  fs?: typeof fsp;
  now?: () => Date;
  backup?: typeof sqlite.backup;
}) {
  let queue = Promise.resolve();
  let dailyDate: string | null = null;

  async function prune(kind: BackupKind, keep: number): Promise<void> {
    const prefix = kind === 'daily' ? 'daily-' : 'pre-v';
    const files = (await verifiedFiles(fs, directory))
      .filter((file) => path.basename(file).startsWith(prefix));
    for (const file of files.slice(keep)) await fs.rm(file, { force: true });
  }

  async function create(kind: BackupKind, targetVersion?: number): Promise<string> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const current = now();
    const name = kind === 'daily'
      ? `daily-${current.toISOString().slice(0, 10)}.sqlite`
      : `pre-v${targetVersion ?? 0}-${stamp(current)}.sqlite`;
    const destination = path.join(directory, name);
    if (await exists(fs, destination)) return destination;
    const temporary = `${destination}.partial`;
    try {
      await backup(db, temporary);
      await fs.chmod(temporary, 0o600);
      // The online backup inherits WAL mode. Convert it before verification so opening the
      // finished backup never creates companion -wal/-shm files that could be lost on restore.
      makeStandaloneProjectBackup(temporary);
      if (!verifyProjectBackup(temporary)) throw new Error('Project backup failed quick_check');
      await fs.rename(temporary, destination);
      await prune(kind, kind === 'daily' ? 7 : 3);
      return destination;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  function schedule(operation: () => Promise<unknown>): Promise<void> {
    const next = queue.then(operation).then(() => {});
    queue = next.catch(() => {});
    return next;
  }

  return {
    preMigration(targetVersion: number): Promise<void> {
      return schedule(() => create('pre', targetVersion));
    },
    successfulWrite(): void {
      const date = now().toISOString().slice(0, 10);
      if (dailyDate === date) return;
      dailyDate = date;
      void schedule(() => create('daily')).catch(() => { dailyDate = null; });
    },
    flush(): Promise<void> { return queue; },
    databasePath,
  };
}
