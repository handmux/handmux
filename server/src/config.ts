import { normalizeShortcuts } from './shortcutConfig.js';
import type { ShortcutConfig } from './shortcutConfig.js';

export interface ServerConfig {
  host: string;
  port: number;
  shortcuts: ShortcutConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HANDMUX_HOST || '0.0.0.0',
    port: Number(env.HANDMUX_PORT) || 4000,
    shortcuts: normalizeShortcuts(env.HANDMUX_SHORTCUTS === undefined ? undefined : JSON.parse(env.HANDMUX_SHORTCUTS)),
  };
}
