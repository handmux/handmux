import type { ScheduledRule } from './scheduledMessagesApi.js';

/** A local calendar value in the server-owned zone; never consult the browser clock or zone. */
export function scheduledLocalInput(at: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(({ type, value }) => [type, value]));
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
