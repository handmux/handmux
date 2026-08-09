import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../src/backoff.js';
import type { BackoffOptions } from '../src/backoff.js';

const mid: BackoffOptions = { rng: () => 0.5 }; // 0.5 → 抖动项为 0,拿到原始延迟

describe('backoffDelay', () => {
  it('returns 0 for non-positive fail counts (healthy → caller uses REFRESH_MS)', () => {
    expect(backoffDelay(0, mid)).toBe(0);
    expect(backoffDelay(-1, mid)).toBe(0);
  });

  it('grows exponentially from base by factor', () => {
    expect(backoffDelay(1, mid)).toBe(1000); // base
    expect(backoffDelay(2, mid)).toBe(2000); // base*2
    expect(backoffDelay(3, mid)).toBe(4000); // base*4
    expect(backoffDelay(4, mid)).toBe(8000); // base*8
  });

  it('caps at max', () => {
    expect(backoffDelay(5, mid)).toBe(10000);  // 16000 → 封顶 10000
    expect(backoffDelay(50, mid)).toBe(10000); // 极大次数仍封顶,不溢出
  });

  it('applies jitter within ±jitter of the raw delay', () => {
    expect(backoffDelay(1, { rng: () => 0 })).toBe(800);  // 1000*(1-0.2)
    expect(backoffDelay(1, { rng: () => 1 })).toBe(1200); // 1000*(1+0.2)
  });

  it('honours custom options', () => {
    expect(backoffDelay(1, { base: 500, factor: 3, max: 9999, jitter: 0, rng: () => 0.5 })).toBe(500);
    expect(backoffDelay(2, { base: 500, factor: 3, max: 9999, jitter: 0, rng: () => 0.5 })).toBe(1500);
  });
});
