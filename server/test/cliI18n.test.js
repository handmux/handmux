import { describe, it, expect } from 'vitest';
import { translate, detectLang } from '../src/cli/i18n/index.js';
import en from '../src/cli/i18n/en.js';
import zh from '../src/cli/i18n/zh.js';

describe('translate', () => {
  const dict = { a: 'zh-A', c: 'zh {x}' };
  const fb = { a: 'en-A', b: 'en-B', c: 'en {x}' };

  it('prefers the active dict, falls back to English, then the key itself', () => {
    expect(translate(dict, fb, 'a')).toBe('zh-A');      // dict hit
    expect(translate(dict, fb, 'b')).toBe('en-B');      // fallback
    expect(translate(dict, fb, 'zzz')).toBe('zzz');     // unknown → key
  });

  it('interpolates {vars} and leaves unknown placeholders intact', () => {
    expect(translate(dict, fb, 'c', { x: 5 })).toBe('zh 5');
    expect(translate(dict, fb, 'c', {})).toBe('zh {x}');
  });
});

describe('detectLang', () => {
  it('honours an explicit --lang / config lang first', () => {
    expect(detectLang({ lang: 'zh' }, {}, { LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(detectLang({}, { lang: 'en' }, { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(detectLang({ lang: 'zh' }, { lang: 'en' }, {})).toBe('zh'); // flag beats config
  });

  it('derives the base language from a POSIX locale string', () => {
    expect(detectLang({}, {}, { LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(detectLang({}, {}, { LC_ALL: 'zh_TW' })).toBe('zh');
  });

  it('falls back to English for language-less or unknown locales', () => {
    expect(detectLang({}, {}, { LANG: 'C.UTF-8' })).toBe('en');
    expect(detectLang({}, {}, { LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLang({}, {}, {})).toBe('en');
  });

  it('ignores an unknown explicit choice and reads the environment instead', () => {
    expect(detectLang({ lang: 'fr' }, {}, { LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });

  it('honours the env-var precedence HANDMUX_LANG > LC_ALL > LC_MESSAGES > LANG', () => {
    expect(detectLang({}, {}, { HANDMUX_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(detectLang({}, {}, { LC_ALL: 'zh', LANG: 'en_US' })).toBe('zh');
  });
});

describe('catalog parity', () => {
  it('zh defines every key en does (no silent English leaks)', () => {
    const missing = Object.keys(en).filter((k) => !(k in zh));
    expect(missing).toEqual([]);
  });

  it('documents both restore forms and provides actionable restore messages in both locales', () => {
    for (const dict of [en, zh]) {
      expect(dict['help.body']).toContain('handmux restore [--dry-run] [--checkpoint <id>] [--session <name>]');
      expect(dict['help.body']).toContain('handmux restore --list');
      expect(dict['restore.error']).toMatch(/\{checkpoint\}/);
      expect(dict['restore.sessionFailed']).toMatch(/\{session\}/);
      expect(dict['restore.sessionFailed']).toMatch(/\{stage\}/);
      expect(dict['restore.retrySession']).toMatch(/\{command\}/);
      expect(dict['restore.retrySession']).not.toMatch(/\{checkpoint\}|\{session\}/);
      expect(dict['restore.retry']).toMatch(/\{command\}/);
      expect(dict['restore.retry']).not.toMatch(/\{checkpoint\}/);
      expect(dict['restore.dryRunHint']).toMatch(/\{command\}/);
      expect(dict['restore.selectionCancelled']).toMatch(/\{command\}/);
      expect(dict['restore.reason.linkedWindows']).toBeTruthy();
      expect(dict['restore.manualRecovery']).toMatch(/\{command\}/);
    }
  });
});
