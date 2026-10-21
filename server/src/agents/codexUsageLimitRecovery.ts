import type { ConversationRecovery } from '../agent-runtime/conversationTypes.js';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
function absoluteTime(value: unknown): number | undefined {
  if (typeof value === 'number') {
    const at = value < 1e12 ? value * 1000 : value;
    return validTime(at) ? at : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (!iso) return undefined;
  const year = Number(iso[1]); const month = Number(iso[2]); const day = Number(iso[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59) return undefined;
  const at = Date.parse(value);
  return validTime(at) ? at : undefined;
}

/** Codex local text follows the server timezone by the user's explicit scheduling policy. */
function textResetTime(message: string, occurredAt?: number): number | undefined {
  const source = message.replace(/\s+/g, ' ').trim();
  // Official format_retry_timestamp: full date outside today, clock only on the event's local day.
  // https://github.com/openai/codex/blob/c419fd01a70dd1d05356da443ac44328bda2e6f4/codex-rs/protocol/src/error.rs
  const full = source.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?([^\r\n]*)/i);
  const short = full ? null : source.match(/\btry\s+again\s+at\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?([^\r\n]*)/i);
  if (!full && (!short || occurredAt === undefined || !validTime(occurredAt))) return undefined;
  const clock = full ? full.slice(4) : short!.slice(1);
  const hour = Number(clock[0]); const minute = Number(clock[1]); const meridiem = clock[2]?.toUpperCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return undefined;
  const hours = meridiem ? hour % 12 + (meridiem === 'PM' ? 12 : 0) : hour;
  // Inspect the entire suffix before sentence punctuation. Unknown/malformed explicit zones or
  // AM/PM must fail closed, rather than being reinterpreted by a second bare-clock matcher.
  const zone = (clock[3] ?? '').split(/[.!?;]/, 1)[0]!.trim();
  if (zone && !/^(?:(?:UTC|GMT)?[+-]\d{2}:?\d{2}|Z|UTC|GMT)$/i.test(zone)) return undefined;
  if (!full && zone) return undefined; // A dated, explicit-offset format is required for this path.
  const event = new Date(occurredAt ?? 0);
  const year = full ? Number(full[3]) : event.getFullYear();
  const month = full ? ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(full[1]!.slice(0, 3).toLowerCase()) + 1 : event.getMonth() + 1;
  const day = full ? Number(full[2]) : event.getDate();
  if (zone) {
    const offset = /^(?:Z|UTC|GMT)$/i.test(zone) ? 'Z' : zone.replace(/^(?:UTC|GMT)/i, '');
    return absoluteTime(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`);
  }
  const local = new Date(year, month - 1, day, hours, minute, 0, 0);
  // Date normalizes invalid dates and spring-forward gaps; reject changed components.
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day
    || local.getHours() !== hours || local.getMinutes() !== minute) return undefined;
  const at = local.getTime();
  // Date chooses the earlier instant in a fold. Check the actual offset change, including
  // half-hour transitions, and reject if the later instant has the same local components.
  const tomorrow = new Date(year, month - 1, day + 1, hours, minute, 0, 0);
  const offsetChange = tomorrow.getTimezoneOffset() - local.getTimezoneOffset();
  if (offsetChange > 0) {
    const later = new Date(at + offsetChange * 60000);
    if (later.getFullYear() === year && later.getMonth() === month - 1 && later.getDate() === day
      && later.getHours() === hours && later.getMinutes() === minute) return undefined;
  }
  return validTime(at) ? at : undefined;
}

/** Only called for native provider errors, never user/assistant content. */
export function codexUsageLimitRecovery(value: unknown, occurredAt?: number): ConversationRecovery | undefined {
  const error = record(value);
  const message = typeof error.message === 'string' ? error.message : '';
  const info = error.codex_error_info ?? error.code ?? error.type;
  const code = typeof info === 'string' ? info : Object.keys(record(info)).join(' ');
  if (!/usage[_\s-]*limit[_\s-]*exceeded|rate[_\s-]*limit[_\s-]*exceeded/i.test(code)
    && !/\b(?:usage[\s_-]+limit|rate[\s_-]+limit|too many requests)\b/i.test(message)) return undefined;
  let retryAt = absoluteTime(error.resets_at);
  if (retryAt === undefined) {
    const iso = message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/i)?.[0];
    retryAt = absoluteTime(iso);
  }
  if (retryAt === undefined) retryAt = textResetTime(message, occurredAt);
  if (retryAt === undefined && occurredAt !== undefined && validTime(occurredAt)) {
    const relative = message.match(/\btry again in\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?)\b/i);
    if (relative) {
      const delay = Number(relative[1]) * (/^hour/i.test(relative[2]!) ? 3600000 : /^minute/i.test(relative[2]!) ? 60000 : 1000);
      const at = occurredAt + delay;
      if (validTime(at)) retryAt = at;
    }
  }
  return { kind: 'usage_limit', ...(retryAt === undefined ? {} : { retryAt }) };
}
