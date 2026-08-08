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
  onError,
  intervalMs,
  enabled = true,
  deps = [],
  burstKey = null,
  burstIntervalMs = intervalMs,
  burstCount = 0,
}) {
  const fetchRef = useRef(fetch);
  const applyRef = useRef(apply);
  const errorRef = useRef(onError);
  fetchRef.current = fetch;
  applyRef.current = apply;
  errorRef.current = onError;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    let inFlight = false;
    let repollAfterFlight = false;
    let requestEpoch = 0;
    let burstRemaining = burstKey == null ? 0 : burstCount;
    const tick = async (myRequestEpoch) => {
      if (document.hidden) return;
      try {
        const r = await fetchRef.current();
        if (!cancelled && myRequestEpoch === requestEpoch) applyRef.current(r);
      } catch (error) {
        // Most polling surfaces intentionally keep the last good state. Callers that need to explain a
        // missing capability (for example the managed Codex connection) may additionally expose the error.
        if (!cancelled && myRequestEpoch === requestEpoch) errorRef.current?.(error);
      }
    };
    const nextDelay = () => {
      const delay = burstRemaining > 0 ? burstIntervalMs : intervalMs;
      if (burstRemaining > 0) burstRemaining -= 1;
      return delay;
    };
    const loop = async () => {
      if (cancelled || document.hidden) return;
      if (inFlight) { repollAfterFlight = true; return; }
      inFlight = true;
      const myRequestEpoch = ++requestEpoch;
      await tick(myRequestEpoch);
      // Returning from a long mobile background invalidates the request that was suspended there and
      // starts a fresh one. Its eventual result must neither apply stale state nor disturb the new loop.
      if (myRequestEpoch !== requestEpoch) return;
      inFlight = false;
      if (cancelled || document.hidden) return;
      const delay = repollAfterFlight ? 0 : nextDelay();
      repollAfterFlight = false;
      timer = setTimeout(loop, delay);
    };
    void loop();
    const onVis = () => {
      if (document.hidden) {
        clearTimeout(timer);
        // A fetch suspended by the OS may never settle after a long app switch. Logically abandon it now;
        // the epoch guard above drops its result if it eventually returns, preserving authoritative order.
        if (inFlight) {
          requestEpoch += 1;
          inFlight = false;
          repollAfterFlight = false;
        }
        return;
      }
      clearTimeout(timer);
      if (inFlight) repollAfterFlight = true;
      else void loop();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch/apply via refs; restart only on these
  }, [enabled, intervalMs, burstKey, burstIntervalMs, burstCount, ...deps]);
}
