import { useState, useEffect, useCallback } from 'react';
import { installClaudeHooks } from './api.js';
import type { ClaudeHooksStatus, ServerConfig } from './hooks/useServerConfig.js';

// The inbox needs to tell three situations apart: hooks installed (normal empty state), Claude Code present
// but hooks not installed (offer to enable), and no Claude Code at all (don't nag). The server reports this
// on /api/config as `claudeHooks`; older servers omit it → treat as 'installed' (back-compat, never nag).
// Cached in localStorage so a returning install renders without a flash; the App's startup config updates it.
const KEY = 'tw_claude_hooks';

function hookStatus(value: unknown): ClaudeHooksStatus | null {
  return value === 'installed' || value === 'absent' || value === 'no-claude' ? value : null;
}

function cached(): ClaudeHooksStatus | null {
  try { return hookStatus(localStorage.getItem(KEY)); } catch { return null; }
}

export function useClaudeHooks(config: Pick<ServerConfig, 'claudeHooks'> | null = null): {
  status: ClaudeHooksStatus | null;
  enable: () => Promise<unknown>;
} {
  const [status, setStatus] = useState<ClaudeHooksStatus | null>(cached);
  useEffect(() => {
    if (!config) return;
    const s: ClaudeHooksStatus = config.claudeHooks || 'installed'; // field absent on old servers → don't nag
    setStatus(s);
    try { localStorage.setItem(KEY, s); } catch { /* no localStorage in this env */ }
  }, [config]);

  const enable = useCallback(async () => {
    const result: unknown = await installClaudeHooks();
    const record = result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown> : null;
    const nextStatus = hookStatus(record?.status);
    if (nextStatus) {
      setStatus(nextStatus);
      try { localStorage.setItem(KEY, nextStatus); } catch { /* ignore */ }
    }
    return result;
  }, []);

  return { status, enable };
}
