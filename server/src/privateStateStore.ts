import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function privateDirectoryChain(directory: string): string[] {
  const resolved = path.resolve(directory);
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const privateRoot = parts.indexOf('.handmux');
  if (privateRoot === -1) return [];
  const first = privateRoot;
  return parts.slice(first).map((_part, offset) => (
    path.join(root, ...parts.slice(0, first + offset + 1))
  ));
}

export function ensurePrivateDirectorySync(directory: string): void {
  const privateDirectories = privateDirectoryChain(directory);
  if (privateDirectories.length === 0) {
    // Explicit custom paths (for example `--config /srv/handmux.json`) may live in a shared parent that
    // Handmux does not own. Create a missing leaf privately, but never chmod an existing /tmp, HOME, or
    // administrator-managed directory. The JSON file itself is still always repaired to 0600.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  for (const current of privateDirectories) {
    fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    fs.chmodSync(current, 0o700);
  }
}

export class PrivateStateStore<T> {
  readonly file: string;

  constructor(file: string) {
    this.file = path.resolve(file);
  }

  readStrict(): T | null {
    const directory = path.dirname(this.file);
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(directory)) ensurePrivateDirectorySync(directory);
      return null;
    }
    ensurePrivateDirectorySync(directory);
    fs.chmodSync(this.file, 0o600);
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
  }

  read(): T | null {
    try {
      return this.readStrict();
    } catch {
      return null;
    }
  }

  write(value: T): void {
    const directory = path.dirname(this.file);
    ensurePrivateDirectorySync(directory);
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* never created or already removed */ }
      throw error;
    }
  }

  remove(): void {
    try { fs.unlinkSync(this.file); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
}
