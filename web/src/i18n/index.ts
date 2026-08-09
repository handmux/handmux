// Lightweight i18n. Default English; auto-detect the browser language; manual override persisted in
// localStorage. Adding a language = create ./<code>.js with the same keys, import it, and add it to the
// two maps below — nothing else changes, and any missing key falls back to English.
import en from './en.js';
import zh from './zh.js';
import zhTW from './zh-TW.js';
import ja from './ja.js';
import ko from './ko.js';

export type LanguageCode = 'zh' | 'zh-TW' | 'en' | 'ja' | 'ko';
type Locale = Record<string, string>;

const LOCALES: Record<LanguageCode, Locale> = { zh, 'zh-TW': zhTW, en, ja, ko };
export const AVAILABLE: readonly { code: LanguageCode; label: string }[] = [
  { code: 'zh',    label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en',    label: 'English' },
  { code: 'ja',    label: '日本語' },
  { code: 'ko',    label: '한국어' },
];

const LANG_KEY = 'tw_lang';

// pure + testable: saved override wins, else first browser language we have a locale for, else English.
// Matching priority: exact code (e.g. zh-TW) first, then base language (e.g. zh), to avoid zh-TW
// collapsing to zh before the exact entry is checked.
export function detectLang(
  saved: unknown,
  languages: readonly unknown[] | null | undefined,
  available: Record<string, Locale> = LOCALES,
): LanguageCode {
  if (typeof saved === 'string' && available[saved]) return saved as LanguageCode;
  for (const l of (languages?.length ? languages : ['en'])) {
    const full = String(l).toLowerCase();
    if (available[full]) return full as LanguageCode;
    const base = full.split('-')[0];
    if (available[base]) return base as LanguageCode;
  }
  return 'en';
}

// pure + testable: current-dict → English-fallback → key, then {var} interpolation.
export function translate(
  dict: Locale | null | undefined,
  fallback: Locale | null | undefined,
  key: string,
  vars?: Record<string, unknown>,
): string {
  let s = dict && dict[key] != null ? dict[key]
        : fallback && fallback[key] != null ? fallback[key]
        : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, name: string) => (
    vars[name] != null ? String(vars[name]) : `{${name}}`
  ));
  return s;
}

const navLangs = (): readonly string[] | null => (
  typeof navigator !== 'undefined' ? (navigator.languages || [navigator.language]) : null
);
const saved = (): string | null => {
  try { return localStorage.getItem(LANG_KEY); } catch { return null; }
};

let current = detectLang(saved(), navLangs());

export function t(key: string, vars?: Record<string, unknown>): string {
  return translate(LOCALES[current], en, key, vars);
}
export function getLangCode(): LanguageCode { return current; }

export function setLang(code: unknown): void {
  if (typeof code !== 'string' || !(code in LOCALES) || code === current) return;
  try { localStorage.setItem(LANG_KEY, code); } catch { /* private mode: in-memory only */ }
  current = code as LanguageCode;
  // The terminal is rebuilt from a fresh capture on load, so a reload is cheap and avoids threading
  // i18n reactivity through every component just to retranslate static labels.
  if (typeof location !== 'undefined') location.reload();
}
