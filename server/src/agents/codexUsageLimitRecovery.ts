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
  if (retryAt === undefined) {
    // Codex's official format_retry_timestamp uses process Local. No process-TZ proof is retained
    // for historical sessions, so bare local dates/times deliberately remain manual scheduling.
    // https://github.com/openai/codex/blob/c419fd01a70dd1d05356da443ac44328bda2e6f4/codex-rs/protocol/src/error.rs
    const date = message.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*((?:UTC|GMT)?[+-]\d{2}:?\d{2}|Z|UTC|GMT)(?![+\w-])/i);
    if (date) {
      const hour = Number(date[4]); const minute = Number(date[5]);
      const meridiem = date[6]?.toUpperCase();
      if (minute < 60 && (meridiem ? hour >= 1 && hour <= 12 : hour < 24)) {
        const hours = meridiem ? hour % 12 + (meridiem === 'PM' ? 12 : 0) : hour;
        const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(date[1]!.slice(0, 3).toLowerCase()) + 1;
        const day = Number(date[2]); const year = Number(date[3]);
        if (day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()) {
          const offset = /^(?:Z|UTC|GMT)$/i.test(date[7]!) ? 'Z' : date[7]!.replace(/^(?:UTC|GMT)/i, '');
          retryAt = absoluteTime(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`);
        }
      }
    }
  }
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
