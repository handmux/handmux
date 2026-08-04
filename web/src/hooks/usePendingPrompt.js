import { useCallback, useEffect, useRef, useState } from 'react';
import { getPendingPrompt } from '../api.js';

// Poll the pane's pending prompt (AskUserQuestion / permission menu) while a gate is up. The gate's options
// live only in the rendered TUI (not the transcript), so this scrapes them server-side via /api/pending-
// prompt. `active` gates the polling — pass kind==='permission' so we only hit the endpoint while Claude is
// actually blocked on a choice. Returns { prompt, refetch }: prompt is the parsed menu (or null), refetch
// forces an immediate re-read (used right after the user answers so the next question / review appears fast).
const POLL_MS = 1200;
const AFTER_ACT_MS = 450; // the screen takes ~½s to redraw after a keystroke; re-read once it has

export function usePendingPrompt(pane, active, agent = 'claude') {
  const [prompt, setPrompt] = useState(null);
  const aliveRef = useRef(true);

  const read = useCallback(async () => {
    if (!pane || !active) { setPrompt(null); return; }
    try {
      const p = await getPendingPrompt(pane, agent);
      if (aliveRef.current) setPrompt(p);
    } catch { /* transient — keep the last prompt on screen */ }
  }, [pane, active, agent]);

  // Force a read shortly after an answer, so the advance (next question / review / gate-gone) shows promptly
  // without waiting for the next poll tick.
  const refetch = useCallback(() => { setTimeout(() => { read(); }, AFTER_ACT_MS); }, [read]);

  useEffect(() => {
    aliveRef.current = true;
    if (!active) { setPrompt(null); return () => { aliveRef.current = false; }; }
    read();
    const id = setInterval(read, POLL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, [pane, active, agent, read]);

  return { prompt, refetch };
}
