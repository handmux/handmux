import fs from 'node:fs';
import { configPath, readState, readSupervisorConfig, statePath, supervisorConfigPath } from './state.js';
import type { OptionRecord } from './options.js';

export interface AuthDefaults {
  authMode: 'token' | 'trusted-device';
  token?: string;
}

// Only the CLI has installation evidence. Pure config mappers must not guess whether {} is a
// newcomer or a legacy empty config. Missing authMode in a persisted config remains legacy token.
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
  const prior = state ?? supervisor;
  const authMode = !hasConfig && prior?.authMode === 'trusted-device'
    ? 'trusted-device' : isNew ? 'trusted-device' : 'token';
  const token = [state?.token, supervisor?.token].find((value) => typeof value === 'string' && value.length > 0);
  return { isNew, authMode, ...(typeof token === 'string' ? { token } : {}) };
}

// Keep this shared by access output: foreground, background, and already-running startup paths.
export function tokenWarning(message: string, color: boolean = !!process.stdout.isTTY): string {
  return color ? `\u001b[33m${message}\u001b[39m` : message;
}

// A manually edited config is already an explicit persistent choice. CLI/environment overrides
// changing an existing installation still need consent BEFORE restart can stop the running service.
export function authOverrideNeedsConfirmation({
  flags, fileCfg, env, defaults, runningMode,
}: {
  flags: OptionRecord; fileCfg: OptionRecord; env: NodeJS.ProcessEnv;
  defaults: AuthDefaults & { isNew: boolean }; runningMode?: string | undefined;
}): boolean {
  const override = flags.authMode ?? (fileCfg.authMode == null ? env.HANDMUX_AUTH_MODE : undefined);
  if (override == null || defaults.isNew) return false;
  const current = runningMode ?? fileCfg.authMode ?? defaults.authMode;
  return override !== current;
}
