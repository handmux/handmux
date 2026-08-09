// Pure: detect a named cloudflared tunnel reaching a live edge connection. The hostname is known up front
// (https://<cf-hostname>), so unlike quick-tunnel we don't scrape a URL — we just gate on cloudflared
// logging a registered connection, so the QR isn't shown before the edge is reachable.
const RE = /Registered tunnel connection/;
export function cfNamedReady(text: unknown): boolean { return RE.test(String(text || '')); }
