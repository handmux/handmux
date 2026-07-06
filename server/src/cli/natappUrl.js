// natapp is an ngrok-derived domestic tunnel. On the FREE tier it hands out a random http(s)://<sub>.natappfree.cc
// each run, printed in natapp's `-log=stdout` output — scrape it exactly like the cloudflare quick tunnel.
// A reserved/paid domain (e.g. *.natapp1.cc or your own) is bound to the authtoken server-side and known up
// front (→ publicUrl, gated on that host appearing), so scraping is only ever for the free zone. Pure →
// unit-tested against captured log lines.
const RE = /https?:\/\/[a-z0-9][a-z0-9-]*\.natappfree\.cc/;

export function extractNatappUrl(text) {
  const m = RE.exec(String(text || ''));
  return m ? m[0] : null;
}
