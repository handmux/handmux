import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import defaultFs from 'node:fs/promises';
import path from 'node:path';

const AUTHENTICATION_ERROR = 'browser profile authentication failed';

export interface BrowserProfileMetadata {
  persist: boolean;
  retentionDays: 1 | 7 | 30 | null;
  noLeaseSince: number | null;
}
interface ProfileEnvelope { v: 1; iv: string; tag: string; data: string }
type ProfileFs = typeof defaultFs;
type RandomBytes = (size: number) => Buffer;
type FileHandle = Awaited<ReturnType<ProfileFs['open']>>;

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);
const errorCode = (error: unknown): unknown => recordOf(error)?.code;

function profileHash(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

function authenticationError(): Error {
  return new Error(AUTHENTICATION_ERROR);
}

export function createBrowserProfilePersistence({
  dir,
  keyFile,
  fs = defaultFs,
  randomBytes = nodeRandomBytes,
}: {
  dir: string;
  keyFile: string;
  fs?: ProfileFs;
  randomBytes?: RandomBytes;
}) {
  let keyPromise: Promise<Buffer> | null = null;
  const pending = new Set<Promise<unknown>>();

  const ensureDir = async (): Promise<void> => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  };

  const loadKey = async (): Promise<Buffer> => {
    await ensureDir();
    try {
      await fs.chmod(keyFile, 0o600);
      const key = await fs.readFile(keyFile);
      if (key.length !== 32) throw authenticationError();
      return key;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    const key = randomBytes(32);
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(keyFile, 'wx', 0o600);
      await handle.writeFile(key);
      await handle.sync();
      await handle.close();
      handle = null;
      return key;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (errorCode(error) === 'EEXIST') {
        await fs.chmod(keyFile, 0o600);
        const existing = await fs.readFile(keyFile);
        if (existing.length !== 32) throw authenticationError();
        return existing;
      }
      await fs.unlink(keyFile).catch(() => {});
      throw error;
    }
  };

  const key = (): Promise<Buffer> => {
    if (!keyPromise) keyPromise = loadKey();
    return keyPromise;
  };
  const profilePath = (deviceId: string): string => path.join(dir, `${profileHash(deviceId)}.profile`);
  const metadataPath = (deviceId: string): string => path.join(dir, `${profileHash(deviceId)}.meta`);

  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };

  const read = async (deviceId: string): Promise<string | null> => {
    let raw: string;
    const target = profilePath(deviceId);
    await ensureDir();
    try {
      await fs.chmod(target, 0o600);
      raw = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }

    try {
      const deviceHash = profileHash(deviceId);
      const envelope = recordOf(JSON.parse(raw) as unknown);
      if (envelope?.v !== 1
        || typeof envelope.iv !== 'string'
        || typeof envelope.tag !== 'string'
        || typeof envelope.data !== 'string') {
        throw authenticationError();
      }
      const validEnvelope = envelope as unknown as ProfileEnvelope;
      const iv = Buffer.from(validEnvelope.iv, 'base64');
      const tag = Buffer.from(validEnvelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw authenticationError();
      const decipher = createDecipheriv('aes-256-gcm', await key(), iv);
      decipher.setAAD(Buffer.from(`handmux-browser-profile:v1:${deviceHash}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(validEnvelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw authenticationError();
    }
  };

  const write = (deviceId: string, serializedJar: string): Promise<void> => track((async () => {
    const deviceHash = profileHash(deviceId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await key(), iv);
    cipher.setAAD(Buffer.from(`handmux-browser-profile:v1:${deviceHash}`));
    const encrypted = Buffer.concat([
      cipher.update(serializedJar, 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    const target = profilePath(deviceId);
    const temp = `${target}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(envelope), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  })());

  const remove = (deviceId: string): Promise<void> => track(
    fs.unlink(profilePath(deviceId)).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    }),
  );

  const readMetadata = async (deviceId: string): Promise<BrowserProfileMetadata | null> => {
    const target = metadataPath(deviceId);
    await ensureDir();
    try {
      await fs.chmod(target, 0o600);
      const value = recordOf(JSON.parse(await fs.readFile(target, 'utf8')) as unknown);
      if (typeof value?.persist !== 'boolean'
        || ![1, 7, 30, null].includes(value?.retentionDays as 1 | 7 | 30 | null)
        || (value?.noLeaseSince !== null && !Number.isFinite(value?.noLeaseSince))) {
        throw new Error('invalid browser profile metadata');
      }
      return value as unknown as BrowserProfileMetadata;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  };

  const writeMetadata = (deviceId: string, metadata: BrowserProfileMetadata): Promise<void> => track((async () => {
    await ensureDir();
    const target = metadataPath(deviceId);
    const temp = `${target}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(metadata), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  })());

  const removeMetadata = (deviceId: string): Promise<void> => track(
    fs.unlink(metadataPath(deviceId)).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    }),
  );

  const pruneExpiredProfiles = (currentTime = Date.now()): Promise<number> => track((async () => {
    await ensureDir();
    const names = await fs.readdir(dir);
    let removed = 0;
    for (const name of names) {
      const match = name.match(/^([0-9a-f]{64})\.meta$/);
      if (!match) continue;
      const metadataFile = path.join(dir, name);
      let metadata: Record<string, unknown> | null;
      try {
        metadata = recordOf(JSON.parse(await fs.readFile(metadataFile, 'utf8')) as unknown);
      } catch {
        continue;
      }
      if (metadata?.persist !== true
        || metadata.retentionDays === null
        || ![1, 7, 30].includes(metadata.retentionDays as number)
        || typeof metadata.noLeaseSince !== 'number'
        || !Number.isFinite(metadata.noLeaseSince)) continue;
      const noLeaseSince = metadata.noLeaseSince as number;
      const retentionDays = metadata.retentionDays as number;
      if (noLeaseSince + retentionDays * 24 * 60 * 60 * 1000 > currentTime) continue;
      await Promise.all([
        fs.unlink(path.join(dir, `${match[1]}.profile`)).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        }),
        fs.unlink(metadataFile).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        }),
      ]);
      removed += 1;
    }
    return removed;
  })());

  const close = async (): Promise<void> => {
    const results = await Promise.allSettled([...pending]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  };

  return {
    read, write, remove, readMetadata, writeMetadata, removeMetadata, pruneExpiredProfiles, close,
  };
}
