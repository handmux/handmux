import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSessionRef } from './run.js';
import type {
  AgentResourceContent,
  AgentResourceRegistry,
  AgentResourceRegistration,
  AgentResourceSource,
} from './resourceTypes.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTE_STORAGE = 64 * 1024 * 1024;
const DEFAULT_MAX_RESOURCES = 1024;
const DEFAULT_MAX_SESSION_RESOURCES = 128;
const RESOURCE_ID_RE = /^[a-zA-Z0-9_-]{16,256}$/;
const MEDIA_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;

export class AgentResourceError extends Error {
  constructor(
    readonly code:
      | 'invalid-source'
      | 'path-denied'
      | 'resource-too-large'
      | 'capacity-exceeded'
      | 'resource-changed',
    message: string,
  ) {
    super(message);
    this.name = 'AgentResourceError';
  }
}

interface FileRecord {
  kind: 'file';
  path: string;
  roots: string[];
  dev: number;
  ino: number;
  mtimeMs: number;
}

interface BytesRecord {
  kind: 'bytes';
  data: Uint8Array;
}

interface ResourceRecordBase {
  resourceId: string;
  agentId: string;
  sessionId: string;
  name?: string;
  mediaType: string;
  size: number;
  expiresAt: number;
}

type ResourceRecord = ResourceRecordBase & (FileRecord | BytesRecord);

export interface AgentResourceServiceOptions {
  allowedFileRoots?: Readonly<Record<string, readonly string[]>>;
  now?: () => number;
  newResourceId?: () => string;
  ttlMs?: number;
  maxResourceBytes?: number;
  maxByteStorage?: number;
  maxResources?: number;
  maxSessionResources?: number;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}

function validSession(value: unknown): value is AgentSessionRef {
  return value !== null && typeof value === 'object'
    && validText((value as AgentSessionRef).agentId, 64)
    && validText((value as AgentSessionRef).sessionId, 1024);
}

function validName(value: unknown): value is string | undefined {
  return value === undefined || (validText(value, 1024) && !/[\\/\0-\x1f\x7f]/.test(value));
}

function validMediaType(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_TYPE_RE.test(value);
}

