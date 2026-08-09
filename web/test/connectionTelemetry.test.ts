import { describe, expect, it, vi } from 'vitest';
import {
  classifyConnectionSample,
  createConnectionTelemetry,
  type ConnectionTelemetryState,
} from '../src/connectionTelemetry.js';

describe('connection telemetry', () => {
  it('classifies application RTT without treating zero traffic as a bad connection', () => {
    expect(classifyConnectionSample({ ok: true, rttMs: 299 })).toBe('good');
    expect(classifyConnectionSample({ ok: true, rttMs: 300 })).toBe('degraded');
    expect(classifyConnectionSample({ ok: true, rttMs: 1000 })).toBe('degraded');
    expect(classifyConnectionSample({ ok: true, rttMs: 1001 })).toBe('poor');
    expect(classifyConnectionSample({ ok: false })).toBe('poor');
  });

  it('reports the actual fallback mode and dampens quality flapping', () => {
    let now = 0;
    const updates: ConnectionTelemetryState[] = [];
    const telemetry = createConnectionTelemetry({
      mode: 'live',
      now: () => now,
      onChange: (value) => { updates.push(value); },
    });
    telemetry.sample({ ok: true, rttMs: 100 });
    expect(telemetry.getSnapshot()).toMatchObject({ quality: 'good', stableQuality: 'good' });

    telemetry.sample({ ok: false, rttMs: 2000 });
    expect(telemetry.getSnapshot()).toMatchObject({ quality: 'poor', stableQuality: 'good' });
    now = 15000;
    telemetry.sample({ ok: false, rttMs: 2000 });
    expect(telemetry.getSnapshot()).toMatchObject({ quality: 'poor', stableQuality: 'poor' });

    telemetry.setMode('snapshot', { fallback: true });
    expect(telemetry.getSnapshot()).toMatchObject({
      mode: 'snapshot',
      quality: 'poor',
      stableQuality: 'degraded',
    });
    expect(updates.at(-1)!.mode).toBe('snapshot');
    telemetry.destroy();
  });

  it('starts a first failed sample as unstable instead of declaring a poor connection immediately', () => {
    const telemetry = createConnectionTelemetry({
      mode: 'live',
    });
    telemetry.sample({ ok: false });
    expect(telemetry.getSnapshot()).toMatchObject({
      quality: 'poor',
      stableQuality: 'degraded',
      rttMs: null,
    });
    telemetry.destroy();
  });

  it('recovers from an unstable connection after thirty seconds of good samples', () => {
    let now = 0;
    const telemetry = createConnectionTelemetry({
      mode: 'snapshot',
      now: () => now,
    });
    telemetry.status('error');
    telemetry.sample({ ok: true, rttMs: 100 });
    expect(telemetry.getSnapshot().recoveryAt).toBe(30000);
    now = 29999;
    telemetry.sample({ ok: true, rttMs: 100 });
    expect(telemetry.getSnapshot()).toMatchObject({ quality: 'good', stableQuality: 'degraded' });
    now = 30000;
    telemetry.sample({ ok: true, rttMs: 100 });
    expect(telemetry.getSnapshot()).toMatchObject({
      quality: 'good',
      stableQuality: 'good',
      recoveryAt: null,
    });
    telemetry.destroy();
  });
});
