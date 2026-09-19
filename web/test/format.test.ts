// web/test/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatBytes, formatRelativeTime } from '../src/format.js';
import type { LanguageCode } from '../src/i18n/index.js';

describe('formatBytes', () => {
  it('keeps whole bytes below 1KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('scales through KB / MB / GB / TB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('stops at a whole number from 10 units up', () => {
    expect(formatBytes(15.4 * 1024)).toBe('15 KB');
    expect(formatBytes(10 * 1024 ** 3)).toBe('10 GB');
  });

  it('stays in GB past a gigabyte (the listing used to print "2048.0 MB")', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatBytes(9.5 * 1024 ** 3)).toBe('9.5 GB');
  });

  it('returns the caller-supplied fallback for a missing or invalid size', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    // A list row wants nothing at all rather than an em dash.
    expect(formatBytes(undefined, '')).toBe('');
  });
});

describe('formatRelativeTime', () => {
  const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ago = (ms: number, lang: LanguageCode = 'zh'): string => formatRelativeTime(NOW - ms, NOW, lang);

  it('reads as the locale one-off for the first minute', () => {
    expect(ago(0)).toBe('现在');
    expect(ago(30 * SEC)).toBe('现在');
    expect(ago(59 * SEC)).toBe('现在');
    expect(formatRelativeTime(NOW - 30 * SEC, NOW, 'en')).toBe('now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(ago(MIN)).toBe('1分钟前');
    expect(ago(3 * MIN)).toBe('3分钟前');
    expect(ago(59 * MIN)).toBe('59分钟前');
    expect(ago(HOUR)).toBe('1小时前');
    expect(ago(23 * HOUR)).toBe('23小时前');
    expect(ago(3 * DAY)).toBe('3天前');
    expect(ago(29 * DAY)).toBe('29天前');
  });

  it('falls back to the coarser unit past each boundary', () => {
    expect(ago(60 * MIN)).toBe('1小时前');
    expect(ago(24 * HOUR)).toBe('昨天');
    expect(ago(2 * DAY)).toBe('前天');
    expect(ago(40 * DAY)).toBe('上个月');
    expect(ago(120 * DAY)).toBe('3个月前');
    expect(ago(400 * DAY)).toBe('去年');
    expect(ago(3 * 365 * DAY)).toBe('3年前');
  });

  it('never renders a 13th month — the window rounds into a year', () => {
    // 362 days is the widest gap the month bucket can cover; with a 30-day month this was "12 个月前".
    expect(ago(362 * DAY)).toBe('11个月前');
    expect(ago(366 * DAY)).toBe('去年');
  });

  it('is localized, not just translated by hand', () => {
    expect(formatRelativeTime(NOW - 3 * MIN, NOW, 'en')).toBe('3 minutes ago');
    expect(formatRelativeTime(NOW - 2 * DAY, NOW, 'en')).toBe('2 days ago');
    expect(formatRelativeTime(NOW - 2 * DAY, NOW, 'ja')).toBe('一昨日');
    expect(formatRelativeTime(NOW - 2 * DAY, NOW, 'ko')).toBe('그저께');
    expect(formatRelativeTime(NOW - 2 * DAY, NOW, 'zh-TW')).toBe('前天');
  });

  it('renders nothing when there is no usable timestamp', () => {
    // A stat that failed mid-list leaves the entry without an mtime — better a blank column than 1970.
    expect(formatRelativeTime(0)).toBe('');
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime(undefined)).toBe('');
    expect(formatRelativeTime(Number.NaN)).toBe('');
    expect(formatRelativeTime(-5)).toBe('');
  });

  it('reads a future mtime as now instead of a countdown', () => {
    // Clock skew between the server's filesystem and the phone must not print "3 小时后".
    expect(formatRelativeTime(NOW + 3 * HOUR, NOW, 'zh')).toBe('现在');
    expect(formatRelativeTime(NOW + 10 * DAY, NOW, 'zh')).toBe('现在');
  });
});
