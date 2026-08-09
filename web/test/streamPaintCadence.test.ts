import { describe, expect, it } from 'vitest';
import { streamPaintDelay } from '../src/streamPaintCadence.js';

describe('streamPaintDelay', () => {
  it('paints the first revision and explicit refreshes immediately', () => {
    expect(streamPaintDelay({ now: 100, lastPaintAt: null })).toBe(0);
    expect(streamPaintDelay({ now: 105, lastPaintAt: 100, immediate: true })).toBe(0);
  });

  it('caps dense output while allowing the next trailing frame on time', () => {
    expect(streamPaintDelay({ now: 110, lastPaintAt: 100 })).toBe(23);
    expect(streamPaintDelay({ now: 133, lastPaintAt: 100 })).toBe(0);
    expect(streamPaintDelay({ now: 150, lastPaintAt: 100 })).toBe(0);
  });

  it('does not extend the wait when the wall clock moves backwards', () => {
    expect(streamPaintDelay({ now: 90, lastPaintAt: 100 })).toBe(33);
  });
});
