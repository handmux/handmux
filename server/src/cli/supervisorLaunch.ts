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

const voiceConfig = (value: unknown): SupervisorConfig['voice'] | undefined | null => {
  if (value === undefined || value === null) return value;
  const record = recordOf(value);
  const providers = recordOf(record?.providers);
  if (!record || (record.provider !== 'xfyun' && record.provider !== 'tencent') || !providers) {
    throw new Error('invalid supervisor config: voice must select a known provider');
  }
  const xfyun = stringFields(providers.xfyun, ['appId', 'apiKey', 'apiSecret'], 'voice.providers.xfyun');
  const tencent = stringFields(
    providers.tencent,
    ['appId', 'secretId', 'secretKey', 'engineModelType'],
    'voice.providers.tencent',
  );
  return {
    provider: record.provider,
    providers: {
      ...(xfyun ? { xfyun } : {}),
      ...(tencent ? { tencent } : {}),
    },
  };
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

  const config: SupervisorConfig = {
    tunnel,
    port,
    host: record.host,
    token: record.token,
    shortcuts: normalizeShortcuts(record.shortcuts),
  };
  const name = optionalString(record.name, 'name');
  const staticDir = optionalString(record.staticDir, 'staticDir');
  const uploadExts = optionalString(record.uploadExts, 'uploadExts');
  const previewDomain = optionalString(record.previewDomain, 'previewDomain');
  const publicUrl = optionalString(record.publicUrl, 'publicUrl');
  const cloudflaredBin = optionalString(record.cloudflaredBin, 'cloudflaredBin');
  const cfTunnelName = optionalString(record.cfTunnelName, 'cfTunnelName');
  const tunliteBin = optionalString(record.tunliteBin, 'tunliteBin');
  const sshHost = optionalString(record.sshHost, 'sshHost');
  const remotePort = optionalNumber(record.remotePort, 'remotePort');
  const sshJump = optionalString(record.sshJump, 'sshJump');
  const natappBin = optionalString(record.natappBin, 'natappBin');
  const authtoken = optionalString(record.authtoken, 'authtoken');
  const cpolarBin = optionalString(record.cpolarBin, 'cpolarBin');
  const cpolarRegion = optionalString(record.cpolarRegion, 'cpolarRegion');
  const vapid = stringFields(record.vapid, ['public', 'private', 'subject'], 'vapid');
  const voice = voiceConfig(record.voice);
  const xfyun = stringFields(record.xfyun, ['appId', 'apiKey', 'apiSecret'], 'xfyun');
  if (name !== undefined) config.name = name;
  if (staticDir !== undefined) config.staticDir = staticDir;
  if (uploadExts !== undefined) config.uploadExts = uploadExts;
  if (previewDomain !== undefined) config.previewDomain = previewDomain;
  if (publicUrl !== undefined) config.publicUrl = publicUrl;
  if (typeof cloudflaredBin === 'string') config.cloudflaredBin = cloudflaredBin;
  if (cfTunnelName !== undefined) config.cfTunnelName = cfTunnelName;
  if (typeof tunliteBin === 'string') config.tunliteBin = tunliteBin;
  if (sshHost !== undefined) config.sshHost = sshHost;
  if (remotePort !== undefined) config.remotePort = remotePort;
  if (sshJump !== undefined) config.sshJump = sshJump;
  if (typeof natappBin === 'string') config.natappBin = natappBin;
  if (authtoken !== undefined) config.authtoken = authtoken;
  if (typeof cpolarBin === 'string') config.cpolarBin = cpolarBin;
  if (cpolarRegion !== undefined) config.cpolarRegion = cpolarRegion;
  if (vapid !== undefined) config.vapid = vapid;
  if (voice !== undefined) config.voice = voice;
  if (xfyun !== undefined) config.xfyun = xfyun;
  return config;
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
