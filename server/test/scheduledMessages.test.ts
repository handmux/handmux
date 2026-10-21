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
const scope = { tmuxSession: 'work', paneId: '%1' };
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
    expect(h.sent).toHaveLength(1); expect(h.service.snapshot(scope).tasks[0]!.state).toBe('ended');
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', deliver: async () => { throw Error('must not resend'); } });
    await restored.tick(); expect(restored.snapshot(scope).tasks[0]!.lastResult).toBe('submitted');
  });
  it('records missed recurring occurrences separately and only catches up the latest within ten minutes', async () => {
    const h = harness();
    h.service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    h.advance(125); await h.service.tick();
    const snapshot = h.service.snapshot(scope);
    expect(h.sent).toHaveLength(1); expect(snapshot.exceptions).toHaveLength(2); expect(snapshot.tasks[0]!.state).toBe('active');
  });
  it('expires paused recurrences and does not catch up paused slots on resume', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-20T03:00:00Z' });
    h.service.update(scope, task.id, task.revision, { enabled: false });
    h.advance(65);
    let current = h.service.snapshot(scope).tasks[0]!;
    h.service.update(scope, current.id, current.revision, { enabled: true });
    await h.service.tick(); expect(h.sent).toHaveLength(0);
    current = h.service.snapshot(scope).tasks[0]!;
    expect(current.nextAt).toBe(Date.parse('2026-10-20T02:01:00Z'));
    h.service.update(scope, current.id, current.revision, { enabled: false });
    h.advance(120); await h.service.tick();
    expect(h.service.snapshot(scope).tasks[0]!.state).toBe('ended');
  });
  it('blocks uncertain delivery and never offers an unsafe automatic reschedule', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const store = new MemoryScheduledStore();
    let calls = 0;
    const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver: async () => { calls++; return { status: 'unknown' }; } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    now += 60000; await service.tick(); now += 3600000; await service.tick();
    expect(calls).toBe(1); const exception = service.snapshot(scope).exceptions[0]!;
    expect(exception.unknown).toBe(true);
    expect(() => service.resolveException(scope, exception.id, exception.revision, { action: 'reschedule', rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } })).toThrow();
  });
  it('recovers a persisted claim as uncertain without calling delivery', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    const state = h.store.value as { tasks: Array<Record<string, unknown>> };
    state.tasks[0]!.claim = { at: Date.parse('2026-10-20T00:01:00Z'), text: 'hello', target };
    let calls = 0;
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', deliver: async () => { calls++; return { status: 'queued' }; } });
    await restored.tick(); expect(calls).toBe(0);
    expect(restored.snapshot(scope).exceptions[0]).toMatchObject({ taskId: task.id, unknown: true });
  });
  it('reconciles uncertain delivery from authoritative admission evidence without resending', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let settled = false; let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now,
      deliver: async () => { calls++; return { status: 'unknown' }; }, reconcile: async () => settled ? { status: 'accepted' } : { status: 'unknown' } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    now += 60000; await service.tick(); expect(service.snapshot(scope).exceptions).toHaveLength(1);
    settled = true; await service.tick();
    const task = service.snapshot(scope).tasks[0]!;
    expect(task.blocked).toBeUndefined(); expect(task.enabled).toBe(false); expect(task.lastResult).toBe('submitted');
    expect(service.snapshot(scope).exceptions).toHaveLength(0);
    service.update(scope, task.id, task.revision, { enabled: true }); expect(calls).toBe(1);
  });
  it.each(['queue_full', 'target_changed'])('keeps failed one-off %s only in exceptions, not ended', async (reason) => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'rejected', reason }) });
    service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    now += 60000; await service.tick();
    expect(service.snapshot(scope).tasks[0]!.state).toBe('exception'); expect(service.snapshot(scope).exceptions[0]!.reason).toBe(reason);
  });
  it('keeps remaining one-off slots after a failed slot and exception processing', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now,
      deliver: async () => ++calls === 1 ? { status: 'rejected', reason: 'queue_full' } : { status: 'queued' } });
    const created = service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:02' }] });
    now += 60000; await service.tick();
    expect(service.snapshot(scope).tasks[0]!.state).toBe('active');
    const exception = service.snapshot(scope).exceptions[0]!;
    service.resolveException(scope, exception.id, exception.revision, { action: 'discard' });
    expect(service.snapshot(scope).tasks[0]!.id).toBe(created.id);
    now += 60000; await service.tick();
    expect(calls).toBe(2); expect(service.snapshot(scope).tasks[0]!.state).toBe('ended');
  });
  it('submits every one-off slot inside the recovery window', async () => {
    const h = harness();
    h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:02' }] });
    h.advance(3); await h.service.tick();
    expect(h.sent).toHaveLength(2); expect(h.service.snapshot(scope).exceptions).toHaveLength(0);
    expect(h.service.snapshot(scope).tasks[0]!.state).toBe('ended');
  });
  it('keeps a recurring task active between its last slot and cutoff, even when paused', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'queued' }) });
    service.create(target, { text: 'hello', frequency: 'daily', slots: [{ time: '09:00' }], endsAt: '2026-10-21T08:00:00Z' });
    now = Date.parse('2026-10-20T09:00:00Z'); await service.tick();
    let task = service.snapshot(scope).tasks[0]!;
    expect(task.nextAt).toBeNull(); expect(task.state).toBe('active');
    service.update(scope, task.id, task.revision, { enabled: false });
    now = Date.parse('2026-10-21T07:59:00Z'); await service.tick(); expect(service.snapshot(scope).tasks[0]!.state).toBe('active');
    now += 60000; await service.tick(); expect(service.snapshot(scope).tasks[0]!.state).toBe('ended');
  });
  it('keeps future one-off slots after an unknown occurrence is reconciled', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let settled = false;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'unknown' }), reconcile: async () => settled ? { status: 'accepted' } : null });
    service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }, { date: '2026-10-20', time: '00:05' }] });
    now += 60000; await service.tick(); settled = true; await service.tick();
    const task = service.snapshot(scope).tasks[0]!;
    expect(task.state).toBe('active'); expect(task.nextAt).toBe(Date.parse('2026-10-20T00:05:00Z'));
    expect(() => service.update(scope, task.id, task.revision, { enabled: true })).not.toThrow();
  });
  it('does not catch up a previous recurrence exactly at its cutoff', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); let calls = 0;
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => { calls++; return { status: 'queued' }; } });
    service.create(target, { text: 'hello', frequency: 'hourly', slots: [{ minute: 55 }], endsAt: '2026-10-20T01:00:00Z' });
    now = Date.parse('2026-10-20T01:00:00Z'); await service.tick();
    expect(calls).toBe(0); expect(service.snapshot(scope).tasks[0]!.state).toBe('ended');
    expect(service.snapshot(scope).exceptions[0]!.reason).toBe('missed');
  });
  it('rejects stale edits and atomically handles an exception only once', async () => {
    const h = harness();
    const task = h.service.create(target, { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
    expect(() => h.service.update(scope, task.id, task.revision + 1, { enabled: false })).toThrow();
    h.advance(12); await h.service.tick();
    const exception = h.service.snapshot(scope).exceptions[0]!;
    h.service.resolveException(scope, exception.id, exception.revision, { action: 'reschedule', rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } });
    expect(() => h.service.resolveException(scope, exception.id, exception.revision, { action: 'discard' })).toThrow();
    expect(h.service.snapshot(scope).tasks).toHaveLength(1);
    expect(h.service.snapshot(scope).tasks[0]!.id).not.toBe(task.id);
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
    clockReads = 0; service.update(scope, task.id, task.revision, { ...request, endsAtLocal: '2027-10-20T23:30' }); expect(clockReads).toBe(1);
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
    expect(() => h.service.update(scope, task.id, task.revision, tooLate)).toThrow(/365/);
    const stored = h.store.value as { tasks: Array<{ rule: unknown }> }; stored.tasks[0]!.rule = tooLate;
    const restored = new ScheduledMessagesService({ store: h.store, now: () => now, timeZone: 'UTC', deliver: async () => ({ status: 'queued' }) });
    const paused = restored.update(scope, task.id, task.revision, { enabled: false });
    expect(restored.update(scope, task.id, paused.revision, { enabled: true }).rule).toEqual(tooLate);
    expect(() => restored.create(target, { text: 'distant once', frequency: 'once', slots: [{ date: '2030-01-01', time: '09:00' }] })).not.toThrow();
  });
});

