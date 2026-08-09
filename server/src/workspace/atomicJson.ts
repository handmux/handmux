import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

type AtomicFs = Pick<typeof fsp, 'mkdir' | 'chmod' | 'open' | 'rename' | 'unlink'>;
export interface AtomicJsonOptions { fs?: AtomicFs }

export async function ensurePrivateDir(
  dir: string,
  { fs = fsp }: AtomicJsonOptions = {},
): Promise<void> {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const privateStart = parts.indexOf('.handmux');
  const first = privateStart === -1 ? parts.length - 1 : privateStart;
  for (let index = first; index < parts.length; index += 1) {
    const current = path.join(root, ...parts.slice(0, index + 1));
    await fs.mkdir(current, { recursive: true, mode: 0o700 });
    await fs.chmod(current, 0o700);
  }
}

export async function writeJsonAtomic(
  file: string,
  value: unknown,
  { fs = fsp }: AtomicJsonOptions = {},
): Promise<void> {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}
