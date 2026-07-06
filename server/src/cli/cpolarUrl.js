// cpolar is an ngrok-derived domestic tunnel. FREE tier → a random https://<sub>.cpolar.top (region variants
// like <sub>.r2.cpolar.top); a RESERVED second-level subdomain is still on the cpolar zone, so both are
// scraped from `-log=stdout` — scraping even in reserved mode is what lets us learn the region-qualified host
// cpolar actually serves. A BOUND custom domain is off-zone (won't scrape) and is known up front (→ publicUrl,
// gated on that host). Pure → unit-tested against captured log lines.
import { hostOf } from './urlHost.js';

const RE = /https?:\/\/[a-z0-9][a-z0-9.-]*\.cpolar\.(?:top|cn|io|com)/;

export function extractCpolarUrl(text) {
  const m = RE.exec(String(text || ''));
  return m ? m[0] : null;
}

// The cpolar CLI flag for a fixed domain, derived from its host: a cpolar-owned zone → -subdomain=<label>
// (cpolar reserves you the leftmost label; the region prefix, if any, is handled by cpolar itself), anything
// else → -hostname=<host> (you bound your own domain). Empty when no fixed domain (free tier).
export function cpolarNamedArgs(publicUrl) {
  const host = hostOf(publicUrl);
  if (!host) return [];
  if (/\.cpolar\.(?:top|cn|io|com)$/i.test(host)) return [`-subdomain=${host.split('.')[0]}`];
  return [`-hostname=${host}`];
}
