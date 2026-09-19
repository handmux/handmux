// Display formatting shared by the file browser and the document preview: byte sizes and "how long
// ago" timestamps. Both surfaces used to carry their own copy; the browser's had no GB step at all,
// so anything past a gigabyte rendered as "2048.0 MB".
import { getLangCode } from './i18n';

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

// Bytes → short human string. Below 1KB it stays in whole bytes; from KB up one decimal below 10 and
// a whole number above, so a row reads "512 B" / "2.0 KB" / "4.2 MB" / "1 GB". `dash` is what callers
// want for a missing value — the preview's info panel shows '—', a list row shows nothing.
export const formatBytes = (bytes: number | null | undefined, dash = '—'): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return dash;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
// The average month, not 30 days: with 30 the "[360d, 365d)" window would render as "12 个月前", and
// these buckets are the coarse ones a desktop file manager uses, not calendar arithmetic.
const MONTH = YEAR / 12;

// Constructing an Intl formatter is not free and a directory row calls this once per entry (up to
// MAX_ROWS of them), so keep one per locale.
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
const relative = (lang: string): Intl.RelativeTimeFormat => {
  let rtf = rtfCache.get(lang);
  if (!rtf) { rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }); rtfCache.set(lang, rtf); }
  return rtf;
};

// mtime → "现在 / 3分钟前 / 2小时前 / 5天前 / 3个月前 / 2年前", the shape a desktop file manager shows.
// `numeric:'auto'` also gives the nicer one-off words for free (昨天 / 前天 / yesterday), localized into
// every locale we ship. Returns '' when there is no usable timestamp (stat failed) so a row can leave
// the column blank rather than print a wrong time. A future mtime (clock skew) reads as "now".
export const formatRelativeTime = (ms: number | null | undefined, now = Date.now(), lang = getLangCode()): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const ago = now - ms;
  const at = relative(lang);
  if (ago < MINUTE) return at.format(0, 'second');
  if (ago < HOUR) return at.format(-Math.floor(ago / MINUTE), 'minute');
  if (ago < DAY) return at.format(-Math.floor(ago / HOUR), 'hour');
  if (ago < MONTH) return at.format(-Math.floor(ago / DAY), 'day');
  if (ago < YEAR) return at.format(-Math.floor(ago / MONTH), 'month');
  return at.format(-Math.floor(ago / YEAR), 'year');
};
