import crypto from 'node:crypto';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['sessions', 'windows', 'panes'] as const;
type MappingKind = typeof KINDS[number];
type MappingGroup = Record<MappingKind, Record<string, string>>;

export interface RecoveryMappingAddition {
  names: Record<string, string>;
  runtime: MappingGroup;
  logical: MappingGroup;
}
export interface RecoveryMapping extends RecoveryMappingAddition {
  id: string;
  checkpointId: string;
  restoredAt: string;
}
type MappingPayload = RecoveryMappingAddition & { checkpointId: string } & Record<string, unknown>;

const RUNTIME_ID: Record<MappingKind, RegExp> = {
  sessions: /^\$\d+$/,
  windows: /^@\d+$/,
  panes: /^%\d+$/,
};

function fail(message: string): never {
  throw new Error(`invalid recovery mapping: ${message}`);
}

function requireExactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) fail(`${label} fields are invalid`);
  return value as Record<string, unknown>;
}

function validateRecord(
  value: unknown,
  label: string,
  keyPattern: RegExp,
  valuePattern: RegExp,
): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof entry !== 'string' || !valuePattern.test(entry)) fail(`${label} entry is invalid`);
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]));
}

function payload(mapping: MappingPayload): MappingPayload {
  return {
    checkpointId: mapping.checkpointId,
    names: mapping.names,
    runtime: mapping.runtime,
    logical: mapping.logical,
  };
}

function mappingId(mapping: MappingPayload): string {
  return crypto.createHash('sha256').update(JSON.stringify(sorted(payload(mapping)))).digest('hex');
}

function blankMapping(checkpointId: string): MappingPayload {
  return {
    checkpointId,
    names: {},
    runtime: { sessions: {}, windows: {}, panes: {} },
    logical: { sessions: {}, windows: {}, panes: {} },
  };
}

function validatePayload(mapping: Record<string, unknown>, checkpointId: string): asserts mapping is MappingPayload {
  if (typeof mapping.checkpointId !== 'string' || !mapping.checkpointId || mapping.checkpointId !== checkpointId) {
    fail('checkpoint id mismatch');
  }
  if (!mapping.names || typeof mapping.names !== 'object' || Array.isArray(mapping.names)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping.names))) fail('names must be a plain object');
  for (const [source, target] of Object.entries(mapping.names)) {
    if (!source || ['__proto__', 'constructor', 'prototype'].includes(source) || typeof target !== 'string' || !target) fail('name entry is invalid');
  }
  for (const group of ['runtime', 'logical'] as const) {
    requireExactObject(mapping[group], ['sessions', 'windows', 'panes'], group);
  }
  const runtime = mapping.runtime as Record<string, unknown>;
  const logical = mapping.logical as Record<string, unknown>;
  for (const kind of KINDS) {
    validateRecord(runtime[kind], `runtime.${kind}`, RUNTIME_ID[kind], RUNTIME_ID[kind]);
    validateRecord(logical[kind], `logical.${kind}`, UUID, RUNTIME_ID[kind]);
  }
}

export function validateRecoveryMapping(mapping: unknown, checkpointId: string): RecoveryMapping {
  const record = requireExactObject(mapping, ['id', 'checkpointId', 'restoredAt', 'names', 'runtime', 'logical'], 'mapping');
  if (typeof record.id !== 'string' || !HASH.test(record.id)) fail('id is invalid');
  if (typeof record.restoredAt !== 'string' || Number.isNaN(Date.parse(record.restoredAt))) fail('restoredAt is invalid');
  validatePayload(record, checkpointId);
  if (record.id !== mappingId(record)) fail('hash mismatch');
  return record as unknown as RecoveryMapping;
}

function merge(target: MappingPayload, source: RecoveryMappingAddition): void {
  Object.assign(target.names, source.names);
  for (const kind of KINDS) {
    Object.assign(target.runtime[kind], source.runtime[kind]);
    Object.assign(target.logical[kind], source.logical[kind]);
  }
}

function validateAddition(value: unknown, checkpointId: string): RecoveryMappingAddition {
  const record = requireExactObject(value, ['names', 'runtime', 'logical'], 'mapping addition');
  const candidate: Record<string, unknown> = { checkpointId, ...record };
  validatePayload(candidate, checkpointId);
  return candidate;
}

function hasValues(mapping: MappingPayload): boolean {
  return Object.keys(mapping.names).length > 0
    || KINDS.some((kind) => (
      Object.keys(mapping.runtime[kind]).length > 0 || Object.keys(mapping.logical[kind]).length > 0
    ));
}

export function buildRecoveryMapping(
  checkpointId: string,
  previous: unknown,
  additions: unknown,
  now: () => number = Date.now,
): RecoveryMapping | null {
  const combined = blankMapping(checkpointId);
  if (previous) merge(combined, validateRecoveryMapping(previous, checkpointId));
  if (!Array.isArray(additions)) fail('additions must be an array');
  for (const addition of additions) {
    if (addition !== null && addition !== undefined) merge(combined, validateAddition(addition, checkpointId));
  }
  if (!hasValues(combined)) return null;
  const mapping = {
    id: mappingId(combined),
    checkpointId,
    restoredAt: new Date(now()).toISOString(),
    names: combined.names,
    runtime: combined.runtime,
    logical: combined.logical,
  };
  return validateRecoveryMapping(mapping, checkpointId);
}
