import { describe, expect, it } from 'vitest';
import { flingStep, shouldFling, FLING_FRICTION, FLING_MIN_V, FLING_START_V } from '../src/momentum.js';

describe('flingStep', () => {
  it('moves by v*dt and decays the velocity', () => {
    const { delta, v } = flingStep(2, 16);
    expect(delta).toBe(32);                 // 2 px/ms * 16 ms
    expect(v).toBeCloseTo(2 * FLING_FRICTION); // one frame of friction
  });

  it('decays frame-rate independently: two 8ms frames leave the same velocity as one 16ms frame', () => {
    // friction**(dt/16) composes, so the velocity after a given elapsed time is independent of how
    // many frames it took to get there — the glide decelerates the same at 60Hz and 120Hz.
    const oneFrame = flingStep(1, 16).v;
    const a = flingStep(1, 8);
    const twoFrames = flingStep(a.v, 8).v;
    expect(twoFrames).toBeCloseTo(oneFrame, 5);
  });

  it('reports done once the velocity slows below the floor', () => {
    expect(flingStep(FLING_MIN_V * 2, 16).done).toBe(false);
    expect(flingStep(FLING_MIN_V * 0.5, 16).done).toBe(true);
  });

  it('coasts to a stop in a bounded number of frames (no infinite loop)', () => {
    let v = 3; // a hard flick
    let frames = 0;
    let dist = 0;
    for (; frames < 1000; frames++) {
      const s = flingStep(v, 16);
      dist += s.delta;
      v = s.v;
      if (s.done) break;
    }
    expect(frames).toBeLessThan(300);      // ~a few seconds at most
    expect(dist).toBeGreaterThan(0);       // it actually traveled
  });
});

describe('shouldFling', () => {
  it('coasts on a fast flick that was still moving at release', () => {
    expect(shouldFling(FLING_START_V * 2, 0)).toBe(true);
    expect(shouldFling(-FLING_START_V * 2, 10)).toBe(true); // sign-agnostic
  });
  it('does not coast on a slow release (a drag, not a flick)', () => {
    expect(shouldFling(FLING_START_V * 0.5, 0)).toBe(false);
  });
  it('does not coast when the finger paused before lifting', () => {
    expect(shouldFling(FLING_START_V * 5, 200)).toBe(false);
  });
});
