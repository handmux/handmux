import fs from 'node:fs';
import { configPath, readState, readSupervisorConfig, statePath, supervisorConfigPath } from './state.js';
import type { OptionRecord } from './options.js';

export interface AuthDefaults {
  token?: string;
}

// Only the CLI has installation evidence. Pure config mappers must not guess whether {} is a
// newcomer or an existing setup. Authentication policy itself is persisted by the server database.
export function installationAuthDefaults(
  home: string,
  target: string = configPath(home),
  flags: OptionRecord = {},
  env: NodeJS.ProcessEnv = process.env,
): AuthDefaults & { isNew: boolean } {
  const state = readState(home);
  const supervisor = readSupervisorConfig(home);
  const hasConfig = fs.existsSync(target) || fs.existsSync(configPath(home));
  const hasHistory = fs.existsSync(statePath(home)) || fs.existsSync(supervisorConfigPath(home));
  const explicitToken = flags.token != null || env.HANDMUX_TOKEN != null;
  const isNew = !hasConfig && !hasHistory && !explicitToken;
  const token = [state?.token, supervisor?.token].find((value) => typeof value === 'string' && value.length > 0);
  return { isNew, ...(typeof token === 'string' ? { token } : {}) };
}

// Keep this shared by access output: foreground, background, and already-running startup paths.
export function tokenWarning(message: string, color: boolean = !!process.stdout.isTTY): string {
  return color ? `\u001b[33m${message}\u001b[39m` : message;
}
