// Notification links are user-supplied by `handmux push --url`. Keep relative in-app links, but reject
// executable/non-web schemes (javascript:, data:, file:, …) before they reach storage or an <a href>.
export function sanitizeNotificationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, 'https://handmux.invalid/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return raw;
  } catch {
    return null;
  }
}