describe('exclusive recurring cutoff', () => {
  it.each([
    { frequency: 'hourly', slots: [{ minute: 1 }] },
    { frequency: 'daily', slots: [{ time: '00:01' }] },
    { frequency: 'weekly', slots: [{ weekday: 2, time: '00:01' }] },
  ])('rejects an equal-first $frequency rule atomically and retains earlier slots', (fields) => {
    const h = harness(); const endsAt = '2026-10-20T00:01:00Z';
    const rule = { ...fields, endsAt };
    expect(h.service.preview(rule).nextAt).toBeNull();
    expect(() => h.service.create(target, { ...rule, text: 'never executable' })).toThrow(/future/);
    expect(h.service.snapshot(scope).tasks).toHaveLength(0);
    const valid = { ...fields, endsAt: '2026-10-20T00:02:00Z' };
    const task = h.service.create(target, { ...valid, text: 'valid' });
    const before = structuredClone(h.store.value);
    expect(() => h.service.update(scope, task.id, task.revision, rule)).toThrow(/future/);
    expect(h.store.value).toEqual(before);
    const multiple = validateRule({ frequency: 'daily', slots: [{ time: '00:01' }, { time: '00:02' }], endsAt: valid.endsAt }, 'UTC');
    expect(nextOccurrence(multiple, 'UTC', Date.parse('2026-10-20T00:00:00Z'))).toBe(Date.parse('2026-10-20T00:01:00Z'));
    expect(nextOccurrence(multiple, 'UTC', Date.parse('2026-10-20T00:01:00Z'))).toBeNull();
  });
  it.each([0, 60000])('ends legacy cutoff-outside nextAt (+%i) without a false missed occurrence', async (offset) => {
    const h = harness();
    h.service.create(target, { text: 'legacy', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-20T00:02:00Z' });
    const state = h.store.value as { tasks: Array<{ nextAt: number }> };
    state.tasks[0]!.nextAt = Date.parse('2026-10-20T00:02:00Z') + offset;
    let now = Date.parse('2026-10-20T00:00:00Z'); let sends = 0;
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', now: () => now, deliver: async () => { sends++; return { status: 'queued' }; } });
    await restored.tick(); expect(restored.snapshot(scope).tasks[0]).toMatchObject({ state: 'active', nextAt: null });
    now += 120000; await restored.tick();
    expect(restored.snapshot(scope).tasks[0]).toMatchObject({ state: 'ended', nextAt: null });
    expect(restored.snapshot(scope).exceptions).toHaveLength(0); expect(sends).toBe(0);
  });
  it('preserves persisted claim uncertainty when normalizing a legacy cutoff nextAt', async () => {
    const h = harness(); const cutoff = Date.parse('2026-10-20T00:02:00Z');
    h.service.create(target, { text: 'claimed', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: new Date(cutoff).toISOString() });
    const state = h.store.value as { tasks: Array<{ nextAt: number; claim: unknown }> };
    state.tasks[0]!.nextAt = cutoff; state.tasks[0]!.claim = { at: cutoff - 60000, text: 'claimed', target };
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', now: () => cutoff, deliver: async () => { throw Error('must not resend'); } });
    await restored.tick();
    expect(restored.snapshot(scope).exceptions).toHaveLength(1);
    expect(restored.snapshot(scope).exceptions[0]).toMatchObject({ reason: 'delivery_unconfirmed', unknown: true, scheduledAt: cutoff - 60000 });
    expect(restored.snapshot(scope).tasks[0]!.blocked).toBe(true);
  });
});

describe('pane-owned scheduled records', () => {
  it('isolates existing tasks, exceptions and every mutation by tmux plus pane', async () => {
    const h = harness(); const other = { ...scope, paneId: '%2' };
    const task = h.service.create(target, { text: 'original pane', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
    const neighbor = h.service.create({ ...target, paneId: '%2' }, { text: 'neighbor', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:02' }] });
    expect(h.service.snapshot(scope).tasks.map(t => t.id)).toEqual([task.id]);
    expect(h.service.snapshot(other).tasks.map(t => t.id)).toEqual([neighbor.id]);
    expect(h.service.snapshot({ ...scope, tmuxSession: 'elsewhere' }).tasks).toEqual([]);
    expect(() => h.service.update({ ...scope, tmuxSession: 'elsewhere' }, task.id, task.revision, { enabled: false })).toThrow();
    expect(() => h.service.update(other, task.id, task.revision, { enabled: false })).toThrow();
    expect(() => h.service.remove(other, task.id, task.revision)).toThrow();
    h.advance(12); await h.service.tick();
    const exception = h.service.snapshot(scope).exceptions[0]!;
    expect(exception.target.paneId).toBe('%1');
    expect(h.service.snapshot(other).exceptions.every(e => e.target.paneId === '%2')).toBe(true);
    const before = structuredClone(h.store.value);
    for (const action of ['discard', 'reschedule']) expect(() => h.service.resolveException(other, exception.id, exception.revision, { action, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } })).toThrow();
    expect(h.store.value).toEqual(before);
    h.service.resolveException(scope, exception.id, exception.revision, { action: 'discard' });
    expect(h.service.snapshot(scope).exceptions).toHaveLength(0);
    const restored = new ScheduledMessagesService({ store: h.store, timeZone: 'UTC', deliver: async () => ({ status: 'queued' }) });
    expect(restored.snapshot(scope).tasks.every(t => t.target.paneId === '%1')).toBe(true);
    expect(restored.snapshot(other).tasks.map(t => t.id)).toEqual([neighbor.id]);
    // No tmux-wide fallback, including direct Core callers.
    expect(() => h.service.snapshot({ tmuxSession: 'work' } as typeof scope)).toThrow();
  });
});

describe('explicit scheduled task trigger', () => {
  it.each(['once', 'daily'] as const)('submits %s manually with explicit-user semantics and preserves the right schedule', async frequency => {
    const calls: boolean[] = []; const now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async (_target, _text, _id, recurring) => { calls.push(recurring); return { status: 'queued' }; } });
    const task = service.create(target, { text: 'manual', frequency, slots: frequency === 'once' ? [{ date: '2026-10-21', time: '09:00' }] : [{ time: '09:00' }], endsAt: '2026-10-22T00:00:00Z' });
    const paused = service.update(scope, task.id, task.revision, { enabled: false });
    await service.trigger(scope, task.id, paused.revision);
    const result = service.snapshot(scope).tasks[0]!;
    expect(calls).toEqual([false]); expect(result.lastResult).toBe('submitted');
    expect(result.enabled).toBe(false);
    if (frequency === 'once') expect(result).toMatchObject({ state: 'ended', nextAt: null });
    else expect(result).toMatchObject({ state: 'active', nextAt: task.nextAt, cursor: task.cursor });
  });
  it('holds a durable claim across clients and ticks, rejects blocked triggers, and waits during shutdown', async () => {
    let release!: (value: { status: string }) => void; let calls = 0;
    const store = new MemoryScheduledStore(); const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => Date.parse('2026-10-20T00:00:00Z'), deliver: async () => { calls++; return await new Promise(resolve => { release = resolve; }); } });
    const task = service.create(target, { text: 'once', frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] });
    const pending = service.trigger(scope, task.id, task.revision);
    const claimed = service.snapshot(scope).tasks[0]!; expect(claimed.claim).toBeTruthy(); expect(claimed.immediateAt).toBeDefined();
    await expect(service.trigger(scope, task.id, claimed.revision)).rejects.toThrow();
    await expect(service.trigger({ ...scope, paneId: '%2' }, task.id, claimed.revision)).rejects.toThrow();
    await service.tick(); expect(calls).toBe(1);
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    await expect(service.trigger(scope, task.id, claimed.revision)).rejects.toThrow();
    release({ status: 'queued' }); await pending; await closing; expect(closed).toBe(true);
  });
  it.each(['queue_full', 'target_changed'])('does not complete a rejected manual occurrence (%s)', async reason => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'rejected', reason }) });
    const task = service.create(target, { text: 'manual', frequency: 'daily', slots: [{ time: '09:00' }], endsAt: '2026-10-22T00:00:00Z' });
    await expect(service.trigger(scope, task.id, task.revision)).rejects.toThrow();
    expect(service.snapshot(scope).tasks[0]).toMatchObject({ state: 'active', nextAt: task.nextAt, cursor: task.cursor, lastResult: reason });
    expect(service.snapshot(scope).exceptions[0]).toMatchObject({ reason, unknown: false });
  });
  it.each(['once', 'daily'] as const)('retains manual %s intent across a claimed crash and accepted reconciliation', async frequency => {
    const now = Date.parse('2026-10-20T00:00:00Z'); const store = new MemoryScheduledStore(); let release!: (value: { status: string }) => void; let id = '';
    const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver: async (_target, _text, value) => { id = value; return await new Promise(resolve => { release = resolve; }); } });
    const task = service.create(target, { text: 'manual', frequency, slots: frequency === 'once' ? [{ date: '2026-10-21', time: '09:00' }] : [{ time: '09:00' }], endsAt: '2026-10-22T00:00:00Z' });
    const pending = service.trigger(scope, task.id, task.revision);
    let settled = false;
    const restored = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver: async () => { throw Error('must not resend'); }, reconcile: async (_target, value) => { expect(value).toBe(id); return settled ? { status: 'accepted' } : null; } });
    expect(restored.snapshot(scope).tasks[0]!.blocked).toBe(true);
    await expect(restored.trigger(scope, task.id, restored.snapshot(scope).tasks[0]!.revision)).rejects.toThrow();
    await restored.tick(); expect(restored.snapshot(scope).tasks[0]!.blocked).toBe(true);
    settled = true; await restored.tick();
    const current = restored.snapshot(scope).tasks[0]!;
    expect(current.blocked).toBeUndefined(); expect(restored.snapshot(scope).exceptions).toHaveLength(0);
    expect(current.state).toBe(frequency === 'once' ? 'ended' : 'active'); expect(current.enabled).toBe(false);
    if (frequency === 'daily') expect(current.nextAt).toBe(task.nextAt);
    release({ status: 'unknown' }); await expect(pending).rejects.toThrow(); await service.close(); await restored.close();
  });
});

