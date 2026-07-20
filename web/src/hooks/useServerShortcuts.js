import { useState } from 'react';
import { getConfig } from '../api.js';
import { DEFAULT_SERVER_SHORTCUTS } from '../shortcutMerge.js';
import { usePollingLoop } from './usePollingLoop.js';

export const SHORTCUT_REFRESH_MS = 15_000;

const valid = (value) => (
  value && Array.isArray(value.command) && Array.isArray(value.chat)
);

// Keep required quick items current while the page stays open. This matters when `handmux shortcuts`
// restarts the server: the PWA survives the disconnect, so a mount-only fetch would retain stale presets.
export function useServerShortcuts(injected = null) {
  const [shortcuts, setShortcuts] = useState(DEFAULT_SERVER_SHORTCUTS);
  usePollingLoop({
    enabled: !injected,
    intervalMs: SHORTCUT_REFRESH_MS,
    fetch: getConfig,
    apply: (cfg) => { if (valid(cfg?.shortcuts)) setShortcuts(cfg.shortcuts); },
  });
  return injected || shortcuts;
}
