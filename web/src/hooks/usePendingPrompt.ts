import { useCallback, useEffect, useRef, useState } from 'react';
import { getPendingPrompt } from '../api.js';

export interface PendingPromptOption {
  n: number;
  label: string;
  description?: string;
}

export interface PendingPrompt {
  title: string;
  leadIn?: string;
  cursor?: number | null;
  multi?: boolean;
  step?: number;
  total?: number;
  submit?: boolean;
  options: PendingPromptOption[];
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export function parsePendingPrompt(value: unknown): PendingPrompt | null {
  const prompt = recordOf(value);
  if (!prompt || typeof prompt.title !== 'string' || !prompt.title
    || !Array.isArray(prompt.options)) return null;
  const options = prompt.options.flatMap((candidate): PendingPromptOption[] => {
    const option = recordOf(candidate);
    if (!option || typeof option.n !== 'number' || !Number.isInteger(option.n)
      || typeof option.label !== 'string' || !option.label) return [];
    return [{
      n: option.n,
      label: option.label,
      ...(typeof option.description === 'string' && option.description
        ? { description: option.description } : {}),
    }];
  });
  if (!options.length) return null;
  const finite = (key: string): number | undefined => (
    typeof prompt[key] === 'number' && Number.isFinite(prompt[key])
      ? prompt[key] as number : undefined
  );
  return {
    title: prompt.title,
    options,
    ...(typeof prompt.leadIn === 'string' && prompt.leadIn ? { leadIn: prompt.leadIn } : {}),
    ...(prompt.cursor === null ? { cursor: null }
      : finite('cursor') !== undefined ? { cursor: finite('cursor') } : {}),
    ...(prompt.multi === true ? { multi: true } : {}),
    ...(finite('step') !== undefined ? { step: finite('step') } : {}),
    ...(finite('total') !== undefined ? { total: finite('total') } : {}),
    ...(prompt.submit === true ? { submit: true } : {}),
  };
}

// Poll the pane's pending prompt (AskUserQuestion / permission menu) while a gate is up. The gate's options
// live only in the rendered TUI (not the transcript), so this scrapes them server-side via /api/pending-
// prompt. `active` gates the polling — pass kind==='permission' so we only hit the endpoint while Claude is
// actually blocked on a choice. Returns { prompt, refetch }: prompt is the parsed menu (or null), refetch
// forces an immediate re-read (used right after the user answers so the next question / review appears fast).
const POLL_MS = 1200;
const AFTER_ACT_MS = 450; // the screen takes ~½s to redraw after a keystroke; re-read once it has

export function usePendingPrompt(
  pane: string,
  active: boolean,
  agent = 'claude',
): { prompt: PendingPrompt | null; refetch: () => void } {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const aliveRef = useRef(true);

  const read = useCallback(async (): Promise<void> => {
    if (!pane || !active) { setPrompt(null); return; }
    try {
      const p = parsePendingPrompt(await getPendingPrompt(pane, agent));
      if (aliveRef.current) setPrompt(p);
    } catch { /* transient — keep the last prompt on screen */ }
  }, [pane, active, agent]);

  // Force a read shortly after an answer, so the advance (next question / review / gate-gone) shows promptly
  // without waiting for the next poll tick.
  const refetch = useCallback((): void => {
    setTimeout(() => { void read(); }, AFTER_ACT_MS);
  }, [read]);

  useEffect(() => {
    aliveRef.current = true;
    if (!active) { setPrompt(null); return () => { aliveRef.current = false; }; }
    void read();
    const id = setInterval(() => { void read(); }, POLL_MS);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, [pane, active, agent, read]);

  return { prompt, refetch };
}
