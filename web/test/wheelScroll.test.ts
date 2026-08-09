import { describe, expect, it } from 'vitest';
import { drainWheel, notchDir } from '../src/wheelScroll.js';

describe('drainWheel', () => {
  it('emits no notch until travel reaches one unit, carrying the remainder', () => {
    expect(drainWheel(10, 22)).toEqual({ notches: 0, rem: 10 });
    expect(drainWheel(21, 22)).toEqual({ notches: 0, rem: 21 });
  });

  it('finger DOWN (positive travel) → wheel up (+notches)', () => {
    expect(drainWheel(22, 22)).toEqual({ notches: 1, rem: 0 });
    expect(drainWheel(50, 22)).toEqual({ notches: 2, rem: 6 }); // 50 = 2×22 + 6
  });

  it('finger UP (negative travel) → wheel down (−notches)', () => {
    expect(drainWheel(-22, 22)).toEqual({ notches: -1, rem: 0 });
    expect(drainWheel(-50, 22)).toEqual({ notches: -2, rem: -6 });
  });

  it('the carried remainder lets successive small drags accumulate into a notch', () => {
    let acc = 0;
    let total = 0;
    for (const step of [8, 8, 8]) { // 24 total > 22 → exactly one notch, 2px carried
      const { notches, rem } = drainWheel(acc + step, 22);
      acc = rem;
      total += notches;
    }
    expect(total).toBe(1);
    expect(acc).toBe(2);
  });
});

describe('notchDir', () => {
  it('positive → up, negative → down', () => {
    expect(notchDir(3)).toBe('up');
    expect(notchDir(-1)).toBe('down');
  });
});
