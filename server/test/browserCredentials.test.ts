import { describe, expect, it } from 'vitest';
import { browserCookie, createBrowserUpgradeFilter, stripMainCookies, stripForgedCookies } from '../src/browser/credentials.js';

describe('browser credential boundary', () => {
  it('strips main session/candidate credentials in both transport modes without stripping website cookies', () => {
    const cookies = ['__Host-handmux_session=s', 'handmux_session_http=s', '__Host-handmux_pairing=p', 'handmux_pairing_http=p',
      '__Host-handmux_pairing_0123456789abcdef0123456789abcdef=p', 'handmux_pairing_http_0123456789abcdef0123456789abcdef=p'];
    expect(stripMainCookies({ cookie: `${cookies.join('; ')}; website=ok; tw_browser_device=cap` }, true).cookie).toBe('website=ok');
    expect(stripForgedCookies({ 'set-cookie': [...cookies, 'tw_browser_device=forged', 'website=ok'] }, true)['set-cookie']).toEqual(['website=ok']);
    expect(browserCookie('tw_browser_device=a; tw_browser_device=b')).toBeNull();
  });

  it('filters split raw upgrade headers and preserves websocket frame bytes', async () => {
    const filter = createBrowserUpgradeFilter();
    const chunks: Buffer[] = [];
    filter.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => filter.once('end', resolve));
    filter.write(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nSet-Coo'));
    filter.write(Buffer.from('kie: handmux_pairing_http=forged\r\nSet-Cookie: website=ok\r\nUpgrade: websocket\r\n\r\n'));
    filter.end(Buffer.from([0x81, 0x01, 0x01]));
    await ended;
    const output = Buffer.concat(chunks);
    expect(output.toString('latin1')).not.toContain('handmux_pairing');
    expect(output.toString('latin1')).toContain('Set-Cookie: website=ok');
    expect(output.subarray(-3)).toEqual(Buffer.from([0x81, 0x01, 0x01]));
  });
});
