import { describe, it, expect } from 'vitest';
import { nextOccurrence, validateRule, ScheduledMessagesService, MemoryScheduledStore } from '../src/agent-runtime/scheduledMessages.js';

describe('scheduled message calendar', () => {
  it('uses calendar slots in the server timezone and preserves multiple slots', () => {
    const rule = validateRule({ frequency: 'daily', slots: [{ time: '09:00' }, { time: '18:00' }], endsAt: '2026-10-30T00:00:00Z' }, 'Asia/Shanghai');
    expect(nextOccurrence(rule, 'Asia/Shanghai', Date.parse('2026-10-20T02:00:00Z'))).toBe(Date.parse('2026-10-20T10:00:00Z'));
  });
  it('requires a cutoff and rejects impossible dates', () => {
    expect(() => validateRule({ frequency: 'daily', slots: [{ time: '09:00' }] }, 'UTC')).toThrow();
    expect(() => validateRule({ frequency: 'once', slots: [{ date: '2026-02-30', time: '09:00' }] }, 'UTC')).toThrow();
  });
  it('moves nonexistent DST times forward and chooses a single instant in a repeated hour', () => {
    const rule = validateRule({ frequency: 'daily', slots: [{ time: '02:30' }], endsAt: '2026-03-10T00:00:00Z' }, 'America/New_York');
    expect(nextOccurrence(rule, 'America/New_York', Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-08T07:30:00Z'));
  });
});
const target = { agentId: 'test', sessionId: 'original', paneId: '%1', tmuxSession: 'work' };
function harness() {
  let now = Date.parse('2026-10-20T00:00:00Z');
  const store = new MemoryScheduledStore();
  const sent: string[] = [];
  const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now,
    deliver: async (_target, text, id) => { sent.push(id); return { status: 'queued' }; } });
  return { service, store, sent, advance: (minutes: number) => { now += minutes * 60_000; } };
}
describe('persistent server owned scheduling', () => {
  it('submits without clients, completes at admission and never resubmits after restart', async () => {
    const h = harness();
    h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    h.advance(1); await h.service.tick(); await h.service.tick();
    expect(h.sent).toHaveLength(1); expect(h.service.snapshot('work').tasks[0]!.state).toBe('ended');
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', deliver: async () => { throw Error('must not resend'); } });
    await restored.tick(); expect(restored.snapshot('work').tasks[0]!.lastResult).toBe('submitted');
  });
  it('records missed recurring occurrences separately and only catches up the latest within ten minutes', async () => {
    const h = harness();
    h.service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    h.advance(125); await h.service.tick();
    const snapshot = h.service.snapshot('work');
    expect(h.sent).toHaveLength(1); expect(snapshot.exceptions).toHaveLength(2); expect(snapshot.tasks[0]!.state).toBe('active');
  });
  it('expires paused recurrences and does not catch up paused slots on resume', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-20T03:00:00Z' });
    h.service.update('work', task.id, task.revision, { enabled: false });
    h.advance(65);
    let current = h.service.snapshot('work').tasks[0]!;
    h.service.update('work', current.id, current.revision, { enabled: true });
    await h.service.tick(); expect(h.sent).toHaveLength(0);
    current = h.service.snapshot('work').tasks[0]!;
    expect(current.nextAt).toBe(Date.parse('2026-10-20T02:01:00Z'));
    h.service.update('work', current.id, current.revision, { enabled: false });
    h.advance(120); await h.service.tick();
    expect(h.service.snapshot('work').tasks[0]!.state).toBe('ended');
  });
  it('blocks uncertain delivery and never offers an unsafe automatic reschedule', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const store = new MemoryScheduledStore();
    let calls = 0;
    const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver: async () => { calls++; return { status: 'unknown' }; } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    now += 60000; await service.tick(); now += 3600000; await service.tick();
    expect(calls).toBe(1); const exception = service.snapshot('work').exceptions[0]!;
    expect(exception.unknown).toBe(true);
    expect(() => service.resolveException('work', exception.id, exception.revision, { action: 'reschedule', rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } })).toThrow();
  });
  it('recovers a persisted claim as uncertain without calling delivery', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    const state = h.store.value as { tasks: Array<Record<string, unknown>> };
    state.tasks[0]!.claim = { at: Date.parse('2026-10-20T00:01:00Z'), text: 'hello', target };
    let calls = 0;
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', deliver: async () => { calls++; return { status: 'queued' }; } });
    await restored.tick(); expect(calls).toBe(0);
    expect(restored.snapshot('work').exceptions[0]).toMatchObject({ taskId: task.id, unknown: true });
  });
  it('reconciles uncertain delivery from authoritative admission evidence without resending', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let settled = false; let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now,
      deliver: async () => { calls++; return { status: 'unknown' }; }, reconcile: async () => settled ? { status: 'accepted' } : { status: 'unknown' } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    now += 60000; await service.tick(); expect(service.snapshot('work').exceptions).toHaveLength(1);
    settled = true; await service.tick();
    const task = service.snapshot('work').tasks[0]!;
    expect(task.blocked).toBeUndefined(); expect(task.enabled).toBe(false); expect(task.lastResult).toBe('submitted');
    expect(service.snapshot('work').exceptions).toHaveLength(0);
    service.update('work', task.id, task.revision, { enabled: true }); expect(calls).toBe(1);
  });
  it.each(['queue_full', 'target_changed'])('keeps failed one-off %s only in exceptions, not ended', async (reason) => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'rejected', reason }) });
    service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    now += 60000; await service.tick();
    expect(service.snapshot('work').tasks[0]!.state).toBe('exception'); expect(service.snapshot('work').exceptions[0]!.reason).toBe(reason);
  });
  it('keeps remaining one-off slots after a failed slot and exception processing', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now,
      deliver: async () => ++calls === 1 ? { status: 'rejected', reason: 'queue_full' } : { status: 'queued' } });
    const created = service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:02' }] });
    now += 60000; await service.tick();
    expect(service.snapshot('work').tasks[0]!.state).toBe('active');
    const exception = service.snapshot('work').exceptions[0]!;
    service.resolveException('work', exception.id, exception.revision, { action: 'discard' });
    expect(service.snapshot('work').tasks[0]!.id).toBe(created.id);
    now += 60000; await service.tick();
    expect(calls).toBe(2); expect(service.snapshot('work').tasks[0]!.state).toBe('ended');
  });
  it('submits every one-off slot inside the recovery window', async () => {
    const h = harness();
    h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:02' }] });
    h.advance(3); await h.service.tick();
    expect(h.sent).toHaveLength(2); expect(h.service.snapshot('work').exceptions).toHaveLength(0);
    expect(h.service.snapshot('work').tasks[0]!.state).toBe('ended');
  });
  it('keeps a recurring task active between its last slot and cutoff, even when paused', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'queued' }) });
    service.create(target, { text: 'hello', frequency: 'daily', slots: [{ time: '09:00' }], endsAt: '2026-10-21T08:00:00Z' });
    now = Date.parse('2026-10-20T09:00:00Z'); await service.tick();
    let task = service.snapshot('work').tasks[0]!;
    expect(task.nextAt).toBeNull(); expect(task.state).toBe('active');
    service.update('work', task.id, task.revision, { enabled: false });
    now = Date.parse('2026-10-21T07:59:00Z'); await service.tick(); expect(service.snapshot('work').tasks[0]!.state).toBe('active');
    now += 60000; await service.tick(); expect(service.snapshot('work').tasks[0]!.state).toBe('ended');
  });
  it('keeps future one-off slots after an unknown occurrence is reconciled', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let settled = false;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'unknown' }), reconcile: async () => settled ? { status: 'accepted' } : null });
    service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:05' }] });
    now += 60000; await service.tick(); settled = true; await service.tick();
    const task = service.snapshot('work').tasks[0]!;
    expect(task.state).toBe('active'); expect(task.nextAt).toBe(Date.parse('2026-10-20T00:05:00Z'));
    expect(() => service.update('work', task.id, task.revision, { enabled: true })).not.toThrow();
  });
  it('does not catch up a previous recurrence exactly at its cutoff', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => { calls++; return { status: 'queued' }; } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 55 }], endsAt: '2026-10-20T01:00:00Z' });
    now = Date.parse('2026-10-20T01:00:00Z'); await service.tick();
    expect(calls).toBe(0); expect(service.snapshot('work').tasks[0]!.state).toBe('ended');
    expect(service.snapshot('work').exceptions[0]!.reason).toBe('missed');
  });
  it('rejects stale edits and atomically handles an exception only once', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    expect(() => h.service.update('work', task.id, task.revision + 1, { enabled: false })).toThrow();
    h.advance(12); await h.service.tick();
    const exception = h.service.snapshot('work').exceptions[0]!;
    h.service.resolveException('work', exception.id, exception.revision, { action: 'reschedule', rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } });
    expect(() => h.service.resolveException('work', exception.id, exception.revision, { action: 'discard' })).toThrow();
    expect(h.service.snapshot('work').tasks).toHaveLength(1);
    expect(h.service.snapshot('work').tasks[0]!.id).not.toBe(task.id);
  });
});

