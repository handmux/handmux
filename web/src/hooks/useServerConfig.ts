import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getConfig } from '../api.js';
import { DEFAULT_SERVER_SHORTCUTS } from '../shortcutMerge.js';
import type { ServerShortcuts, ShortcutPreset } from '../shortcutMerge.js';

export type ClaudeHooksStatus = 'installed' | 'absent' | 'no-claude';

export interface ServerConfig {
  asr?: boolean;
  asrProvider?: 'xfyun' | 'tencent' | null;
  claudeHooks?: ClaudeHooksStatus;
  managedCodex?: boolean;
  browserProxy?: boolean;
  shortcuts: ServerShortcuts;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const shortcutOf = (value: unknown): ShortcutPreset | null => {
  const item = recordOf(value);
  if (item?.type === 'key' && typeof item.key === 'string' && item.key) {
    return {
      type: 'key', key: item.key,
      ...(typeof item.label === 'string' && item.label ? { label: item.label } : {}),
    };
  }
  if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
    return {
      type: 'text', text: item.text,
      ...(typeof item.enter === 'boolean' ? { enter: item.enter } : {}),
    };
  }
  return null;
}

const shortcutsOf = (value: unknown): ServerShortcuts | null => {
  const shortcuts = recordOf(value);
  if (!Array.isArray(shortcuts?.command) || !Array.isArray(shortcuts.chat)) return null;
  return {
    command: shortcuts.command.map(shortcutOf)
      .filter((item): item is ShortcutPreset => item !== null),
    chat: shortcuts.chat.map(shortcutOf)
      .filter((item): item is ShortcutPreset => item !== null),
  };
};

const HOOK_STATUSES = new Set<ClaudeHooksStatus>(['installed', 'absent', 'no-claude']);

export function parseServerConfig(value: unknown): ServerConfig | null {
  const config = recordOf(value);
  if (!config) return null;
  const claudeHooks = typeof config.claudeHooks === 'string'
    && HOOK_STATUSES.has(config.claudeHooks as ClaudeHooksStatus)
    ? config.claudeHooks as ClaudeHooksStatus : undefined;
  return {
    shortcuts: shortcutsOf(config.shortcuts) || DEFAULT_SERVER_SHORTCUTS,
    ...(typeof config.asr === 'boolean' ? { asr: config.asr } : {}),
    ...(config.asrProvider === null || config.asrProvider === 'xfyun' || config.asrProvider === 'tencent'
      ? { asrProvider: config.asrProvider } : {}),
    ...(claudeHooks ? { claudeHooks } : {}),
    ...(typeof config.managedCodex === 'boolean' ? { managedCodex: config.managedCodex } : {}),
    ...(typeof config.browserProxy === 'boolean' ? { browserProxy: config.browserProxy } : {}),
  };
}

// Load the app-wide config after authentication and whenever the app returns to the foreground.
// Consumers share this snapshot; there is no timer-based polling.
export function useServerConfig({ enabled = true }: { enabled?: boolean } = {}): ServerConfig | null {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const requested = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);
  const enabledEpoch = useRef(0);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Update this before passive-effect cleanup so a stale visibility listener cannot cross auth cycles.
  useLayoutEffect(() => {
    if (enabledRef.current === enabled) return;
    enabledRef.current = enabled;
    enabledEpoch.current += 1;
  }, [enabled]);

  const refresh = useCallback(() => {
    if (!mounted.current || !enabledRef.current || inFlight.current) return;
    inFlight.current = true;
    const epoch = enabledEpoch.current;
    let request: Promise<unknown>;
    try { request = getConfig(); } catch { inFlight.current = false; return; }
    Promise.resolve(request).then((value: unknown) => {
      const cfg = parseServerConfig(value);
      if (
        !mounted.current || !enabledRef.current || enabledEpoch.current !== epoch
        || !cfg
      ) return;
      setConfig(cfg);
    }).catch(() => {}).finally(() => { inFlight.current = false; });
  }, []);

  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;
    refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onVisibility = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, refresh]);

  return config;
}
