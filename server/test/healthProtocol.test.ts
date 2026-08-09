import { describe, expect, it } from 'vitest';
import {
  parseHealthLiveSnapshot, parseHealthReadySnapshot, RuntimeHealth,
} from '../src/healthProtocol.js';

describe('runtime health contract', () => {
  it('derives readiness from required subsystem states', () => {
    const health = new RuntimeHealth({ now: () => 123 });
    expect(health.snapshot()).toEqual({
      status: 'starting', ready: false, checkedAt: 123,
      subsystems: {
        workspace: { status: 'starting', required: true, detail: null },
        codex: { status: 'starting', required: true, detail: null },
        browser: { status: 'disabled', required: false, detail: null },
      },
    });
    health.set('workspace', 'ready');
    health.set('codex', 'ready');
    const ready = health.snapshot();
    expect(ready).toMatchObject({ status: 'ready', ready: true });
    expect(parseHealthReadySnapshot(ready)).toEqual(ready);
    expect(parseHealthLiveSnapshot(health.live())).toEqual(health.live());
  });

  it('reports a required configured Browser worker as degraded instead of ready', () => {
    const health = new RuntimeHealth({ browserRequired: true, now: () => 456 });
    health.set('workspace', 'ready');
    health.set('codex', 'ready');
    health.set('browser', 'degraded', 'browser-worker-unavailable');
    expect(health.snapshot()).toMatchObject({
      status: 'degraded', ready: false,
      subsystems: { browser: { required: true, detail: 'browser-worker-unavailable' } },
    });
  });

  it('rejects a health body whose ready flag contradicts its subsystem states', () => {
    const health = new RuntimeHealth({ now: () => 789 });
    const snapshot = health.snapshot();
    expect(parseHealthReadySnapshot({ ...snapshot, ready: true })).toBeNull();
    expect(parseHealthLiveSnapshot({ status: 'live', live: false, checkedAt: 789 })).toBeNull();
  });
});
