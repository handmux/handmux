import { expect, it } from 'vitest';
import { codexUsageLimitRecovery } from '../src/agents/codexUsageLimitRecovery.js';
const eventAt = Date.parse('2026-10-20T15:30:00Z');
it.each([
  ['Oct 21st, 2026 12:53 AM +08:00', '2026-10-20T16:53:00Z'],
  ['Oct 21st, 2026 12:53 PM +08:00', '2026-10-21T04:53:00Z'],
  ['Oct 21st, 2026 12:53 AM GMT+08:00', '2026-10-20T16:53:00Z'],
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
it.each(['Oct 21st, 2026 12:53 AM', '11:09 AM', 'Feb 31st, 2026 12:00 UTC', 'Oct 21st, 2026 13:53 PM +08:00', 'Oct 21st, 2026 12:53 AM UTC+8', '2026-02-31T12:00:00Z'])('does not guess unproved process Local or malformed dates: %s', date => {
  expect(codexUsageLimitRecovery({ codex_error_info: 'usage_limit_exceeded', message: `Try again at ${date}.` }, eventAt)).toEqual({ kind: 'usage_limit' });
});
it('leaves unrelated capacity and authorization errors alone', () => {
  expect(codexUsageLimitRecovery({ codex_error_info: 'server_overloaded', message: 'Selected model is at capacity' }, eventAt)).toBeUndefined();
  expect(codexUsageLimitRecovery({ message: 'Authentication failed' }, eventAt)).toBeUndefined();
});