it('keeps an enabled recurrence running, separates same-clock manual IDs, and reconciles an actual unknown receipt', async () => {
  let now = Date.parse('2026-10-20T00:00:00Z'); let outcome = 'queued'; let settled = false;
  const calls: Array<{ id: string; recurring: boolean }> = [];
  const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now,
    deliver: async (_target, _text, id, recurring) => { calls.push({ id, recurring }); return { status: outcome }; }, reconcile: async () => settled ? { status: 'accepted' } : null });
  const original = service.create(target, { text: 'repeat', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
  await service.trigger(scope, original.id, original.revision);
  let current = service.snapshot(scope).tasks[0]!;
  await service.trigger(scope, current.id, current.revision); current = service.snapshot(scope).tasks[0]!;
  expect(current).toMatchObject({ enabled: true, state: 'active', nextAt: original.nextAt, cursor: original.cursor });
  expect(new Set(calls.map(call => call.id)).size).toBe(2);
  now += 60000; await service.tick(); expect(calls.map(call => call.recurring)).toEqual([false, false, true]);
  current = service.snapshot(scope).tasks[0]!; const next = current.nextAt;
  outcome = 'unknown'; await expect(service.trigger(scope, current.id, current.revision)).rejects.toThrow(/uncertain/);
  expect(service.snapshot(scope).tasks[0]).toMatchObject({ enabled: false, blocked: true, state: 'active', nextAt: next });
  settled = true; await service.tick();
  expect(service.snapshot(scope).tasks[0]).toMatchObject({ enabled: false, state: 'active', nextAt: next, lastResult: 'submitted' });
  expect(service.snapshot(scope).tasks[0]!.blocked).toBeUndefined(); await service.close();
});

it('never reuses manual identities after an automatic occurrence, clock rollback or reload', async () => {
  let now = Date.parse('2026-10-20T00:00:00Z'); const store = new MemoryScheduledStore(); const ids: string[] = [];
  const deliver = async (_target: unknown, _text: string, id: string) => { ids.push(id); return { status: 'queued' }; };
  const service = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver });
  const task = service.create(target, { text: 'identities', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' });
  const manual = async (scheduler = service) => { const current = scheduler.snapshot(scope).tasks[0]!; await scheduler.trigger(scope, current.id, current.revision); };
  now += 60000; await manual(); await manual(); await service.tick(); await manual();
  now -= 60000; await manual();
  const restored = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver }); await manual(restored);
  expect(ids).toHaveLength(6); expect(new Set(ids).size).toBe(6);
  expect(service.snapshot(scope).tasks[0]!.id).toBe(task.id); await service.close(); await restored.close();
});
