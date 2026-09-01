import {
  createCipheriv, createDecipheriv, randomBytes, randomUUID,
} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { ensurePrivateDirectorySync, fsyncDirectorySync, PrivateStateStore } from './privateStateStore.js';
import {
  builtInApiAccountProviders, isProviderType, ProviderQueryError, publicProviderResult, validProviderResult,
  type ProviderDefinition, type ProviderErrorCode, type ProviderResult, type ProviderType,
  type StoredCredential,
} from './apiAccountProviders.js';

export {
  createDeepSeekProvider, createMoonshotProvider, ProviderQueryError,
  isProviderType, providerTypes, type DeepSeekBalanceResult, type MoonshotBalanceResult, type ProviderDefinition,
  type ProviderErrorCode, type ProviderResult, type ProviderType, type StoredCredential,
} from './apiAccountProviders.js';
export interface StoredApiAccount {
  id: string;
  name: string;
  providerType: ProviderType;
  credential: StoredCredential;
  credentialVersion: number;
  createdAt: number;
  updatedAt: number;
  latestSuccess: ProviderResult | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastErrorCode: ProviderErrorCode | null;
}
interface StoredApiAccountsFile { version: 1; accounts: StoredApiAccount[] }
interface EncryptedApiAccountsFile {
  version: 2;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

class PostRenameDurabilityError extends Error {
  constructor(readonly failure: unknown) {
    super('api account directory durability failed after rename');
    this.name = 'PostRenameDurabilityError';
  }
}

class ApiAccountStorageUncertainError extends Error {
  constructor() {
    super('api account storage state is uncertain');
    this.name = 'ApiAccountStorageUncertainError';
  }
}
export type ApiAccountView = Omit<StoredApiAccount, 'credential' | 'credentialVersion'> & {
  credentialConfigured: true;
};

const API_ACCOUNTS_AAD = Buffer.from('handmux-api-accounts:v2');
const API_ACCOUNTS_KEY_BYTES = 32;
const API_ACCOUNTS_IV_BYTES = 12;
const API_ACCOUNTS_TAG_BYTES = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const ERROR_CODES = new Set<ProviderErrorCode>([
  'invalid_credential', 'rate_limited', 'provider_timeout', 'provider_unreachable', 'unsupported_response',
]);
const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isNullableTimestamp = (value: unknown): value is number | null => value === null || isTimestamp(value);
const isNullableError = (value: unknown): value is ProviderErrorCode | null => value === null
  || (typeof value === 'string' && ERROR_CODES.has(value as ProviderErrorCode));

function validAccount(value: unknown): value is StoredApiAccount {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'name', 'providerType', 'credential', 'credentialVersion', 'createdAt', 'updatedAt',
      'latestSuccess', 'lastSuccessAt', 'lastAttemptAt', 'lastErrorCode',
    ])
    || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
    || typeof value.name !== 'string' || value.name !== value.name.trim()
    || [...value.name].length < 1 || [...value.name].length > 64
    || !isProviderType(value.providerType) || !isRecord(value.credential)
    || !hasExactKeys(value.credential, ['kind', 'value']) || value.credential.kind !== 'apiKey'
    || typeof value.credential.value !== 'string' || value.credential.value.length < 1 || value.credential.value.length > 4096
    || !Number.isSafeInteger(value.credentialVersion) || (value.credentialVersion as number) < 1
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || !isNullableTimestamp(value.lastSuccessAt) || !isNullableTimestamp(value.lastAttemptAt)
    || !isNullableError(value.lastErrorCode)) return false;
  return value.latestSuccess === null || validProviderResult(value.latestSuccess, value.providerType as ProviderType);
}

function validateFile(value: unknown): StoredApiAccountsFile {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'accounts'])
    || value.version !== 1 || !Array.isArray(value.accounts)
    || value.accounts.length > 1000 || !value.accounts.every(validAccount)
    || new Set(value.accounts.map((account) => account.id)).size !== value.accounts.length) {
    throw new Error('invalid api account store');
  }
  return value as unknown as StoredApiAccountsFile;
}

