import { useState, useEffect } from 'react';
import type { ServerConfig } from '../hooks/useServerConfig.js';

// Is a server-side ASR engine (iFlytek) configured? Open-source installs ship without keys, so the mic
// must HIDE rather than show a button that can only 503. Cached in localStorage so a returning configured
// install renders the mic instantly (no flash); the App's startup config updates it. Unknown (null) is
// treated as unavailable by callers — hidden until confirmed — so a fresh keyless install never flashes
// a dead mic. A transient startup fetch failure keeps the cached value rather than yanking the mic.
const KEY = 'tw_asr';

function cached(): boolean | null {
  try { const v = localStorage.getItem(KEY); return v == null ? null : v === '1'; } catch { return null; }
}

export function useAsrAvailable(config: Pick<ServerConfig, 'asr'> | null = null): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(cached);
  useEffect(() => {
    if (!config) return;
    const ok = !!config.asr;
    setAvailable(ok);
    try { localStorage.setItem(KEY, ok ? '1' : '0'); } catch { /* no localStorage in this env */ }
  }, [config]);
  return available;
}
