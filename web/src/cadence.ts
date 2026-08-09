// Adaptive poll cadence for the pane loop. While the screen keeps changing (or the user is active)
// we poll fast; after a stretch of unchanged polls we ease off to save bandwidth/battery, capped at
// 10s. Pure + DOM-free so it unit-tests deterministically (same shape as backoff.js).
export const FAST_MS = 1000;

// idleMs = time since the last change/activity. <8s → selected active rate; <60s → 5s;
// longer → 10s (cap).
export function idleDelay(idleMs: number, fastMs = FAST_MS): number {
  if (idleMs < 8000) return fastMs;
  if (idleMs < 60000) return 5000;
  return 10000;
}
