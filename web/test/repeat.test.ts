import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRepeater } from '../src/repeat.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createRepeater', () => {
  it('fires once immediately on start', () => {
    const fn = vi.fn();
    createRepeater(fn).start();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a quick start/stop (before the delay) fires exactly once', () => {
    const fn = vi.fn();
    const r = createRepeater(fn, { delay: 400, interval: 120 });
    r.start();
    vi.advanceTimersByTime(100);
    r.stop();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('holding repeats after the initial delay', () => {
    const fn = vi.fn();
    const r = createRepeater(fn, { delay: 400, interval: 120 });
    r.start();                       // 1 (immediate)
    vi.advanceTimersByTime(400);     // delay elapses, interval armed
    vi.advanceTimersByTime(120);     // 2
    vi.advanceTimersByTime(120);     // 3
    expect(fn).toHaveBeenCalledTimes(3);
    r.stop();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3); // stopped
  });

  it('restart re-arms cleanly without leaking the old interval', () => {
    const fn = vi.fn();
    const r = createRepeater(fn, { delay: 400, interval: 120 });
    r.start();
    r.start();                       // stop() inside start() must clear the first arming
    expect(fn).toHaveBeenCalledTimes(2); // two immediate fires, no double interval
    vi.advanceTimersByTime(400 + 120);
    expect(fn).toHaveBeenCalledTimes(3); // only one interval running
    r.stop();
  });
});
