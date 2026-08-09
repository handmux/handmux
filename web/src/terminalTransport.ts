const TERMINAL_TRANSPORT_KEY = 'tw_terminal_transport';
const SNAPSHOT_INTERVAL_KEY = 'tw_terminal_snapshot_interval';

export type TerminalTransport = 'live' | 'snapshot';

export const SNAPSHOT_INTERVALS = [800, 1000, 1200, 1500, 2000] as const;
export type SnapshotInterval = (typeof SNAPSHOT_INTERVALS)[number];
export const DEFAULT_SNAPSHOT_INTERVAL: SnapshotInterval = 1000;

interface TerminalTransportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface LocationSearch {
  search: string;
}

function isSnapshotInterval(value: number): value is SnapshotInterval {
  return (SNAPSHOT_INTERVALS as readonly number[]).includes(value);
}

export function getTerminalTransport(
  store: TerminalTransportStorage = localStorage,
): TerminalTransport {
  return store.getItem(TERMINAL_TRANSPORT_KEY) === 'snapshot' ? 'snapshot' : 'live';
}

export function setTerminalTransport(
  mode: unknown,
  store: TerminalTransportStorage = localStorage,
): TerminalTransport {
  const next: TerminalTransport = mode === 'snapshot' ? 'snapshot' : 'live';
  store.setItem(TERMINAL_TRANSPORT_KEY, next);
  return next;
}

export function getSnapshotInterval(
  store: TerminalTransportStorage = localStorage,
): SnapshotInterval {
  const value = Number(store.getItem(SNAPSHOT_INTERVAL_KEY));
  return isSnapshotInterval(value) ? value : DEFAULT_SNAPSHOT_INTERVAL;
}

export function setSnapshotInterval(
  intervalMs: unknown,
  store: TerminalTransportStorage = localStorage,
): SnapshotInterval {
  const value = Number(intervalMs);
  const next = isSnapshotInterval(value) ? value : DEFAULT_SNAPSHOT_INTERVAL;
  store.setItem(SNAPSHOT_INTERVAL_KEY, String(next));
  return next;
}

export function terminalStreamEnabled(
  locationLike: LocationSearch = window.location,
  mode: TerminalTransport = 'live',
): boolean {
  const override = new URLSearchParams(locationLike.search).get('terminalStream');
  if (override === '0') return false;
  return mode !== 'snapshot';
}
