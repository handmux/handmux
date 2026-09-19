// One-tap copy for code blocks. Each rendered <pre> gets a small copy control pinned to its top-right;
// tapping it copies that block's plain text (what the reader sees — no gutter, no line numbers) and
// briefly swaps the icon for a check mark.
//
// Buttons are added in a DOM pass after render (same pattern as the inline-image loader) because the
// markdown HTML is injected wholesale, and they are absolutely positioned so the code text cannot
// reflow. A tap on a button bubbles into the document's tap-to-read handler, which only reacts to
// sentence spans, but the handler stops propagation anyway to keep the two features independent.
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { copyText } from '../clipboard.js';
import { t } from '../i18n';

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

export function useDocCodeCopy(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
  enabled: boolean,
): void {
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return undefined;
    const blocks = Array.from(root.querySelectorAll<HTMLPreElement>('pre'));
    const buttons: HTMLButtonElement[] = [];
    blocks.forEach((pre) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doc-code-copy';
      button.setAttribute('aria-label', t('doc.copyCode'));
      button.title = t('doc.copyCode');
      button.innerHTML = COPY_ICON;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyText(pre.textContent || '').then((ok) => {
          if (!ok) return;
          button.innerHTML = COPIED_ICON;
          button.classList.add('is-copied');
          if (resetTimer.current !== null) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            button.innerHTML = COPY_ICON;
            button.classList.remove('is-copied');
          }, 1600);
        });
      });
      pre.appendChild(button);
      buttons.push(button);
    });
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      buttons.forEach((button) => button.remove());
    };
  }, [html, enabled, rootRef]);
}
