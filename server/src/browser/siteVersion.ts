export type BrowserSiteVersion = 'mobile' | 'desktop';
export interface BrowserSiteIdentity {
  version: BrowserSiteVersion;
  mobile: boolean;
  userAgent: string;
  appVersion: string;
  platform: string;
  clientHintPlatform: string;
  maxTouchPoints: number;
}
type MutableHeaders = Record<string, string | string[] | number | undefined>;

export const DEFAULT_SITE_VERSION: BrowserSiteVersion = 'mobile';
export const SITE_VERSIONS = new Set<BrowserSiteVersion>(['mobile', 'desktop']);

export function normalizeSiteVersion(
  value: unknown,
  fallback: BrowserSiteVersion = DEFAULT_SITE_VERSION,
): BrowserSiteVersion | null {
  if (value == null || value === '') return fallback;
  return typeof value === 'string' && SITE_VERSIONS.has(value as BrowserSiteVersion)
    ? value as BrowserSiteVersion : null;
}

function versionFrom(ua: string, pattern: RegExp, fallback = '120.0.0.0'): string {
  return ua.match(pattern)?.[1] || fallback;
}

function identityPlatform(ua: string, mobile: boolean): { navigator: string; clientHint: string } {
  if (/iPhone|iPad|iPod/i.test(ua)) return { navigator: 'iPhone', clientHint: 'iOS' };
  if (/Android/i.test(ua)) return { navigator: 'Linux armv8l', clientHint: 'Android' };
  if (/Windows/i.test(ua)) return { navigator: 'Win32', clientHint: 'Windows' };
  if (/Macintosh|Mac OS X/i.test(ua)) return { navigator: 'MacIntel', clientHint: 'macOS' };
  return mobile
    ? { navigator: 'Linux armv8l', clientHint: 'Android' }
    : { navigator: 'Linux x86_64', clientHint: 'Linux' };
}

function isMobileUserAgent(ua: string): boolean {
  return /Android|Mobile|iPhone|iPad|iPod/i.test(ua);
}

function transformedUserAgent(source: unknown, mobile: boolean): string {
  const ua = String(source || '');
  if (ua && isMobileUserAgent(ua) === mobile) return ua;

  const webkit = versionFrom(ua, /AppleWebKit\/([\d.]+)/i, '605.1.15');
  const safari = versionFrom(ua, /Version\/([\d.]+)/i, '18.0');
  if (/Safari\//i.test(ua) && !/(?:Chrome|CriOS|Chromium|Edg|OPR)\//i.test(ua)) {
    return mobile
      ? `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/${webkit} (KHTML, like Gecko) Version/${safari} Mobile/15E148 Safari/${webkit}`
      : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${webkit} (KHTML, like Gecko) Version/${safari} Safari/${webkit}`;
  }

  const firefox = ua.match(/Firefox\/([\d.]+)/i)?.[1];
  if (firefox) {
    return mobile
      ? `Mozilla/5.0 (Android 10; Mobile; rv:${firefox}) Gecko/${firefox} Firefox/${firefox}`
      : `Mozilla/5.0 (X11; Linux x86_64; rv:${firefox}) Gecko/20100101 Firefox/${firefox}`;
  }

  const chrome = versionFrom(ua, /(?:Chrome|CriOS|Chromium|Edg|OPR)\/([\d.]+)/i);
  return mobile
    ? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

export function siteVersionIdentity(siteVersion: unknown, sourceUserAgent: unknown = ''): BrowserSiteIdentity {
  const version = normalizeSiteVersion(siteVersion);
  if (!version) throw new Error('invalid browser site version');
  const mobile = version === 'mobile';
  const userAgent = transformedUserAgent(sourceUserAgent, mobile);
  const platform = identityPlatform(userAgent, mobile);
  return {
    version,
    mobile,
    userAgent,
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    platform: platform.navigator,
    clientHintPlatform: platform.clientHint,
    maxTouchPoints: mobile ? 5 : 0,
  };
}

function headerKey(headers: MutableHeaders, name: string): string {
  const lower = name.toLowerCase();
  return Object.keys(headers || {}).find((key) => key.toLowerCase() === lower) || lower;
}

function setHeader(headers: MutableHeaders, name: string, value: string): void {
  headers[headerKey(headers, name)] = value;
}

function deleteHeader(headers: MutableHeaders, name: string): void {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (key) delete headers[key];
}

export function applySiteVersionHeaders<T extends MutableHeaders>(
  headers: T,
  identity: BrowserSiteIdentity | null | undefined,
): T {
  if (!headers || !identity) return headers;
  setHeader(headers, 'user-agent', identity.userAgent);
  setHeader(headers, 'sec-ch-ua-mobile', identity.mobile ? '?1' : '?0');
  setHeader(headers, 'sec-ch-ua-platform', `"${identity.clientHintPlatform}"`);
  for (const name of [
    'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
    'sec-ch-ua-model', 'sec-ch-ua-wow64', 'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
  ]) deleteHeader(headers, name);
  return headers;
}

export function siteVersionNavigatorScript(identity: BrowserSiteIdentity): string {
  const encoded = JSON.stringify(identity).replaceAll('<', '\\u003c');
  return `(() => {
    const profile = ${encoded};
    const define = (name, value) => {
      try { Object.defineProperty(navigator, name, { configurable: true, get: () => value }); }
      catch { /* the native value remains available */ }
    };
    define('userAgent', profile.userAgent);
    define('appVersion', profile.appVersion);
    define('platform', profile.platform);
    define('maxTouchPoints', profile.maxTouchPoints);
    const nativeData = navigator.userAgentData;
    if (nativeData) {
      const data = {
        brands: nativeData.brands || [],
        mobile: profile.mobile,
        platform: profile.clientHintPlatform,
        toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
        async getHighEntropyValues(hints) {
          let values = {};
          try { values = await nativeData.getHighEntropyValues.call(nativeData, hints); } catch { /* optional API */ }
          return { ...values, mobile: profile.mobile, platform: profile.clientHintPlatform };
        },
      };
      define('userAgentData', data);
    }
  })();`;
}
