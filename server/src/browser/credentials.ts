import type { IncomingHttpHeaders } from 'node:http';
import { Transform } from 'node:stream';

export const BROWSER_DEVICE_COOKIE = 'tw_browser_device';
export function browserCookie(raw: unknown): string | null {
  const cookies = String(raw || '').split(';').map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(`${BROWSER_DEVICE_COOKIE}=`));
  return matches.length === 1 ? matches[0]!.slice(BROWSER_DEVICE_COOKIE.length + 1) : null;
}
function mainCookie(name: string): boolean {
  return /^(?:__Host-)?handmux_/i.test(name);
}
export function stripMainCookies(headers: IncomingHttpHeaders, stripBrowser = false): IncomingHttpHeaders {
  const out = { ...headers };
  if (out.cookie) {
    out.cookie = out.cookie.split(';').map((part) => part.trim()).filter((part) => {
      const name = part.split('=', 1)[0] || '';
      return !mainCookie(name) && (!stripBrowser || !['tw_preview', BROWSER_DEVICE_COOKIE].includes(name));
    }).join('; ');
    if (!out.cookie) delete out.cookie;
  }
  return out;
}
export function stripForgedCookies(headers: IncomingHttpHeaders, stripBrowser = false): IncomingHttpHeaders {
  const out = { ...headers };
  if (out['set-cookie']) {
    out['set-cookie'] = out['set-cookie'].filter((value) => {
      const name = value.split('=', 1)[0]?.trim() || '';
      return !mainCookie(name) && (!stripBrowser || !['tw_preview', BROWSER_DEVICE_COOKIE].includes(name));
    });
    if (!out['set-cookie'].length) delete out['set-cookie'];
  }
  return out;
}

// The raw WebSocket tunnel must enforce the same Set-Cookie boundary as HTTP responses.
export function createBrowserUpgradeFilter(): Transform {
  let pending = Buffer.alloc(0);
  let complete = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (complete) { callback(null, chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) {
        if (pending.length > 64 * 1024) callback(new Error('browser upgrade headers too large'));
        else callback();
        return;
      }
      const lines = pending.subarray(0, end).toString('latin1').split('\r\n');
      const safe = lines.filter((line) => {
        if (!/^set-cookie\s*:/i.test(line)) return true;
        const value = line.slice(line.indexOf(':') + 1).trim();
        return Boolean(stripForgedCookies({ 'set-cookie': [value] }, true)['set-cookie']?.length);
      });
      complete = true;
      this.push(Buffer.from(`${safe.join('\r\n')}\r\n\r\n`, 'latin1'));
      this.push(pending.subarray(end + 4));
      pending = Buffer.alloc(0);
      callback();
    },
  });
}
