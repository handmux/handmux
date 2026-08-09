import path from 'node:path';
import {
  readSupervisorConfig, supervisorConfigPath, writeSupervisorConfig,
} from './state.js';

export interface SupervisorLaunchOptions {
  home: string;
  entry: string;
  executable?: string;
}

export interface SupervisorConfigInput {
  payloadFile?: unknown;
  legacyPayload?: unknown;
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
