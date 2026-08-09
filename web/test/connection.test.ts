import { describe, expect, it } from 'vitest';
import { initialConnection, nextConnection } from '../src/connection.js';

describe('connection reducer', () => {
  it('starts connected with no failures', () => {
    expect(initialConnection).toEqual({ failCount: 0, connected: true });
  });

  it('stays connected on the first failure (below threshold), drops on the second', () => {
    const s1 = nextConnection(initialConnection, 'fail'); // threshold defaults to 2
    expect(s1).toEqual({ failCount: 1, connected: true });
    const s2 = nextConnection(s1, 'fail');
    expect(s2).toEqual({ failCount: 2, connected: false });
  });

  it('respects a custom threshold', () => {
    let s = initialConnection;
    s = nextConnection(s, 'fail', { threshold: 3 });
    s = nextConnection(s, 'fail', { threshold: 3 });
    expect(s.connected).toBe(true);            // 2 < 3
    s = nextConnection(s, 'fail', { threshold: 3 });
    expect(s.connected).toBe(false);           // 3 >= 3
  });

  it('a single ok recovers immediately and clears the count', () => {
    const down = nextConnection(nextConnection(initialConnection, 'fail'), 'fail');
    expect(down.connected).toBe(false);
    expect(nextConnection(down, 'ok')).toEqual({ failCount: 0, connected: true });
  });

  it('reset behaves like ok (used when returning to foreground)', () => {
    const down = nextConnection(nextConnection(initialConnection, 'fail'), 'fail');
    expect(nextConnection(down, 'reset')).toEqual({ failCount: 0, connected: true });
  });

  it('ignores unknown events', () => {
    const s = { failCount: 1, connected: true };
    expect(nextConnection(s, 'wat')).toBe(s);
  });
});