function validBase64(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return (bytes === undefined || decoded.length === bytes) && decoded.toString('base64') === value;
}

function validateEncryptedFile(value: unknown): EncryptedApiAccountsFile {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'algorithm', 'iv', 'tag', 'ciphertext'])
    || value.version !== 2 || value.algorithm !== 'aes-256-gcm'
    || !validBase64(value.iv, API_ACCOUNTS_IV_BYTES)
    || !validBase64(value.tag, API_ACCOUNTS_TAG_BYTES)
    || !validBase64(value.ciphertext)) throw new Error('invalid encrypted api account store');
  return value as unknown as EncryptedApiAccountsFile;
}

function apiAccountsKeyPath(file: string): string {
  return path.join(path.dirname(path.resolve(file)), 'api-accounts.key');
}

class EncryptedApiAccountStore {
  readonly #store: PrivateStateStore<unknown>;
  readonly #keyFile: string;

  constructor(file: string) {
    this.#store = new PrivateStateStore(file);
    this.#keyFile = apiAccountsKeyPath(file);
  }

  get file(): string { return this.#store.file; }

  readRaw(): { value: unknown; serialized: string } | null {
    const value = this.#store.readStrict();
    return value === null ? null : { value, serialized: fs.readFileSync(this.file, 'utf8') };
  }

  decrypt(raw: unknown): StoredApiAccountsFile {
    const envelope = validateEncryptedFile(raw);
    const key = this.#readExistingKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(API_ACCOUNTS_AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return validateFile(JSON.parse(plaintext) as unknown);
  }

  write(value: StoredApiAccountsFile): void {
    const previous = this.#currentBytes();
    try {
      this.#replaceFile(`${JSON.stringify(this.#encrypt(value), null, 2)}\n`, 'write');
    } catch (error) {
      if (!(error instanceof PostRenameDurabilityError)) throw error;
      try { this.#rollback(previous); } catch { throw new ApiAccountStorageUncertainError(); }
      throw error.failure;
    }
  }

  migrate(value: StoredApiAccountsFile, originalPlaintext: string): void {
    const envelope = this.#encrypt(value);
    try {
      this.#replaceFile(`${JSON.stringify(envelope, null, 2)}\n`, 'migration');
    } catch (error) {
      if (!(error instanceof PostRenameDurabilityError)) throw error;
      try { this.#replaceFile(originalPlaintext, 'migration-rollback'); } catch {
        throw new ApiAccountStorageUncertainError();
      }
      throw error.failure;
    }
  }

  #replaceFile(serialized: string | Buffer, operation: string): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.${operation}.tmp`;
    let descriptor: number | null = null;
    let renamed = false;
    try {
      ensurePrivateDirectorySync(path.dirname(this.file));
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, this.file);
      renamed = true;
      fsyncDirectorySync(path.dirname(this.file));
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* absent or already removed */ }
      if (renamed) throw new PostRenameDurabilityError(error);
      throw error;
    }
  }

  #currentBytes(): Buffer | null {
    try { return fs.readFileSync(this.file); } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #rollback(previous: Buffer | null): void {
    if (previous !== null) {
      this.#replaceFile(previous, 'rollback');
      return;
    }
    try { fs.unlinkSync(this.file); } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    fsyncDirectorySync(path.dirname(this.file));
  }

  #encrypt(value: StoredApiAccountsFile): EncryptedApiAccountsFile {
    const key = this.#readOrCreateKey();
    const iv = randomBytes(API_ACCOUNTS_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(API_ACCOUNTS_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      version: 2,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  quarantine(): string | null {
    const quarantined = this.#store.quarantine();
    if (quarantined) fsyncDirectorySync(path.dirname(this.file));
    return quarantined;
  }

  #readExistingKey(): Buffer {
    fs.chmodSync(this.#keyFile, 0o600);
    const key = fs.readFileSync(this.#keyFile);
    if (key.length !== API_ACCOUNTS_KEY_BYTES) throw new Error('invalid api account encryption key');
    return key;
  }

  #readOrCreateKey(): Buffer {
    const directory = path.dirname(this.#keyFile);
    try {
      const existing = this.#readExistingKey();
      fsyncDirectorySync(directory);
      return existing;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    const key = randomBytes(API_ACCOUNTS_KEY_BYTES);
    let descriptor: number | null = null;
    let complete = false;
    try {
      ensurePrivateDirectorySync(directory);
      descriptor = fs.openSync(this.#keyFile, 'wx', 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, key);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      complete = true;
      fsyncDirectorySync(directory);
      return key;
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
      }
      if (isRecord(error) && error.code === 'EEXIST') {
        const existing = this.#readExistingKey();
        fsyncDirectorySync(directory);
        return existing;
      }
      // A complete key is a safe reusable orphan when the directory durability step or the later data
      // commit fails. Only an incomplete key is removed; deleting a complete one could orphan ciphertext.
      if (!complete) try { fs.unlinkSync(this.#keyFile); } catch { /* absent or incomplete key already removed */ }
      throw error;
    }
  }
}

function hasQuarantinedCopy(file: string): boolean {
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) return false;
  const prefix = `${path.basename(file)}.corrupt.`;
  return fs.readdirSync(directory).some((name) => name.startsWith(prefix));
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiAccountInputError('invalid_name');
  const name = value.trim();
  if (!name || [...name].length > 64) throw new ApiAccountInputError('invalid_name');
  return name;
}
function cleanCredential(value: unknown): StoredCredential {
  if (!isRecord(value) || value.kind !== 'apiKey' || typeof value.value !== 'string'
    || value.value.length < 1 || value.value.length > 4096) throw new ApiAccountInputError('invalid_credential_input');
  return { kind: 'apiKey', value: value.value };
}

export class ApiAccountInputError extends Error {
  readonly code: 'invalid_name' | 'invalid_provider' | 'invalid_credential_input' | 'not_found'
    | 'conflict' | 'storage_unavailable' | 'account_limit_reached' | 'request_cancelled';
  constructor(code: ApiAccountInputError['code']) { super(code); this.name = 'ApiAccountInputError'; this.code = code; }
}

const viewOf = (account: StoredApiAccount): ApiAccountView => ({
  id: account.id,
  name: account.name,
  providerType: account.providerType,
  credentialConfigured: true,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
  latestSuccess: account.latestSuccess === null ? null : publicProviderResult(account.latestSuccess),
  lastSuccessAt: account.lastSuccessAt,
  lastAttemptAt: account.lastAttemptAt,
  lastErrorCode: account.lastErrorCode,
});

export class ApiAccountService {
  readonly #store: EncryptedApiAccountStore;
  readonly #unavailableMarker: PrivateStateStore<{ version: 1; reason: 'corrupt' }>;
  readonly #providers: ReadonlyMap<ProviderType, ProviderDefinition>;
  readonly #now: () => number;
  #accounts: StoredApiAccount[] = [];
  #storageError = false;
  #writes: Promise<void> = Promise.resolve();
  readonly #inflight = new Map<string, Promise<ApiAccountView>>();
  readonly #lastCompleted = new Map<string, number>();

  constructor({ file, providers = builtInApiAccountProviders(), now = Date.now }: {
    file: string; providers?: ProviderDefinition[]; now?: () => number;
  }) {
    this.#store = new EncryptedApiAccountStore(file);
    this.#unavailableMarker = new PrivateStateStore(`${file}.unavailable`);
    this.#providers = new Map(providers.map((provider) => [provider.type, provider]));
    this.#now = now;
    // Marker presence alone is authoritative. Its contents are deliberately not read: a partial marker
    // write must keep storage unavailable and must never send a potentially recovered primary file to
    // quarantine. A quarantined primary is the fallback sentinel if writing the marker itself failed.
    if (fs.existsSync(this.#unavailableMarker.file)) {
      this.#storageError = true;
      return;
    }
    try {
      const stored = this.#store.readRaw();
      if (stored) {
        const raw = stored.value;
        if (isRecord(raw) && raw.version === 1) {
          const plaintext = validateFile(raw);
          try {
            this.#store.migrate(plaintext, stored.serialized);
          } catch {
            // Migration must be all-or-nothing. Its final atomic rename leaves the original plaintext
            // at the primary path when the encrypted replacement cannot be committed.
            try { this.#unavailableMarker.write({ version: 1, reason: 'corrupt' }); } catch { /* migration failure wins */ }
            this.#storageError = true;
            return;
          }
          this.#accounts = plaintext.accounts;
        } else {
          this.#accounts = this.#store.decrypt(raw).accounts;
        }
      }
      else if (hasQuarantinedCopy(this.#store.file)) {
        this.#storageError = true;
      }
    } catch {
      try { this.#store.quarantine(); } catch { /* keep original failure private */ }
      try { this.#unavailableMarker.write({ version: 1, reason: 'corrupt' }); } catch { /* original failure wins */ }
      this.#storageError = true;
    }
  }

  #assertAvailable(): void { if (this.#storageError) throw new ApiAccountInputError('storage_unavailable'); }
  #provider(type: unknown): ProviderDefinition {
    if (!isProviderType(type)) throw new ApiAccountInputError('invalid_provider');
    const provider = this.#providers.get(type);
    if (!provider) throw new ApiAccountInputError('invalid_provider');
    return provider;
  }
  async #mutate<T>(change: () => T): Promise<T> {
    this.#assertAvailable();
    const previous = this.#writes;
    let release!: () => void;
    this.#writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.#assertAvailable();
      const before = structuredClone(this.#accounts);
      try {
        const result = change();
        try {
          this.#store.write({ version: 1, accounts: this.#accounts });
        } catch (error) {
          this.#accounts = before;
          this.#storageError = true;
          if (error instanceof ApiAccountStorageUncertainError) {
            try { this.#unavailableMarker.write({ version: 1, reason: 'corrupt' }); } catch {
              // The uncertain primary state remains the original failure; marker persistence is best-effort.
            }
          }
          throw new ApiAccountInputError('storage_unavailable');
        }
        return result;
      } catch (error) {
        this.#accounts = before;
        throw error;
      }
    } finally { release(); }
  }
  async #callProvider(
    provider: ProviderDefinition,
    credential: StoredCredential,
    externalSignal?: AbortSignal,
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await provider.queryBalance(credential, controller.signal);
      if (externalSignal?.aborted) throw new ApiAccountInputError('request_cancelled');
      if (!validProviderResult(result, provider.type)) throw new ProviderQueryError('unsupported_response');
      return result;
    }
    catch (error) {
      if (error instanceof ApiAccountInputError) throw error;
      if (externalSignal?.aborted) throw new ApiAccountInputError('request_cancelled');
      if (error instanceof ProviderQueryError) throw error;
      throw new ProviderQueryError(controller.signal.aborted ? 'provider_timeout' : 'provider_unreachable');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  list(): ApiAccountView[] { this.#assertAvailable(); return this.#accounts.map(viewOf); }

  async create(
    input: { providerType?: unknown; name?: unknown; credential?: unknown },
    signal?: AbortSignal,
  ): Promise<ApiAccountView> {
    this.#assertAvailable();
    if (this.#accounts.length >= 1000) throw new ApiAccountInputError('account_limit_reached');
    const provider = this.#provider(input.providerType);
    const name = cleanName(input.name);
    const credential = cleanCredential(input.credential);
    const attemptAt = this.#now();
    const result = await this.#callProvider(provider, credential, signal);
    return this.#mutate(() => {
      if (signal?.aborted) throw new ApiAccountInputError('request_cancelled');
      if (this.#accounts.length >= 1000) throw new ApiAccountInputError('account_limit_reached');
      const now = this.#now();
      const account: StoredApiAccount = {
        id: randomUUID(), name, providerType: provider.type, credential, credentialVersion: 1,
        createdAt: now, updatedAt: now, latestSuccess: result,
        lastSuccessAt: now, lastAttemptAt: attemptAt, lastErrorCode: null,
      };
      this.#accounts.push(account);
      return viewOf(account);
    });
  }

  async patch(
    id: string,
    input: { name?: unknown; credential?: unknown },
    signal?: AbortSignal,
  ): Promise<ApiAccountView> {
    this.#assertAvailable();
    const snapshot = this.#accounts.find((account) => account.id === id);
    if (!snapshot) throw new ApiAccountInputError('not_found');
    if (input.name === undefined && input.credential === undefined) throw new ApiAccountInputError('invalid_name');
    const name = input.name === undefined ? null : cleanName(input.name);
    const credentialVersion = snapshot.credentialVersion;
    if (input.credential === undefined) return this.#mutate(() => {
      const account = this.#accounts.find((candidate) => candidate.id === id);
      if (!account) throw new ApiAccountInputError('not_found');
      account.name = name!; account.updatedAt = this.#now();
      return viewOf(account);
    });
    const credential = cleanCredential(input.credential);
    const attemptAt = this.#now();
    const result = await this.#callProvider(this.#provider(snapshot.providerType), credential, signal);
    return this.#mutate(() => {
      if (signal?.aborted) throw new ApiAccountInputError('request_cancelled');
      const account = this.#accounts.find((candidate) => candidate.id === id);
      if (!account) throw new ApiAccountInputError('not_found');
      if (account.credentialVersion !== credentialVersion) throw new ApiAccountInputError('conflict');
      const now = this.#now();
      if (name !== null) account.name = name;
      account.credential = credential; account.credentialVersion += 1;
      account.updatedAt = now; account.latestSuccess = result; account.lastSuccessAt = now;
      account.lastAttemptAt = attemptAt; account.lastErrorCode = null;
      this.#lastCompleted.delete(id);
      return viewOf(account);
    });
  }

  async remove(id: string): Promise<void> {
    await this.#mutate(() => {
      const index = this.#accounts.findIndex((account) => account.id === id);
      if (index < 0) throw new ApiAccountInputError('not_found');
      this.#accounts.splice(index, 1); this.#lastCompleted.delete(id);
    });
  }

  query(id: string): Promise<ApiAccountView> {
    this.#assertAvailable();
    const existing = this.#inflight.get(id);
    if (existing) return existing;
    const completedAt = this.#lastCompleted.get(id);
    const now = this.#now();
    if (completedAt !== undefined && now - completedAt < 10_000) {
      throw new ProviderQueryError('rate_limited', Math.max(1, Math.ceil((10_000 - (now - completedAt)) / 1000)));
    }
    const account = this.#accounts.find((candidate) => candidate.id === id);
    if (!account) throw new ApiAccountInputError('not_found');
    const version = account.credentialVersion;
    const credential = account.credential;
    const provider = this.#provider(account.providerType);
    const promise = (async () => {
      const attemptAt = this.#now();
      try {
        const result = await this.#callProvider(provider, credential);
        return await this.#mutate(() => {
          const current = this.#accounts.find((candidate) => candidate.id === id);
          if (!current || current.credentialVersion !== version) throw new ApiAccountInputError('conflict');
          const successAt = this.#now();
          current.latestSuccess = result; current.lastSuccessAt = successAt;
          current.lastAttemptAt = attemptAt; current.lastErrorCode = null;
          return viewOf(current);
        });
      } catch (error) {
        if (error instanceof ProviderQueryError) {
          const recorded = await this.#mutate(() => {
            const current = this.#accounts.find((candidate) => candidate.id === id);
            if (current && current.credentialVersion === version) {
              current.lastAttemptAt = attemptAt; current.lastErrorCode = error.code;
              return true;
            }
            return false;
          });
          if (!recorded) throw new ApiAccountInputError('conflict');
        }
        throw error;
      } finally {
        this.#lastCompleted.set(id, this.#now());
        this.#inflight.delete(id);
      }
    })();
    this.#inflight.set(id, promise);
    return promise;
  }
}

export const apiAccountsPath = (home: string): string => path.join(home, '.handmux', 'api-accounts.json');
