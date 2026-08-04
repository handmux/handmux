import { useEffect, useRef } from 'react';

// A self-scheduling poll loop (NOT setInterval): fetch → apply on a fixed cadence, paused entirely while
// the tab is hidden and re-polled immediately on return. Extracted from the two identical inbox loops in
// App (states @5s, orphans @15s). `fetch`/`apply` are split so the loop owns the cancelled guard — a fetch
// still in flight when the effect re-runs (a dep changed) or unmounts must NOT apply its now-stale result
// (e.g. a states poll for the OLD bound-session filter overwriting the new one). `fetch`/`apply` are held
// in refs so an unstable inline closure doesn't restart the loop every render; the loop restarts (and
// immediately re-polls) only when `enabled`, cadence, `burstKey`, or a value in `deps` changes. A non-null
// burstKey adds a bounded number of quicker follow-ups, then the loop automatically returns to intervalMs.
export function usePollingLoop({
  fetch,
  apply,
  intervalMs,
  enabled = true,
  deps = [],
  burstKey = null,
  burstIntervalMs = intervalMs,
  burstCount = 0,
}) {
  const fetchRef = useRef(fetch);
  const applyRef = useRef(apply);
  fetchRef.current = fetch;
  applyRef.current = apply;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    let burstRemaining = burstKey == null ? 0 : burstCount;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetchRef.current();
        if (!cancelled) applyRef.current(r);
      } catch { /* ignore — a failed poll just keeps the last good state */ }
    };
    const loop = () => {
      tick();
      const delay = burstRemaining > 0 ? burstIntervalMs : intervalMs;
      if (burstRemaining > 0) burstRemaining -= 1;
      timer = setTimeout(loop, delay);
    };
    loop();
    const onVis = () => { if (!document.hidden) { clearTimeout(timer); loop(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch/apply via refs; restart only on these
  }, [enabled, intervalMs, burstKey, burstIntervalMs, burstCount, ...deps]);
}
