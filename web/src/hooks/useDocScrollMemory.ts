// Remembers where the reader was, per document, as a scroll RATIO (0..1) of the container.
//
// A ratio rather than a sentence index on purpose: it survives the file being edited under the reader
// (an agent rewriting the doc), needs no read-aloud state, and degrades gracefully — a shorter document
// just clamps. It is saved on a short debounce while scrolling (not on every pixel) and once more on
// unmount, and restored after the content has been rendered.
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { getDocScrollRatio, setDocScrollRatio } from '../storage.js';

const SAVE_DEBOUNCE_MS = 400;

export function useDocScrollMemory(
  path: string | null,
  wrapRef: RefObject<HTMLElement | null>,
  html: string,
): void {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ path: string; ratio: number } | null>(null);

  // Restore once per (path, content). Runs after the document is in the DOM, without animation.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !path) return;
    const ratio = getDocScrollRatio(path);
    const scrollable = wrap.scrollHeight - wrap.clientHeight;
    // A ratio from a much longer previous revision can be meaningless; only restore a real position.
    if (ratio > 0 && scrollable > 0) wrap.scrollTop = Math.round(scrollable * ratio);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, html]);

  // Track + persist. Skipped until the first restore effect has run for this path.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !path) return undefined;
    const save = (): void => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const scrollable = wrap.scrollHeight - wrap.clientHeight;
        if (scrollable <= 0) return;
        latest.current = { path, ratio: wrap.scrollTop / scrollable };
        setDocScrollRatio(path, latest.current.ratio);
      }, SAVE_DEBOUNCE_MS);
    };
    wrap.addEventListener('scroll', save, { passive: true });
    return () => {
      wrap.removeEventListener('scroll', save);
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      // Flush on the way out so leaving the doc (tab switch, closing the sheet) keeps the position.
      const scrollable = wrap.scrollHeight - wrap.clientHeight;
      if (scrollable > 0) setDocScrollRatio(path, wrap.scrollTop / scrollable);
    };
  }, [path, wrapRef]);
}
