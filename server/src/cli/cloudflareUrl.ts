// Pure: pull the first https://<sub>.trycloudflare.com out of a cloudflared log chunk. The quick-tunnel
// hostname is random per run, so scraping it from cloudflared's startup log is how the supervisor learns
// the public URL. Kept tiny + side-effect-free so it unit-tests against real captured log lines.
const RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

export function extractCloudflareUrl(text: unknown): string | null {
  const m = RE.exec(String(text || ''));
  return m ? m[0] : null;
}
