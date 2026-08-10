import path from 'node:path';
import {
  readSupervisorConfig, supervisorConfigPath, writeSupervisorConfig,
} from './state.js';
import { TUNNELS } from './options.js';
import { normalizeShortcuts } from '../shortcutConfig.js';
import type { SupervisorConfig } from './supervisor.js';

export interface SupervisorLaunchOptions {
  home: string;
  entry: string;
  executable?: string;
}

export interface SupervisorConfigInput {
  payloadFile?: unknown;
  legacyPayload?: unknown;
}

type UnknownRecord = Record<string, unknown>;

const recordOf = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord : null;
const isTunnel = (value: unknown): value is SupervisorConfig['tunnel'] =>
  typeof value === 'string' && TUNNELS.some((candidate) => candidate === value);

const optionalString = (value: unknown, key: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`invalid supervisor config: ${key} must be text`);
  return value;
};

const optionalNumber = (value: unknown, key: string): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid supervisor config: ${key} must be an integer from 1 to 65535`);
  }
  return value;
};

const stringFields = (value: unknown, keys: readonly string[], key: string): Record<string, string> | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = recordOf(value);
  if (!record) throw new Error(`invalid supervisor config: ${key} must be an object`);
  const result: Record<string, string> = {};
  for (const field of keys) {
    const item = record[field];
    if (item !== undefined) {
      if (typeof item !== 'string') throw new Error(`invalid supervisor config: ${key}.${field} must be text`);
      result[field] = item;
    }
  }
  return result;
};

// The persisted file and the legacy base64 argv are untrusted process boundaries. Parse them before the
// supervisor starts so malformed or stale data fails as one explicit configuration error instead of being
// used as partially-typed process arguments.
export function parseSupervisorConfig(value: unknown): SupervisorConfig {
  const record = recordOf(value);
  if (!record) throw new Error('invalid supervisor config: expected an object');
  const tunnel = record.tunnel;
  if (!isTunnel(tunnel)) {
    throw new Error('invalid supervisor config: unknown tunnel');
  }
  const port = record.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid supervisor config: port must be an integer from 1 to 65535');
  }
  if (typeof record.host !== 'string' || !record.host) {
    throw new Error('invalid supervisor config: host is required');
  }
  if (typeof record.token !== 'string' || !record.token) {
    throw new Error('invalid supervisor config: token is required');
  }

  return {
    tunnel,
    port,
    host: record.host,
    token: record.token,
    shortcuts: normalizeShortcuts(record.shortcuts),
    name: optionalString(record.name, 'name'),
    staticDir: optionalString(record.staticDir, 'staticDir'),
    uploadExts: optionalString(record.uploadExts, 'uploadExts'),
    previewDomain: optionalString(record.previewDomain, 'previewDomain'),
    publicUrl: optionalString(record.publicUrl, 'publicUrl'),
    cloudflaredBin: optionalString(record.cloudflaredBin, 'cloudflaredBin') ?? undefined,
    cfTunnelName: optionalString(record.cfTunnelName, 'cfTunnelName'),
    tunliteBin: optionalString(record.tunliteBin, 'tunliteBin') ?? undefined,
    sshHost: optionalString(record.sshHost, 'sshHost'),
    remotePort: optionalNumber(record.remotePort, 'remotePort'),
    sshJump: optionalString(record.sshJump, 'sshJump'),
    natappBin: optionalString(record.natappBin, 'natappBin') ?? undefined,
    authtoken: optionalString(record.authtoken, 'authtoken'),
    cpolarBin: optionalString(record.cpolarBin, 'cpolarBin') ?? undefined,
    cpolarRegion: optionalString(record.cpolarRegion, 'cpolarRegion'),
    vapid: stringFields(record.vapid, ['public', 'private', 'subject'], 'vapid'),
    xfyun: stringFields(record.xfyun, ['appId', 'apiKey', 'apiSecret'], 'xfyun'),
  };
}

export function supervisorLaunchArgs(
  config: unknown,
  { home, entry, executable = process.execPath }: SupervisorLaunchOptions,
): string[] {
  writeSupervisorConfig(config, home);
  return [executable, entry, '__supervise', '--payload-file', supervisorConfigPath(home)];
}

export function readSupervisorLaunchConfig(
  { payloadFile, legacyPayload }: SupervisorConfigInput,
  home: string,
): unknown {
  if (payloadFile != null) {
    const expected = path.resolve(supervisorConfigPath(home));
    if (typeof payloadFile !== 'string' || path.resolve(payloadFile) !== expected) {
      throw new Error('invalid supervisor config path');
    }
    const config = readSupervisorConfig(home);
    if (!config) throw new Error('supervisor config is missing or invalid');
    return config;
  }
  if (typeof legacyPayload === 'string') {
    // A still-loaded pre-migration service may invoke the upgraded CLI once with its old argv. The next
    // start/service install rewrites the definition to the private config-file contract.
    return JSON.parse(Buffer.from(legacyPayload, 'base64').toString('utf8')) as unknown;
  }
  throw new Error('supervisor config is missing');
}
