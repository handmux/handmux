// Tiny URL helpers shared by the ngrok-family tunnels (natapp / cpolar). A *named* tunnel knows its public
// host up front, so instead of scraping a random URL we gate readiness on the tunnel process echoing that
// exact host in its own log — and cpolar derives its -subdomain/-hostname flag from the same host. Pure.
export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return null; }
}

// Has the process output mentioned this URL's host yet? (i.e. the named tunnel is up on its known domain.)
export function hostIn(text, url) {
  const h = hostOf(url);
  return !!h && String(text || '').includes(h);
}
