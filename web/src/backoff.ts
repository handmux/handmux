// Exponential backoff with a cap and ±jitter, for the pane poll loop's retry cadence.
// failCount is the number of consecutive failures so far (1 = first failure). Returns the
// delay in ms before the next attempt; 0 when there's been no failure (the caller uses the
// normal refresh interval instead). DOM-free and rng-injectable so it unit-tests deterministically.
export interface BackoffOptions {
  base?: number;
  max?: number;
  factor?: number;
  jitter?: number;
  rng?: () => number;
}

export function backoffDelay(
  failCount: number,
  {
    base = 1000,
    max = 10000,
    factor = 2,
    jitter = 0.2,
    rng = Math.random,
  }: BackoffOptions = {},
): number {
  if (failCount <= 0) return 0;
  const raw = Math.min(max, base * factor ** (failCount - 1));
  return Math.round(raw * (1 + jitter * (rng() * 2 - 1)));
}
