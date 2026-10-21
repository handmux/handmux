import type { ScheduledRule } from './scheduledMessagesApi.js';

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/** A local calendar value in the server-owned zone; never consult the browser clock or zone. */
export function scheduledLocalInput(at: number, timeZone: string): string {
  let formatter = calendarFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (calendarFormatters.size >= 4) calendarFormatters.delete(calendarFormatters.keys().next().value!);
    calendarFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function scheduledOnceDefault(serverNow: number, timeZone: string): ScheduledRule['slots'] {
  const [date, time] = scheduledLocalInput(serverNow + 3600000, timeZone).split('T');
  return [{ date: date!, time: time! }];
}

export function scheduledSummary(text: string): string {
  const summary = text.replace(/\s+/g, ' ').trim();
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

export function scheduledRuleComplete(rule: { frequency: ScheduledRule['frequency']; slots: ScheduledRule['slots']; endsAtLocal?: string }): boolean {
  if (!rule.slots.length || (rule.frequency !== 'once' && !rule.endsAtLocal)) return false;
  return rule.slots.every((slot) => rule.frequency === 'hourly'
    ? Number.isInteger(slot.minute) && Number(slot.minute) >= 0 && Number(slot.minute) < 60
    : !!slot.time && (rule.frequency !== 'once' || !!slot.date));
}

/** Fixed presentation of a server-zone calendar value; keep ISO values for native inputs/API. */
export function scheduledDisplayLocal(value: string, includeYear = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(value);
  return match ? `${includeYear ? `${match[1]}/` : ''}${match[2]}/${match[3]}${match[4] ? ` ${match[4]}` : ''}` : value;
}

/** Scheduling is minute-granular: never truncate the one-minute recovery margin. */
export function scheduledRecoveryTime(retryAt: number | undefined, now: number): number | undefined {
  if (retryAt === undefined || !Number.isSafeInteger(retryAt) || retryAt <= 0 || retryAt > 8_640_000_000_000_000 - 120000) return undefined;
  const at = Math.ceil((retryAt + 60000) / 60000) * 60000;
  return at > now ? at : undefined;
}