describe('recurring cutoff write boundary', () => {
  it('accepts the UI preset request in the task zone and rejects an out-of-range local cutoff', () => {
    const now = Date.parse('2026-10-20T15:30:00Z'); let clockReads = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'Asia/Shanghai', now: () => { clockReads++; return now; }, deliver: async () => ({ status: 'queued' }) });
    const request = { text: 'preset', frequency: 'daily', slots: [{ time: '09:00' }], endsAtLocal: '2027-01-18T23:30' };
    clockReads = 0; expect(service.preview(request).nextAt).toBe(Date.parse('2026-10-21T01:00:00Z')); expect(clockReads).toBe(1);
    clockReads = 0; const task = service.create(target, request); expect(clockReads).toBe(1);
    expect(task.rule).toMatchObject({ endsAt: new Date(now + 90 * 86400000).toISOString() });
    clockReads = 0; service.update('work', task.id, task.revision, { ...request, endsAtLocal: '2027-10-20T23:30' }); expect(clockReads).toBe(1);
    expect(() => service.preview({ ...request, endsAtLocal: '2027-10-20T23:31' })).toThrow(/365/);
  });
  it('accepts 365 days, rejects later preview/create/update, and leaves stored rules and pause/resume usable', () => {
    const h = harness(); const now = Date.parse('2026-10-20T00:00:00Z');
    const rule = { frequency: 'daily', slots: [{ time: '09:00' }], endsAt: new Date(now + 365 * 86400000).toISOString() };
    expect(h.service.preview(rule).nextAt).toBeGreaterThan(now);
    const task = h.service.create(target, { ...rule, text: 'boundary' });
    const tooLate = { ...rule, endsAt: new Date(now + 365 * 86400000 + 1).toISOString() };
    expect(() => h.service.preview(tooLate)).toThrow(/365/);
    expect(() => h.service.create(target, { ...tooLate, text: 'late' })).toThrow(/365/);
    expect(() => h.service.update('work', task.id, task.revision, tooLate)).toThrow(/365/);
    const stored = h.store.value as { tasks: Array<{ rule: unknown }> }; stored.tasks[0]!.rule = tooLate;
    const restored = new ScheduledMessagesService({ store: h.store, now: () => now, timeZone: 'UTC', deliver: async () => ({ status: 'queued' }) });
    const paused = restored.update('work', task.id, task.revision, { enabled: false });
    expect(restored.update('work', task.id, paused.revision, { enabled: true }).rule).toEqual(tooLate);
    expect(() => restored.create(target, { text: 'distant once', frequency: 'once', slots: [{ date: '2030-01-01', time: '09:00' }] })).not.toThrow();
  });
});
