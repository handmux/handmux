const DEGRADE_AFTER_MS = 15000;
const RECOVER_AFTER_MS = 30000;

export type ConnectionQuality = 'connecting' | 'good' | 'degraded' | 'poor';

export interface ConnectionSample {
  ok: boolean;
  rttMs?: number | null;
}

export interface ConnectionTelemetryState {
  mode: TerminalTransport;
  quality: ConnectionQuality;
  stableQuality: ConnectionQuality;
  rttMs: number | null;
  recoveryAt: number | null;
}

export interface ConnectionTelemetry {
  sample(sample: ConnectionSample): void;
  status(status: TerminalStreamStatus): void;
  setMode(mode: TerminalTransport, options?: { fallback?: boolean }): void;
  getSnapshot(): ConnectionTelemetryState;
  peek(): ConnectionTelemetryState;
  destroy(): void;
}

export interface ConnectionTelemetryOptions {
  mode: TerminalTransport;
  onChange?: (state: ConnectionTelemetryState) => void;
  now?: () => number;
}

const QUALITY_RANK: Record<ConnectionQuality, number> = {
  connecting: -1,
  good: 0,
  degraded: 1,
  poor: 2,
};

export function classifyConnectionSample({ ok, rttMs }: ConnectionSample): ConnectionQuality {
  if (!ok) return 'poor';
  if (typeof rttMs !== 'number' || !Number.isFinite(rttMs)) return 'connecting';
  if (rttMs > 1000) return 'poor';
  if (rttMs >= 300) return 'degraded';
  return 'good';
}

export function createConnectionTelemetry({
  mode,
  onChange,
  now = () => Date.now(),
}: ConnectionTelemetryOptions): ConnectionTelemetry {
  let disposed = false;
  let pendingQuality: ConnectionQuality | null = null;
  let pendingSince = 0;
  // `quality` always matches the displayed RTT. `stableQuality` is deliberately dampened and is
  // consumed only by automatic live↔snapshot switching, so policy delays never make the label lie.
  let state: ConnectionTelemetryState = {
    mode,
    quality: 'connecting',
    stableQuality: 'connecting',
    rttMs: null,
    recoveryAt: null,
  };

  const emit = (): void => {
    if (!disposed) onChange?.({ ...state });
  };
  const applyStableQuality = (quality: ConnectionQuality, immediate = false): void => {
    if (quality === 'connecting') {
      if (state.stableQuality === 'connecting') emit();
      return;
    }
    if (quality === state.stableQuality) {
      pendingQuality = null;
      pendingSince = 0;
      state = { ...state, recoveryAt: null };
      emit();
      return;
    }
    if (state.stableQuality === 'connecting' && quality === 'poor' && !immediate) {
      pendingQuality = 'poor';
      pendingSince = now();
      state = { ...state, stableQuality: 'degraded', recoveryAt: null };
      emit();
      return;
    }
    if (state.stableQuality === 'connecting' || immediate) {
      pendingQuality = null;
      pendingSince = 0;
      state = { ...state, stableQuality: quality, recoveryAt: null };
      emit();
      return;
    }
    const waitMs = QUALITY_RANK[quality] > QUALITY_RANK[state.stableQuality]
      ? DEGRADE_AFTER_MS
      : RECOVER_AFTER_MS;
    if (pendingQuality !== quality) {
      pendingQuality = quality;
      pendingSince = now();
      state = {
        ...state,
        recoveryAt: quality === 'good' ? pendingSince + waitMs : null,
      };
      emit();
      return;
    }
    if (now() - pendingSince >= waitMs) {
      pendingQuality = null;
      pendingSince = 0;
      state = { ...state, stableQuality: quality, recoveryAt: null };
    }
    emit();
  };

  emit();

  return {
    sample({ ok, rttMs }) {
      if (disposed) return;
      const quality = classifyConnectionSample({
        ok,
        ...(rttMs !== undefined ? { rttMs } : {}),
      });
      const measuredRtt = typeof rttMs === 'number' && Number.isFinite(rttMs)
        ? Math.max(0, Math.round(rttMs))
        : null;
      state = {
        ...state,
        quality,
        rttMs: measuredRtt,
      };
      applyStableQuality(quality);
    },
    status(status) {
      if (disposed) return;
      if (status === 'reconnecting' || status === 'error') applyStableQuality('degraded', true);
      else if (status === 'connecting' && state.rttMs == null) {
        state = { ...state, quality: 'connecting' };
        emit();
      }
    },
    setMode(nextMode, { fallback = false } = {}) {
      if (disposed || state.mode === nextMode) return;
      state = { ...state, mode: nextMode };
      if (fallback) state = { ...state, stableQuality: 'degraded', recoveryAt: null };
      emit();
    },
    getSnapshot() {
      return { ...state };
    },
    peek() {
      return { ...state };
    },
    destroy() {
      disposed = true;
    },
  };
}
import type { TerminalStreamStatus } from './terminalStreamClient.js';
import type { TerminalTransport } from './terminalTransport.js';
