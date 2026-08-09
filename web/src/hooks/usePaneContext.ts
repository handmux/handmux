import { useEffect, useRef, useState } from 'react';
import { getPaneContext } from '../api.js';

// Poll the pane's context-window state ({ model, usedPercent }) for the 对话 composer's chip. Context %
// only moves turn-to-turn, so a slow 15s poll is plenty; a failed poll keeps the last good value (no flicker
// to blank on a transient hiccup). Resets on pane switch. Silent when the capturer isn't wired (both null) —
// the composer simply renders nothing then.
const POLL_MS = 15000;

export interface PaneContext {
  model: string | null;
  usedPercent: number | null;
}

const EMPTY_CONTEXT: PaneContext = { model: null, usedPercent: null };

export function parsePaneContext(value: unknown): PaneContext | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  return {
    model: typeof context.model === 'string' ? context.model : null,
    usedPercent: typeof context.usedPercent === 'number' && Number.isFinite(context.usedPercent)
      ? context.usedPercent : null,
  };
}

export function usePaneContext(pane: string, agent = 'claude'): PaneContext {
  const [ctx, setCtx] = useState<PaneContext>(EMPTY_CONTEXT);
  const paneRef = useRef(pane);
  paneRef.current = pane;

  useEffect(() => {
    if (!pane || agent !== 'claude') { setCtx(EMPTY_CONTEXT); return undefined; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      try {
        const context = parsePaneContext(await getPaneContext(pane, agent));
        if (alive && paneRef.current === pane && context) setCtx(context);
      } catch { /* keep last good value */ }
      if (alive) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [pane, agent]);

  return ctx;
}
