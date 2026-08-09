import { describe, expect, it } from 'vitest';
import {
  getSnapshotInterval,
  getTerminalTransport,
  setSnapshotInterval,
  setTerminalTransport,
  terminalStreamEnabled,
} from '../src/terminalTransport.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('terminal transport preference', () => {
  it('defaults to live and persists the snapshot fallback', () => {
    const store = storage();
    expect(getTerminalTransport(store)).toBe('live');
    setTerminalTransport('snapshot', store);
    expect(getTerminalTransport(store)).toBe('snapshot');
    setTerminalTransport('unknown', store);
    expect(getTerminalTransport(store)).toBe('live');
  });

  it('lets an explicit query override the saved browser preference', () => {
    expect(terminalStreamEnabled({ search: '' }, 'live')).toBe(true);
    expect(terminalStreamEnabled({ search: '' }, 'snapshot')).toBe(false);
    expect(terminalStreamEnabled({ search: '?terminalStream=0' }, 'live')).toBe(false);
    expect(terminalStreamEnabled({ search: '?terminalStream=1' }, 'snapshot')).toBe(false);
  });

  it('persists only supported timed-refresh intervals', () => {
    const store = storage();
    expect(getSnapshotInterval(store)).toBe(1000);
    expect(setSnapshotInterval(1500, store)).toBe(1500);
    expect(getSnapshotInterval(store)).toBe(1500);
    expect(setSnapshotInterval(999, store)).toBe(1000);
    expect(getSnapshotInterval(store)).toBe(1000);
  });
});
