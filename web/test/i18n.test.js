import { describe, it, expect } from 'vitest';
import { detectLang, translate, AVAILABLE } from '../src/i18n/index.js';
import en from '../src/i18n/en.js';
import zh from '../src/i18n/zh.js';
import zhTW from '../src/i18n/zh-TW.js';
import ja from '../src/i18n/ja.js';
import ko from '../src/i18n/ko.js';

const LOCALES = { en: {}, zh: {} };

describe('detectLang', () => {
  it('prefers a saved override that we support', () => {
    expect(detectLang('zh', ['en-US'], LOCALES)).toBe('zh');
  });
  it('ignores a saved override we do not support', () => {
    expect(detectLang('fr', ['zh-CN', 'en'], LOCALES)).toBe('zh');
  });
  it('falls back to the first supported browser language', () => {
    expect(detectLang(null, ['fr-FR', 'zh-CN', 'en'], LOCALES)).toBe('zh');
  });
  it('defaults to English when nothing matches', () => {
    expect(detectLang(null, ['fr-FR', 'de'], LOCALES)).toBe('en');
    expect(detectLang(null, [], LOCALES)).toBe('en');
    expect(detectLang(null, null, LOCALES)).toBe('en');
  });
});

describe('translate', () => {
  const zh = { 'a.b': '你好', 'greet': '你好 {name}' };
  const en = { 'a.b': 'Hello', 'greet': 'Hello {name}', 'only.en': 'Only EN' };

  it('uses the current dict when present', () => {
    expect(translate(zh, en, 'a.b')).toBe('你好');
  });
  it('falls back to English when the key is missing in the current dict', () => {
    expect(translate(zh, en, 'only.en')).toBe('Only EN');
  });
  it('falls back to the key itself when nowhere', () => {
    expect(translate(zh, en, 'nope.nope')).toBe('nope.nope');
  });
  it('interpolates {vars} and leaves unknown vars marked', () => {
    expect(translate(zh, en, 'greet', { name: '世界' })).toBe('你好 世界');
    expect(translate(en, en, 'greet', {})).toBe('Hello {name}');
  });
});

describe('AVAILABLE', () => {
  it('lists at least English and Chinese with code+label', () => {
    const codes = AVAILABLE.map((l) => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('zh');
    AVAILABLE.forEach((l) => { expect(l.label).toBeTruthy(); });
  });
});

describe('API account security copy', () => {
  it.each([['en', en], ['zh', zh]])('%s states encrypted storage and safe recovery ordering', (_code, dict) => {
    expect(dict['apiBalance.storageNote']).toMatch(/encrypted|加密/);
    expect(dict['apiBalance.storageNote']).toMatch(/browser|浏览器/);
    expect(dict['apiBalance.error.storage_unavailable']).toContain('api-accounts.key');
    expect(dict['apiBalance.error.storage_unavailable']).toContain('.corrupt.*');
    expect(dict['apiBalance.error.storage_unavailable']).toContain('.unavailable');
    expect(dict['apiBalance.error.storage_unavailable']).toMatch(/do not clear|请勿直接清空/);
  });
});

describe('browser dual-mode copy', () => {
  it.each([
    ['en', en, 'Recently Visited'],
    ['zh', zh, '最近访问'],
    ['zh-TW', zhTW, '最近瀏覽'],
    ['ja', ja, '最近の閲覧'],
    ['ko', ko, '최근 방문'],
  ])('%s names browser history as recent visits', (_code, dict, expected) => {
    expect(dict['browser.history']).toBe(expected);
  });

  it.each([
    ['en', en, 'Connection'],
    ['zh', zh, '连接方式'],
    ['zh-TW', zhTW, '連線方式'],
    ['ja', ja, '接続方法'],
    ['ko', ko, '연결 방식'],
  ])('%s labels the mode selector as connection', (_code, dict, expected) => {
    expect(dict['browser.connectionMode']).toBe(expected);
  });

  it.each([
    ['en', en, 'phone', 'proxy', 'destroyed'],
    ['zh', zh, '手机', '代理', '销毁'],
    ['zh-TW', zhTW, '手機', '代理', '銷毀'],
    ['ja', ja, 'スマホ', 'プロキシ', '破棄'],
    ['ko', ko, '휴대폰', '프록시', '삭제'],
  ])('%s consent covers both paths without claiming direct sign-in is destroyed', (_code, dict, directWord, proxyWord, destroyedWord) => {
    const consent = [
      dict['browser.consentTitle'],
      dict['browser.consentBody'],
      dict['browser.consentComputer'],
      dict['browser.consentLimits'],
      dict['browser.consentIdle'],
    ].join(' ');
    expect(consent).toContain(directWord);
    expect(consent).toContain(proxyWord);
    expect(dict['browser.consentIdle']).not.toContain(destroyedWord);
    expect(dict['browser.proxyLimitHint']).toBeTruthy();
    expect(dict['browser.proxyUnavailable']).toContain('handmux setup');
    expect(dict['browser.openExternal']).toBeTruthy();
  });

  it.each([
    ['en', en, 'Web preview', 'not a full browser'],
    ['zh', zh, '网页预览器', '不是真正的浏览器'],
    ['zh-TW', zhTW, '網頁預覽器', '不是真正的瀏覽器'],
    ['ja', ja, 'ウェブプレビュー', '完全なブラウザではなく'],
    ['ko', ko, '웹 미리보기', '완전한 브라우저가 아니며'],
  ])('%s positions the feature as web preview', (_code, dict, featureName, boundary) => {
    expect(dict['app.browser']).toBe(featureName);
    expect(dict['browser.consentBody']).toContain(boundary);
    expect(dict['browser.openExternal']).toBeTruthy();
  });

  it.each([
    ['en', en], ['zh', zh], ['zh-TW', zhTW], ['ja', ja], ['ko', ko],
  ])('%s includes the complete device profile copy', (_code, dict) => {
    for (const key of [
      'settings.browserPersistLogin',
      'settings.browserPersistLoginHint',
      'settings.browserRetention',
      'browser.clearSiteLogin',
      'browser.clearAllLogin',
      'browser.clearSiteLoginConfirm',
      'browser.clearAllLoginConfirm',
      'browser.deleteHistoryEntry',
      'browser.profileSaveFailed',
      'browser.profileClearFailed',
      'browser.profileSyncFailed',
      'browser.profileRecoveryWarning',
    ]) {
      expect(dict[key], key).toBeTruthy();
    }
  });
});
