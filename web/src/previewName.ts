// web/src/previewName.js
// Derive a filesystem-safe single-segment preview name from the current tmux session-window. The
// server re-validates with safePreviewName; this just produces something that passes it and is
// unique per window (the window id is ascii — '@3' → '3' — so the name is never empty/colliding).
export interface PreviewNameParts {
  session?: string | null;
  windowName?: string | null;
  windowId?: string | null;
}

export function previewSlug(value: unknown): string {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-') // non-safe runs → one dash
    .replace(/-{2,}/g, '-')            // collapse repeats
    .replace(/^[-.]+|-+$/g, '')        // trim leading dashes/dots and trailing dashes
    .toLowerCase();                    // canonical registry spelling
                                       // (browsers lowercase the host); keep it consistent for static too
}

export function previewName({ session, windowName, windowId }: PreviewNameParts): string {
  const parts = [session, windowName].map(previewSlug).filter(Boolean);
  parts.push(previewSlug(windowId) || 'w');
  return parts.join('-');
}
