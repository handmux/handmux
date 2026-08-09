// Defense-in-depth for records written by older servers: never place a non-web scheme in an anchor.
// Relative URLs are intentional (they can open another authenticated handmux route on the same origin).
export function sanitizeNotificationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return raw;
  } catch {
    return null;
  }
}
