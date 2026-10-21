import { t } from './i18n';
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

export function scheduledRelativeTime(at: number, serverNow: number): string {
  const minutes = Math.max(0, Math.ceil((at - serverNow) / 60000));
  if (!minutes) return t('scheduled.pending');
  const days = Math.floor(minutes / 1440); const hours = Math.floor(minutes % 1440 / 60); const rest = minutes % 60;
  const duration = [[days, 'Days'], [hours, 'Hours'], [rest, 'Minutes']].filter(([count]) => Number(count) > 0)
    .map(([count, unit]) => t(`scheduled.duration${unit}`, { count })).join(t('scheduled.durationSeparator'));
  return t('scheduled.inDuration', { duration });
}
export function scheduledRuleSummary(rule: ScheduledRule): string {
  if (rule.frequency === 'hourly') return rule.slots.map(slot => t('scheduled.hourlyMinute', { minute: String(slot.minute ?? 0).padStart(2, '0') })).join(' / ');
  const slots = [...rule.slots].sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0));
  return `${t(`scheduled.${rule.frequency}`)} ${slots.map(slot => `${rule.frequency === 'weekly' ? `${t(`scheduled.day.${slot.weekday}`)} ` : slot.date ? `${scheduledDisplayLocal(slot.date, true)} ` : ''}${slot.time ?? ''}`).join(' / ')}`;
}
