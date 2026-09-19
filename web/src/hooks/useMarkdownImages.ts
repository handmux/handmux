// Fill the <img data-handmux-src> placeholders that renderMarkdown left in a sanitized markdown
// document: each becomes an authenticated blob URL (markdownImageCache → fetchImageUrl), and a tap
// opens the fullscreen ImageViewer. Failure paths replace the placeholder in place with a note
// naming the real cause (HIG: errors say why and what next — never a bare broken image).
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { acquireImage, loadImage, releaseImage } from '../markdownImageCache.js';
import { t } from '../i18n';

export interface MarkdownImageView {
  url: string;
  name: string;
}

const reasonFor = (cause: unknown, decodeFailure: boolean): string => {
  if (decodeFailure) return t('doc.imageNotImage');
  const message = cause instanceof Error ? cause.message : '';
  if (/-> 404/.test(message)) return t('doc.imageNotFound');
  if (/-> 413/.test(message)) return t('doc.imageTooLarge');
  return t('doc.imageLoadFailed');
};

// The loader works with REAL paths, so a name is already plain text — but a file may legitimately
// contain a `%` (e.g. `100%.png`), where a second decode would throw or mangle it. Decode leniently.
const fileName = (path: string): string => {
  const base = path.split('/').pop() || path;
  try { return decodeURIComponent(base); } catch { return base; }
};

export function useMarkdownImages(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
  enabled: boolean,
): [MarkdownImageView | null, () => void] {
  const [view, setView] = useState<MarkdownImageView | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;
    const acquired = new Set<string>();

    const failNote = (img: HTMLImageElement, cause: unknown, decodeFailure = false): void => {
      const note = document.createElement('span');
      note.className = 'md-img-note';
      note.setAttribute('data-tts-skip', ''); // interface chrome — never read aloud
      const alt = img.getAttribute('alt') || '';
      const reason = reasonFor(cause, decodeFailure);
      note.textContent = alt ? `${alt} — ${reason}` : reason;
      img.replaceWith(note);
    };

    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-handmux-src]'))) {
      const path = img.getAttribute('data-handmux-src') || '';
      if (!path) continue;
      const name = fileName(path);
      // A blob that decodes fine but then fails was revoked or isn't an image at all.
      img.addEventListener('error', () => { if (!cancelled) failNote(img, null, true); });
      const hit = acquireImage(path);
      if (hit) {
        // Cached (or 304): assign straight away — an image without `src` is what the CSS paints as
        // "loading", so this removes the placeholder in the same commit (no flash).
        img.src = hit.url;
        continue;
      }
      loadImage(path).then(() => {
        if (cancelled) { releaseImage(path); return; }
        const entry = acquireImage(path);
        if (!entry) { failNote(img, null); return; }
        acquired.add(path);
        img.src = entry.url;
      }).catch((cause: unknown) => {
        if (!cancelled) failNote(img, cause);
      });
    }

    const onClick = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null;
      const img = target?.closest?.('img[data-handmux-src]') as HTMLImageElement | null;
      if (img?.src) setView({ url: img.src, name: fileName(img.getAttribute('data-handmux-src') || '') });
    };
    root.addEventListener('click', onClick);
    return () => {
      cancelled = true;
      root.removeEventListener('click', onClick);
      for (const path of acquired) releaseImage(path);
    };
  }, [html, enabled, rootRef]);

  return [view, () => setView(null)];
}
