import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type ScheduledRule =
  | { frequency: 'once'; slots: { date: string; time: string }[] }
  | { frequency: 'hourly'; slots: { minute: number }[]; endsAt: string }
  | { frequency: 'daily'; slots: { time: string }[]; endsAt: string }
  | { frequency: 'weekly'; slots: { weekday: number; time: string }[]; endsAt: string };
export interface ScheduledScope { tmuxSession: string; paneId: string }
export interface ScheduledTarget { agentId: string; sessionId: string; paneId: string; tmuxSession: string }
export interface ScheduledTask {
  id: string; revision: number; target: ScheduledTarget; text: string; rule: ScheduledRule;
  timeZone: string; enabled: boolean; state: 'active' | 'ended' | 'exception'; createdAt: number;
  cursor: number; nextAt: number | null; endedAt?: number; lastAt?: number; lastResult?: string;
  claim?: { at: number; text: string; target: ScheduledTarget }; blocked?: boolean; blockedAt?: number;
}
export interface ScheduledException {
  id: string; revision: number; taskId: string; target: ScheduledTarget; text: string; timeZone: string;
  scheduledAt: number; reason: string; unknown: boolean; count?: number; missedThroughAt?: number;
}
// Apply the rolling limit only when accepting a rule, never while loading persisted tasks.
function validateCutoffLimit(rule: ScheduledRule, now: number) {
  if (rule.frequency !== 'once' && Date.parse(rule.endsAt) > now + 365 * 86400000)
    throw new ScheduledError('Choose an end time within the next 365 days');
}
function requiredScope(scope: ScheduledScope): ScheduledScope {
  if (!scope || typeof scope.tmuxSession !== 'string' || !scope.tmuxSession.trim() || typeof scope.paneId !== 'string' || !scope.paneId.trim())
    throw new ScheduledError('Choose a tmux session and pane');
  return scope;
}
function inScope(target: ScheduledTarget, scope: ScheduledScope) { return target.tmuxSession === scope.tmuxSession && target.paneId === scope.paneId; }
interface State { version: 1; tasks: ScheduledTask[]; exceptions: ScheduledException[] }
export interface ScheduledStore { load(): unknown; save(state: State): void }
export class MemoryScheduledStore implements ScheduledStore {
  value: unknown;
  load(): unknown { return structuredClone(this.value); }
  save(state: State): void { this.value = structuredClone(state); }
}
export class FileScheduledStore implements ScheduledStore {
  constructor(readonly file: string) {}
  load(): unknown { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
  save(state: State): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
export class ScheduledError extends Error {
  constructor(message: string, readonly code: 'invalid_request' | 'conflict' | 'not_found' = 'invalid_request') { super(message); }
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function invalid(): never { throw new ScheduledError('Invalid scheduled message rule'); }
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, zone: string): { date: string; time: string; minute: number; weekday: number; wall: number } {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  const wall = Date.parse(`${date}T${time}:00Z`);
  return { date, time, minute: Number(p.minute), weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), wall };
}
function instants(date: string, time: string, zone: string): number[] {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set([-86400000, 0, 86400000].map((delta) => {
    const sample = wall + delta;
    return parts(sample, zone).wall - sample;
  }));
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((at) => { const p = parts(at, zone); return p.date === date && p.time === time; }).sort((a, b) => a - b);
  if (exact.length) return exact.slice(0, 1);
  // Spring-forward gap: preserve the intended minute by moving forward by the offset change.
  return candidates.filter((at) => { const p = parts(at, zone); return p.date === date && p.wall > wall; }).sort((a, b) => a - b).slice(0, 1);
}
export function validateRule(raw: unknown, zone: string): ScheduledRule {
  try { parts(Date.now(), zone); } catch { invalid(); }
  const value = object(raw);
  if (!Array.isArray(value.slots) || !value.slots.length || value.slots.length > 64) invalid();
  if (typeof value.endsAtLocal === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.endsAtLocal)) {
    const [date, time] = value.endsAtLocal.split('T');
    const at = instants(date!, time!, zone)[0];
    if (at !== undefined) value.endsAt = new Date(at).toISOString();
  }
  const frequency = value.frequency;
  if (!['once', 'hourly', 'daily', 'weekly'].includes(String(frequency))) invalid();
  const slots = value.slots.map((rawSlot) => {
    const slot = object(rawSlot);
    if (frequency === 'hourly') { if (!Number.isInteger(slot.minute) || Number(slot.minute) < 0 || Number(slot.minute) > 59) invalid(); return { minute: slot.minute as number }; }
    if (typeof slot.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) invalid();
    if (frequency === 'once') {
      if (typeof slot.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || !Number.isFinite(Date.parse(`${slot.date}T00:00:00Z`)) || new Date(`${slot.date}T00:00:00Z`).toISOString().slice(0, 10) !== slot.date || !instants(slot.date, slot.time, zone).length) invalid();
      return { date: slot.date, time: slot.time };
    }
    if (frequency === 'weekly') { if (!Number.isInteger(slot.weekday) || Number(slot.weekday) < 1 || Number(slot.weekday) > 7) invalid(); return { weekday: slot.weekday as number, time: slot.time }; }
    return { time: slot.time };
  });
  if (new Set(slots.map((slot) => JSON.stringify(slot))).size !== slots.length) invalid();
  if (frequency !== 'once' && (typeof value.endsAt !== 'string' || !/Z$|[+-]\d\d:\d\d$/.test(value.endsAt) || !Number.isFinite(Date.parse(value.endsAt)))) invalid();
  return { frequency, slots, ...(frequency === 'once' ? {} : { endsAt: new Date(value.endsAt as string).toISOString() }) } as ScheduledRule;
}
/** Calendar based local slots; DST gaps move forward, repeated wall times fire once (earliest instant). */
export function nextOccurrence(rule: ScheduledRule, zone: string, after: number): number | null {
  const cutoff = rule.frequency === 'once' ? Infinity : Date.parse(rule.endsAt);
  if (after >= cutoff) return null;
  let candidates: number[] = [];
  if (rule.frequency === 'once') candidates = rule.slots.flatMap((slot) => instants(slot.date, slot.time, zone));
  else if (rule.frequency === 'hourly') {
    for (let at = Math.floor(after / 60000) * 60000 + 60000; at < cutoff && at <= after + 3 * 3600000; at += 60000) {
      const p = parts(at, zone);
      if (rule.slots.some((slot) => slot.minute === p.minute) && instants(p.date, p.time, zone)[0] === at) return at;
    }
  } else {
    const date = parts(after, zone).date;
    for (let day = 0; day < 9; day++) {
      const localDate = new Date(Date.parse(`${date}T00:00:00Z`) + day * 86400000).toISOString().slice(0, 10);
      const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay() || 7;
      candidates.push(...rule.slots.filter((slot) => rule.frequency !== 'weekly' || ('weekday' in slot && slot.weekday === weekday)).flatMap((slot) => instants(localDate, slot.time, zone)));
    }
  }
  return candidates.filter((at) => at > after && at < cutoff).sort((a, b) => a - b)[0] ?? null;
}
export interface ScheduledDelivery { status: string; reason?: string }
export class ScheduledMessagesService {
  #state: State;
  #running: Promise<void> | undefined;
  #closed = false;
  readonly #store: ScheduledStore;
  readonly #now: () => number;
  readonly timeZone: string;
  readonly #reconcile: ((target: ScheduledTarget, id: string) => Promise<ScheduledDelivery | null>) | undefined;
  readonly #deliver: (target: ScheduledTarget, text: string, id: string, recurring: boolean) => Promise<ScheduledDelivery>;
  constructor(options: { store: ScheduledStore; timeZone?: string; now?: () => number; deliver: (target: ScheduledTarget, text: string, id: string, recurring: boolean) => Promise<ScheduledDelivery>; reconcile?: (target: ScheduledTarget, id: string) => Promise<ScheduledDelivery | null> }) {
    this.#store = options.store; this.#now = options.now ?? Date.now; this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; this.#deliver = options.deliver; this.#reconcile = options.reconcile;
    const loaded = options.store.load();
    const parsed = object(loaded);
    if (loaded !== undefined && (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.exceptions))) throw new Error('Corrupt scheduled message state');
    this.#state = loaded === undefined ? { version: 1, tasks: [], exceptions: [] } : loaded as State;
    for (const task of this.#state.tasks) {
      validateRule(task.rule, task.timeZone);
      if (!task.id || !task.target?.sessionId || !task.target.tmuxSession || typeof task.text !== 'string' || !Number.isFinite(task.cursor) || !Number.isSafeInteger(task.revision)) throw new Error('Corrupt scheduled message task');
      if (task.claim) { this.#exception(task, task.claim.at, 'delivery_unconfirmed', true, task.claim.text); task.blocked = true; task.blockedAt = task.claim.at; task.lastAt = task.claim.at; task.lastResult = 'delivery_unconfirmed'; if (task.rule.frequency === 'once' && task.nextAt === null) task.state = 'exception'; task.enabled = false; delete task.claim; }
    }
    if (loaded !== undefined) this.#store.save(this.#state);
  }
  activeTargets(): ScheduledTarget[] { return this.#state.tasks.filter((task) => (task.state === 'active' && task.enabled) || task.blocked).map((task) => structuredClone(task.target)); }
  snapshot(scope: ScheduledScope) { requiredScope(scope); return structuredClone({ serverNow: this.#now(), timeZone: this.timeZone, tasks: this.#state.tasks.filter((task) => inScope(task.target, scope)), exceptions: this.#state.exceptions.filter((item) => inScope(item.target, scope)) }); }
  preview(raw: unknown, zone = this.timeZone) { const now = this.#now(); const rule = validateRule(raw, zone); validateCutoffLimit(rule, now); return { serverNow: now, timeZone: zone, nextAt: nextOccurrence(rule, zone, now) }; }
  #transaction<T>(operation: () => T): T { const before = structuredClone(this.#state); try { const result = operation(); this.#store.save(this.#state); return structuredClone(result); } catch (error) { this.#state = before; throw error; } }
  #newTask(target: ScheduledTarget, raw: unknown, zone = this.timeZone): ScheduledTask {
    const value = object(raw); const rule = validateRule(value, zone);
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 256 * 1024) throw new ScheduledError('Message text is required');
    const now = this.#now(); validateCutoffLimit(rule, now); const nextAt = nextOccurrence(rule, zone, now);
    if (nextAt === null) throw new ScheduledError('Choose a future scheduled time and cutoff');
    const task: ScheduledTask = { id: randomUUID(), revision: 1, target: structuredClone(target), text: value.text.trim(), rule, timeZone: zone, enabled: true, state: 'active', createdAt: now, cursor: now, nextAt };
    this.#state.tasks.push(task); return task;
  }
  create(target: ScheduledTarget, raw: unknown) { return this.#transaction(() => this.#newTask(target, raw)); }
  #task(scope: ScheduledScope, id: string, revision: number) { requiredScope(scope); const task = this.#state.tasks.find((item) => item.id === id && inScope(item.target, scope)); if (!task) throw new ScheduledError('Scheduled message no longer exists', 'not_found'); if (task.revision !== revision) throw new ScheduledError('Changed on another client. Reload the list.', 'conflict'); return task; }
  update(scope: ScheduledScope, id: string, revision: number, raw: unknown) {
    return this.#transaction(() => {
      const task = this.#task(scope, id, revision); const value = object(raw); const now = this.#now();
      if (task.state !== 'active' || task.claim) throw new ScheduledError('This occurrence is being submitted or has ended', 'conflict');
      if (value.frequency !== undefined) { task.rule = validateRule(value, task.timeZone); validateCutoffLimit(task.rule, now); task.cursor = now; task.nextAt = nextOccurrence(task.rule, task.timeZone, task.cursor); if (task.nextAt === null) throw new ScheduledError('Choose a future scheduled time and cutoff'); }
      if (value.text !== undefined) { if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 256 * 1024) throw new ScheduledError('Message text is required'); task.text = value.text.trim(); }
      if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') invalid(); if (task.blocked && value.enabled) throw new ScheduledError('Resolve uncertain delivery in Queue before creating another schedule', 'conflict'); if (value.enabled && !task.enabled) { task.cursor = now; task.nextAt = nextOccurrence(task.rule, task.timeZone, task.cursor); if (task.nextAt === null && (task.rule.frequency === 'once' || now >= Date.parse(task.rule.endsAt))) { task.state = 'ended'; task.endedAt = now; } } task.enabled = value.enabled; }
      task.revision++; return task;
    });
  }
  remove(scope: ScheduledScope, id: string, revision: number) { return this.#transaction(() => { const task = this.#task(scope, id, revision); this.#state.tasks = this.#state.tasks.filter((item) => item !== task); return { ok: true }; }); }
  resolveException(scope: ScheduledScope, id: string, revision: number, raw: unknown) {
    requiredScope(scope);
    return this.#transaction(() => {
      const item = this.#state.exceptions.find((candidate) => candidate.id === id && inScope(candidate.target, scope));
      if (!item || item.revision !== revision) throw new ScheduledError('Exception already changed. Reload the list.', 'conflict');
      const value = object(raw);
      if (value.action === 'reschedule') { if (item.unknown) throw new ScheduledError('Delivery is uncertain. Check conversation and Queue; automatic resend is disabled.', 'conflict'); const rule = object(value.rule); if (rule.frequency !== 'once') invalid(); this.#newTask(item.target, { ...rule, text: item.text }, item.timeZone); }
      else if (value.action !== 'discard') invalid();
      this.#state.exceptions = this.#state.exceptions.filter((candidate) => candidate !== item);
      this.#state.tasks = this.#state.tasks.filter((task) => task.id !== item.taskId || task.rule.frequency !== 'once' || task.state !== 'exception' || task.nextAt !== null || task.blocked === true);
      return { ok: true };
    });
  }
  #exception(task: ScheduledTask, at: number, reason: string, unknown = false, text = task.text, count?: number) {
    const id = `${task.id}:${at}`;
    if (!this.#state.exceptions.some((item) => item.id === id)) this.#state.exceptions.push({ id, revision: 1, taskId: task.id, target: structuredClone(task.target), text, timeZone: task.timeZone, scheduledAt: at, reason, unknown, ...(count ? { count } : {}) });
  }
  tick(): Promise<void> { if (this.#closed) return Promise.resolve(); if (this.#running) return this.#running; const operation = this.#tick(); this.#running = operation; return operation.finally(() => { if (this.#running === operation) this.#running = undefined; }); }
  async close() { this.#closed = true; await this.#running; }
  async #tick() {
    for (const id of this.#state.tasks.map((task) => task.id)) {
      if (this.#closed) return;
      const task = this.#state.tasks.find((item) => item.id === id);
      if (!task) continue;
      if (task.blocked && task.blockedAt !== undefined && this.#reconcile) {
        let receipt: ScheduledDelivery | null = null;
        try { receipt = await this.#reconcile(task.target, `scheduled:${task.id}:${task.blockedAt}`); } catch { /* uncertainty remains visible */ }
        if (receipt && ['accepted', 'queued'].includes(receipt.status)) {
          this.#transaction(() => {
            this.#state.exceptions = this.#state.exceptions.filter((item) => item.id !== `${task.id}:${task.blockedAt}`);
            delete task.blocked; delete task.blockedAt; task.lastResult = 'submitted'; if (task.rule.frequency === 'once') task.state = task.nextAt !== null ? 'active' : this.#state.exceptions.some((item) => item.taskId === task.id) ? 'exception' : 'ended'; task.revision++;
          });
        }
      }
      // Older versions could persist the cutoff itself as the next occurrence. It is not a missed send.
      if (task.state === 'active' && !task.claim && task.rule.frequency !== 'once' && task.nextAt !== null && task.nextAt >= Date.parse(task.rule.endsAt)) {
        this.#transaction(() => { task.nextAt = null; task.revision++; });
      }
      if (task.state === 'active' && task.rule.frequency !== 'once' && this.#now() >= Date.parse(task.rule.endsAt) && (!task.enabled || task.nextAt === null)) {
        this.#transaction(() => { task.state = 'ended'; task.nextAt = null; task.endedAt = this.#now(); task.revision++; });
      }
      if (task.state !== 'active' || !task.enabled || task.claim || task.nextAt === null) continue;
      const now = this.#now(); if (task.nextAt > now) continue;
      if (task.rule.frequency === 'once') {
        // Each absolute slot is independent: a recovery window may contain several intentional sends.
        while (this.#state.tasks.includes(task) && task.nextAt !== null && task.nextAt <= now && task.enabled && !task.blocked) {
          const scheduledAt = task.nextAt;
          this.#transaction(() => {
            task.cursor = scheduledAt; task.lastAt = scheduledAt;
            task.nextAt = nextOccurrence(task.rule, task.timeZone, scheduledAt); task.revision++;
            if (now - scheduledAt > 600000) { this.#exception(task, scheduledAt, 'missed'); task.lastResult = 'missed'; }
            else task.claim = { at: scheduledAt, text: task.text, target: structuredClone(task.target) };
          });
          if (task.claim) await this.#submitClaim(task);
          this.#transaction(() => {
            if (task.nextAt !== null) task.state = 'active';
            else { task.state = this.#state.exceptions.some((item) => item.taskId === task.id) ? 'exception' : 'ended'; task.endedAt = this.#now(); }
          });
        }
        continue;
      }
      const due: number[] = []; let at: number | null = task.nextAt;
      let range: { from: number; through: number } | undefined;
      while (at !== null && at <= now) {
        due.push(at);
        const next = nextOccurrence(task.rule, task.timeZone, at);
        if (due.length >= 256 && next !== null && next <= now - 600000) {
          range = { from: task.nextAt!, through: now - 600001 };
          due.length = 0;
          at = nextOccurrence(task.rule, task.timeZone, now - 600001);
        } else at = next;
      }
      // A long outage may have no eligible recent slot; the range still records all old misses.
      const latest = due.at(-1) ?? range?.through ?? task.nextAt!;
      const cutoff = Date.parse(task.rule.endsAt);
      const cutoffPassed = now >= cutoff;
      this.#transaction(() => {
        if (range) {
          this.#exception(task, range.from, 'missed');
          this.#state.exceptions.find((item) => item.id === `${task.id}:${range!.from}`)!.missedThroughAt = range.through;
        }
        for (const missed of due.slice(0, -1)) this.#exception(task, missed, 'missed');
        task.cursor = latest; task.nextAt = at; task.lastAt = latest; task.revision++;
        if (!due.length || now - latest > 600000 || cutoffPassed) { if (due.length) this.#exception(task, latest, 'missed'); task.lastResult = 'missed'; }
        else { task.claim = { at: latest, text: task.text, target: structuredClone(task.target) }; }
        if (now >= cutoff) { task.state = 'ended'; task.endedAt = now; }
      });
      await this.#submitClaim(task);

    }
  }
  async #submitClaim(task: ScheduledTask): Promise<void> {
      const claim = structuredClone(task.claim as ScheduledTask['claim']);
      if (!claim) return;
      let receipt: ScheduledDelivery;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { receipt = await Promise.race([this.#deliver(claim.target, claim.text, `scheduled:${task.id}:${claim.at}`, task.rule.frequency !== 'once'), new Promise<ScheduledDelivery>((resolve) => { timer = setTimeout(() => resolve({ status: 'unknown', reason: 'delivery_unconfirmed' }), 25_000); timer.unref?.(); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      catch { receipt = { status: 'unknown', reason: 'delivery_unconfirmed' }; }
      this.#transaction(() => {
        // A deletion only cancels future occurrences; the already claimed effect remains owned by Core.
        const current = this.#state.tasks.find((item) => item.id === task.id);
        task = current ?? task;
        const successful = receipt.status === 'accepted' || receipt.status === 'queued';
        const skipped = task.rule.frequency !== 'once' && ['duplicate_queued', 'queue_full'].includes(receipt.reason ?? '');
        task.lastResult = successful ? 'submitted' : skipped ? receipt.reason! : receipt.reason ?? receipt.status;
        if (!successful && !skipped) { this.#exception(task, claim.at, receipt.reason ?? receipt.status, receipt.status === 'unknown', claim.text); if (task.rule.frequency === 'once' && task.nextAt === null) task.state = 'exception'; }
        if (receipt.status === 'unknown') { task.blocked = true; task.blockedAt = claim.at; task.enabled = false; }
        if (receipt.reason === 'target_changed') task.enabled = false;
        delete task.claim; task.revision++;
      });
  }

}
