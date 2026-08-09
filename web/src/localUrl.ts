// Detect HTTP(S) URLs printed in the terminal so every computer-reachable site can open in the
// built-in browser after the existing anti-mistap confirmation.
import { DELIMS } from './docPath.js';

const HOST = '(?:\\[[0-9a-f:]+\\]|[a-z0-9.-]+)';
// http(s)://<host>(:port)?(<path/query/hash>)? — the suffix runs to the same delimiter set doc-paths
// use, so a URL sitting in Chinese prose / brackets ends where the eye says it does. A query or hash
// may legally start immediately after the host without an explicit slash.
const LOCAL_URL_RE = new RegExp(`https?://${HOST}(?::(\\d{1,5}))?([/?#][^${DELIMS}]*)?`, 'gi');

export interface LocalUrlLink {
  start: number;
  end: number;
  protocol: 'http' | 'https';
  port: number;
  path: string;
  raw: string;
}

// Find every HTTP(S) URL in one line of text → [{ start, end, protocol, port, path, raw }] (end exclusive).
// Protocol/port/path stay in the payload for compatibility; Browser opens the exact `raw` URL.
//   - raw: the exact matched substring (trailing prose dots stripped), for the confirm popover's label.
export function findLocalUrls(line: string): LocalUrlLink[] {
  const out: LocalUrlLink[] = [];
  if (!line) return out;
  LOCAL_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_URL_RE.exec(line)) !== null) {
    const isHttps = /^https:/i.test(m[0]);
    const port = m[1] ? Number(m[1]) : (isHttps ? 443 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    // A trailing '.' clings from prose ("…visit https://example.com/foo.") — it's a sentence stop, not
    // part of the URL suffix. Strip trailing dots and shrink the end offset.
    const rawPath = m[2] || '';
    const path = rawPath.replace(/\.+$/, '');
    const end = m.index + m[0].length - (rawPath.length - path.length);
    out.push({ start: m.index, end, protocol: isHttps ? 'https' : 'http', port, path: path || '/', raw: line.slice(m.index, end) });
  }
  return out;
}
