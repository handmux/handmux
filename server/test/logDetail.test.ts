import { expect, it } from 'vitest';
import { logDetail } from '../src/logDetail.js';

// Reported from the field (issue #6): the Connector passes a bag of details as the log line's second value,
// and String() rendered it as `[object Object]`, so neither the operator nor the reporter could tell which
// event had been discarded.
it('renders structured details instead of [object Object]', () => {
  expect(logDetail({ eventId: 'event-0000000000000203-38318.json', paneId: '%3' }))
    .toBe(': {"eventId":"event-0000000000000203-38318.json","paneId":"%3"}');
  expect(logDetail({ dropped: 2, remaining: 1 })).toBe(': {"dropped":2,"remaining":1}');
  expect(logDetail({})).not.toContain('[object Object]');
});

it('keeps an Error as its message and a primitive as itself', () => {
  expect(logDetail(new Error('ENOENT: no such file or directory'))).toBe(': ENOENT: no such file or directory');
  expect(logDetail(5)).toBe(': 5');
  expect(logDetail(undefined)).toBe('');
});

it('bounds the detail and never throws on a value it cannot serialize', () => {
  expect(logDetail({ blob: 'x'.repeat(2_000) })).toMatch(/^: \{"blob":"x+…$/);
  expect(logDetail({ blob: 'x'.repeat(2_000) }).length).toBeLessThan(600);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(logDetail(circular)).toBe('');
});
