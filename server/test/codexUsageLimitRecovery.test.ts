import { expect, it } from 'vitest';
import { codexUsageLimitRecovery } from '../src/agents/codexUsageLimitRecovery.js';
const eventAt = Date.parse('2026-10-20T15:30:00Z');
it.each([
  ['Oct 21st, 2026 12:53 AM +08:00', '2026-10-20T16:53:00Z'],
  ['Oct 21st, 2026 12:53 PM +08:00', '2026-10-21T04:53:00Z'],
  ['Oct 21st, 2026 12:53 AM GMT+08:00', '2026-10-20T16:53:00Z'],
  ['Oct 21st, 2026 12:53 AM\n+08:00', '2026-10-20T16:53:00Z'],
  ['Dec 31st, 2026 23:59 UTC', '2026-12-31T23:59:00Z'],
  ['Jan 1st, 2027 00:01 Z', '2027-01-01T00:01:00Z'],
  ['2026-10-21T00:53:00+08:00', '2026-10-20T16:53:00Z'],
])('reads explicit zones and ordinal/12-hour dates: %s', (date, iso) => {
  expect(codexUsageLimitRecovery({ message: `You've hit your usage\nlimit. Try again at ${date}.` }, eventAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse(iso) });
});
it('prefers the current structured reset and uses event time for relative delays', () => {
  expect(codexUsageLimitRecovery({ codex_error_info: 'UsageLimitExceeded', resets_at: '2026-10-22T01:00:00Z', message: 'try again in 2 minutes' }, eventAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse('2026-10-22T01:00:00Z') });
  expect(codexUsageLimitRecovery({ code: 'RateLimitExceeded', message: 'Try again in 2 minutes' }, eventAt)).toEqual({ kind: 'usage_limit', retryAt: eventAt + 120000 });
  expect(codexUsageLimitRecovery({ code: 'usage_limit_exceeded', message: 'try again in 2 minutes' })).toEqual({ kind: 'usage_limit' });
});
it.each(['Feb 31st, 2026 12:00 UTC', 'Oct 21st, 2026 13:53 PM +08:00', 'Oct 21st, 2026 12:53 AM UTC+8', '2026-02-31T12:00:00Z'])('rejects malformed dates and explicit zones: %s', date => {
  expect(codexUsageLimitRecovery({ codex_error_info: 'usage_limit_exceeded', message: `Try again at ${date}.` }, eventAt)).toEqual({ kind: 'usage_limit' });
});
it('leaves unrelated capacity and authorization errors alone', () => {
  expect(codexUsageLimitRecovery({ codex_error_info: 'server_overloaded', message: 'Selected model is at capacity' }, eventAt)).toBeUndefined();
  expect(codexUsageLimitRecovery({ message: 'Authentication failed' }, eventAt)).toBeUndefined();
});

const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function localParts(at: number | undefined): Record<string, string> {
  expect(at).toBeDefined();
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: serverZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
}
it('interprets a complete unzoned date in the server timezone without requiring an event timestamp', () => {
  const value = codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at Oct 21st, 2026 12:53 AM.' });
  expect(localParts(value?.retryAt)).toMatchObject({ year: '2026', month: '10', day: '21', hour: '00', minute: '53' });
  const expected = { 'Asia/Shanghai': '2026-10-20T16:53:00Z', 'America/New_York': '2026-10-21T04:53:00Z', UTC: '2026-10-21T00:53:00Z' }[serverZone];
  if (expected) expect(value?.retryAt).toBe(Date.parse(expected));
});
it('uses the event local date for short times across midnight/year boundaries and never guesses tomorrow', () => {
  const occurredAt = Date.parse('2026-12-31T23:30:00Z');
  const error = { code: 'UsageLimitExceeded', message: 'Try again at 11:09 AM.' };
  const value = codexUsageLimitRecovery(error, occurredAt);
  const eventDate = localParts(occurredAt);
  expect(localParts(value?.retryAt)).toMatchObject({ year: eventDate.year, month: eventDate.month, day: eventDate.day, hour: '11', minute: '09' });
  expect(codexUsageLimitRecovery(error)).toEqual({ kind: 'usage_limit' });
  const expected = { 'Asia/Shanghai': '2027-01-01T03:09:00Z', 'America/New_York': '2026-12-31T16:09:00Z', UTC: '2026-12-31T11:09:00Z' }[serverZone];
  if (expected) expect(value?.retryAt).toBe(Date.parse(expected));
});
it.each(['11:09 AM UTC+8', 'Oct 21st, 2026 12:53 AM\nUTC+8', '11:09 AM\nPST', '11:09 AM PST', '11:09 AM Europe/Paris', '11:09 AP', '13:53 PM', 'Oct 21st, 2026 12:53 AM PST', 'Feb 31st, 2026 11:09 AM'])('does not fall back to a bare clock for invalid or explicitly unknown formats: %s', date => {
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: `Try again at ${date}.` }, eventAt)).toEqual({ kind: 'usage_limit' });
});
it.runIf(serverZone === 'America/New_York')('rejects the nonexistent local hour in the DST spring gap', () => {
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at Mar 8th, 2026 2:30 AM.' }, eventAt)).toEqual({ kind: 'usage_limit' });
});

it.runIf(serverZone === 'America/New_York')('rejects ambiguous fall-back clocks but honors explicit offsets and structured reset times', () => {
  const occurredAt = Date.parse('2026-11-01T01:15:00-04:00');
  for (const clock of ['1:30 AM', 'Nov 1st, 2026 1:30 AM']) {
    expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: `Try again at ${clock}.` }, occurredAt)).toEqual({ kind: 'usage_limit' });
  }
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at Nov 1st, 2026 1:30 AM -05:00.' }, occurredAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse('2026-11-01T06:30:00Z') });
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', resets_at: '2026-11-01T06:30:00Z', message: 'Try again at 1:30 AM.' }, occurredAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse('2026-11-01T06:30:00Z') });
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at 2:30 AM.' }, occurredAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse('2026-11-01T07:30:00Z') });
});
it.runIf(serverZone === 'Australia/Lord_Howe')('rejects a half-hour DST fold without rejecting adjacent unambiguous clocks', () => {
  const occurredAt = Date.parse('2026-04-05T01:35:00+11:00');
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at 1:45 AM.' }, occurredAt)).toEqual({ kind: 'usage_limit' });
  expect(codexUsageLimitRecovery({ code: 'UsageLimitExceeded', message: 'Try again at 2:15 AM.' }, occurredAt)).toEqual({ kind: 'usage_limit', retryAt: Date.parse('2026-04-04T15:45:00Z') });
});
