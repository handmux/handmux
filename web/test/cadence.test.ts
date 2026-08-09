import { describe, it, expect } from 'vitest';
import { idleDelay, FAST_MS } from '../src/cadence.js';

describe('idleDelay', () => {
  it('stays at the fast cadence inside the live window (<8s)', () => {
    expect(idleDelay(0)).toBe(FAST_MS);
    expect(idleDelay(7999)).toBe(FAST_MS);
    expect(idleDelay(0, 1500)).toBe(1500);
  });
  it('eases to 5s once unchanged for 8s..60s', () => {
    expect(idleDelay(8000)).toBe(5000);
    expect(idleDelay(59999)).toBe(5000);
  });
  it('caps at 10s past a minute idle', () => {
    expect(idleDelay(60000)).toBe(10000);
    expect(idleDelay(10 * 60000)).toBe(10000);
  });
});
