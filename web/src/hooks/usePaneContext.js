import { useEffect, useRef, useState } from 'react';
import { getPaneContext } from '../api.js';

// Poll the pane's context-window state ({ model, usedPercent }) for the 对话 composer's chip. Context %
// only moves turn-to-turn, so a slow 15s poll is plenty; a failed poll keeps the last good value (no flicker
// to blank on a transient hiccup). Resets on pane switch. Silent when the capturer isn't wired (both null) —
// the composer simply renders nothing then.
const POLL_MS = 15000;

export function usePaneContext(pane, agent = 'claude') {
  const [ctx, setCtx] = useState({ model: null, usedPercent: null });
  const paneRef = useRef(pane);
  paneRef.current = pane;

  useEffect(() => {
    if (!pane || agent !== 'claude') { setCtx({ model: null, usedPercent: null }); return; }
    let alive = true;
    let timer = null;
    const tick = async () => {
      try {
        const r = await getPaneContext(pane, agent);
        if (alive && paneRef.current === pane && r) setCtx({ model: r.model ?? null, usedPercent: typeof r.usedPercent === 'number' ? r.usedPercent : null });
      } catch { /* keep last good value */ }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [pane, agent]);

  return ctx;
}