function within(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

export class AgentResourceService {
  readonly #allowedFileRoots: Readonly<Record<string, readonly string[]>>;
  readonly #now: () => number;
  readonly #newResourceId: () => string;
  readonly #ttlMs: number;
  readonly #maxResourceBytes: number;
  readonly #maxByteStorage: number;
  readonly #maxResources: number;
  readonly #maxSessionResources: number;
  readonly #records = new Map<string, ResourceRecord>();
  #byteStorage = 0;

  constructor({
    allowedFileRoots = {},
    now = Date.now,
    newResourceId = randomUUID,
    ttlMs = DEFAULT_TTL_MS,
    maxResourceBytes = DEFAULT_MAX_RESOURCE_BYTES,
    maxByteStorage = DEFAULT_MAX_BYTE_STORAGE,
    maxResources = DEFAULT_MAX_RESOURCES,
    maxSessionResources = DEFAULT_MAX_SESSION_RESOURCES,
  }: AgentResourceServiceOptions = {}) {
    this.#allowedFileRoots = allowedFileRoots;
    this.#now = now;
    this.#newResourceId = newResourceId;
    this.#ttlMs = positiveLimit(ttlMs, DEFAULT_TTL_MS);
    this.#maxResourceBytes = positiveLimit(maxResourceBytes, DEFAULT_MAX_RESOURCE_BYTES);
    this.#maxByteStorage = positiveLimit(maxByteStorage, DEFAULT_MAX_BYTE_STORAGE);
    this.#maxResources = positiveLimit(maxResources, DEFAULT_MAX_RESOURCES);
    this.#maxSessionResources = positiveLimit(maxSessionResources, DEFAULT_MAX_SESSION_RESOURCES);
  }

  forAdapter(agentId: string): AgentResourceRegistry {
    if (!validText(agentId, 64)) throw new TypeError('Agent resource registry requires an adapter id');
    return Object.freeze({
      register: (session: AgentSessionRef, source: AgentResourceSource) => (
        this.#register(agentId, session, source)
      ),
      revoke: (resourceId: string) => this.#revoke(agentId, resourceId),
    });
  }

  async read(session: AgentSessionRef, resourceId: string): Promise<AgentResourceContent | null> {
    if (!validSession(session) || !RESOURCE_ID_RE.test(resourceId)) return null;
    this.clearExpired();
    const record = this.#records.get(resourceId);
    if (!record || record.agentId !== session.agentId || record.sessionId !== session.sessionId) return null;
    let data: Uint8Array;
    if (record.kind === 'bytes') {
      data = new Uint8Array(record.data);
    } else {
      try {
        const resolved = await realpath(record.path);
        if (resolved !== record.path || !record.roots.some((root) => within(root, resolved))) {
          this.#delete(record);
          throw new AgentResourceError('resource-changed', 'Agent resource path changed after registration');
        }
        const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== record.size || stat.size > this.#maxResourceBytes
            || stat.dev !== record.dev || stat.ino !== record.ino || stat.mtimeMs !== record.mtimeMs) {
            this.#delete(record);
            throw new AgentResourceError('resource-changed', 'Agent resource changed after registration');
          }
          data = new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof AgentResourceError) throw error;
        this.#delete(record);
        throw new AgentResourceError('resource-changed', 'Agent resource is no longer readable');
      }
    }
    return {
      resourceId,
      session: { agentId: record.agentId, sessionId: record.sessionId },
      data,
      size: record.size,
      ...(record.name === undefined ? {} : { name: record.name }),
      mediaType: record.mediaType,
      expiresAt: record.expiresAt,
    };
  }

  clearExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const record of this.#records.values()) {
      if (record.expiresAt > now) continue;
      this.#delete(record);
      removed += 1;
    }
    return removed;
  }

  revokeAdapter(agentId: string): void {
    for (const record of this.#records.values()) {
      if (record.agentId === agentId) this.#delete(record);
    }
  }

  async #register(
    agentId: string,
    session: AgentSessionRef,
    source: AgentResourceSource,
  ): Promise<AgentResourceRegistration> {
    if (!validSession(session) || session.agentId !== agentId || !source || typeof source !== 'object'
      || !validName(source.name)) {
      throw new AgentResourceError('invalid-source', 'Invalid Agent resource owner or metadata');
    }
    this.clearExpired();
    const sessionCount = [...this.#records.values()].filter((record) => (
      record.agentId === agentId && record.sessionId === session.sessionId
    )).length;
    if (this.#records.size >= this.#maxResources || sessionCount >= this.#maxSessionResources) {
      throw new AgentResourceError('capacity-exceeded', 'Agent resource capacity is exhausted');
    }

    const common = {
      resourceId: this.#allocateId(),
      agentId,
      sessionId: session.sessionId,
      expiresAt: this.#now() + this.#ttlMs,
    };
    let record: ResourceRecord;
    if (source.kind === 'bytes') {
      if (!(source.data instanceof Uint8Array) || !validMediaType(source.mediaType)) {
        throw new AgentResourceError('invalid-source', 'Invalid Agent byte resource');
      }
      const data = new Uint8Array(source.data);
      if (data.byteLength > this.#maxResourceBytes) {
        throw new AgentResourceError('resource-too-large', 'Agent resource exceeds the size limit');
      }
      if (this.#byteStorage + data.byteLength > this.#maxByteStorage) {
        throw new AgentResourceError('capacity-exceeded', 'Agent byte resource storage is exhausted');
      }
      record = {
        ...common,
        kind: 'bytes',
        data,
        size: data.byteLength,
        ...(source.name === undefined ? {} : { name: source.name }),
        mediaType: source.mediaType,
      };
    } else if (source.kind === 'file') {
      if (!validText(source.path, 16 * 1024) || !isAbsolute(source.path)
        || (source.mediaType !== undefined && !validMediaType(source.mediaType))) {
        throw new AgentResourceError('invalid-source', 'Invalid Agent file resource');
      }
      const roots = await Promise.all((this.#allowedFileRoots[agentId] ?? []).map((root) => realpath(root)));
      let resolved: string;
      try { resolved = await realpath(source.path); } catch {
        throw new AgentResourceError('path-denied', 'Agent resource file is unavailable');
      }
      if (!roots.some((root) => within(root, resolved))) {
        throw new AgentResourceError('path-denied', 'Agent resource file is outside allowed roots');
      }
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let stat;
      try { stat = await handle.stat(); } finally { await handle.close(); }
      if (!stat.isFile()) throw new AgentResourceError('invalid-source', 'Agent resource must be a regular file');
      if (stat.size > this.#maxResourceBytes) {
        throw new AgentResourceError('resource-too-large', 'Agent resource exceeds the size limit');
      }
      const basenameValue = basename(resolved).replace(/[\0-\x1f\x7f]/g, '_');
      record = {
        ...common,
        kind: 'file',
        path: resolved,
        roots,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        name: source.name ?? basenameValue,
        mediaType: source.mediaType ?? 'application/octet-stream',
      };
    } else {
      throw new AgentResourceError('invalid-source', 'Unknown Agent resource source');
    }
    this.#records.set(record.resourceId, record);
    if (record.kind === 'bytes') this.#byteStorage += record.size;
    return { resourceId: record.resourceId, expiresAt: record.expiresAt };
  }

  async #revoke(agentId: string, resourceId: string): Promise<void> {
    if (!RESOURCE_ID_RE.test(resourceId)) return;
    const record = this.#records.get(resourceId);
    if (record?.agentId === agentId) this.#delete(record);
  }

  #allocateId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#newResourceId();
      if (RESOURCE_ID_RE.test(candidate) && !this.#records.has(candidate)) return candidate;
    }
    throw new AgentResourceError('capacity-exceeded', 'Unable to allocate an Agent resource id');
  }

  #delete(record: ResourceRecord): void {
    if (!this.#records.delete(record.resourceId)) return;
    if (record.kind === 'bytes') this.#byteStorage -= record.size;
  }
}
