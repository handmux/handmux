import { normalizeShortcuts } from './shortcutConfig.js';

export function loadConfig(env = process.env) {
  return {
    host: env.HANDMUX_HOST || '0.0.0.0',
    port: Number(env.HANDMUX_PORT) || 4000,
    shortcuts: normalizeShortcuts(env.HANDMUX_SHORTCUTS === undefined ? undefined : JSON.parse(env.HANDMUX_SHORTCUTS)),
  };
}
