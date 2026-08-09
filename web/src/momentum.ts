// Inertial fling for the terminal's touch scrolling (both axes). Neither the vertical scrollback
// (xterm 5.5 tracks touch 1:1: scrollTop += finger delta per touchmove, nothing on lift) nor our own
// horizontal pan has momentum. So after the finger lifts we run our own coast, driving a scroll offset
// down a decaying-velocity curve (Terminal.jsx wires this to requestAnimationFrame + the real element;
// the pure math lives here so it can be unit-tested).
//
// Frame-rate independent: friction is defined per ~16ms frame but scaled by the real elapsed dt, so the
// glide decelerates the same on a 60Hz and a 120Hz display.
export const FLING_FRICTION = 0.95; // fraction of velocity kept per 16ms — ~1s glide to a stop
export const FLING_MIN_V = 0.015;   // px/ms — below this the coast has visually stopped; end it
export const FLING_START_V = 0.1;   // px/ms — a release slower than this is a drag, not a flick: no coast
export const FLING_IDLE_MS = 50;    // finger held still longer than this before lifting → no coast

// One coast frame. v = current velocity (px/ms, +down), dt = ms since the last frame. Returns the
// scrollTop delta to apply, the decayed velocity, and whether the coast has slowed below FLING_MIN_V.
export interface FlingStep {
  delta: number;
  v: number;
  done: boolean;
}

export function flingStep(
  v: number,
  dt: number,
  friction = FLING_FRICTION,
  minV = FLING_MIN_V,
): FlingStep {
  const delta = v * dt;
  const nextV = v * friction ** (dt / 16);
  return { delta, v: nextV, done: Math.abs(nextV) < minV };
}

// Decide whether a release should coast: only a genuine flick (fast enough, AND the finger was still
// moving right up to the lift — not paused-then-released, which should stop dead).
export function shouldFling(
  v: number,
  idleMs: number,
  startV = FLING_START_V,
  idleLimit = FLING_IDLE_MS,
): boolean {
  return idleMs <= idleLimit && Math.abs(v) >= startV;
}
