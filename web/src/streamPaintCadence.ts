export const STREAM_PAINT_INTERVAL_MS = 33;

export interface StreamPaintTiming {
  now: number;
  lastPaintAt: number | null | undefined;
  immediate?: boolean;
  intervalMs?: number;
}

export function streamPaintDelay({
  now,
  lastPaintAt,
  immediate = false,
  intervalMs = STREAM_PAINT_INTERVAL_MS,
}: StreamPaintTiming): number {
  if (immediate || !Number.isFinite(lastPaintAt)) return 0;
  return Math.max(0, intervalMs - Math.max(0, now - (lastPaintAt as number)));
}
