// Mermaid diagrams in the document viewer.
//
// A ```mermaid fence is kept in the DOM as a hidden <pre> (so the source is always recoverable and needs
// no attribute escaping) and gets a placeholder block after it. The placeholder is filled by lazily
// importing mermaid — the library is big, so it must never reach the initial bundle and must only load
// for a document that actually contains a diagram.
//
// Failure is honest: the source comes back and a note says why, rather than an empty box.
//
// mermaid renders SVG; `securityLevel: 'strict'` (mermaid's default, set explicitly) keeps its own
// sanitisation of labels and disables click handlers. The result is also marked data-tts-skip, so the
// read-aloud never walks SVG text, and find ignores it.
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { t } from './i18n';

const SOURCE_HIDDEN_CLASS = 'md-mermaid-source';

/** Mark mermaid fences: keep the source (hidden) and add the placeholder the loader fills. */
export function prepareMermaid(root: HTMLElement): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>('code.language-mermaid'))) {
    const pre = code.closest('pre');
    if (!pre || pre.dataset.mermaidSource !== undefined) continue;
    if (pre.nextElementSibling?.classList.contains('md-mermaid')) continue;
    pre.dataset.mermaidSource = '';
    pre.setAttribute('data-tts-skip', '');
    pre.classList.add(SOURCE_HIDDEN_CLASS);
    const block = document.createElement('div');
    block.className = 'md-mermaid is-loading';
    block.setAttribute('data-tts-skip', ''); // SVG text is a picture, not prose
    block.setAttribute('role', 'img');
    pre.after(block);
  }
}

/** The source of the diagram a placeholder belongs to (the hidden <pre> right before it). */
function sourceOf(block: HTMLElement): string {
  const pre = block.previousElementSibling;
  return pre?.querySelector('code')?.textContent ?? '';
}

function revealSource(block: HTMLElement, reason: string): void {
  const pre = block.previousElementSibling;
  if (pre instanceof HTMLElement) pre.classList.remove(SOURCE_HIDDEN_CLASS);
  block.remove();
  if (!(pre instanceof HTMLElement)) return;
  const note = document.createElement('div');
  note.className = 'md-mermaid-error';
  note.setAttribute('data-tts-skip', '');
  note.textContent = `${t('doc.mermaidFailed')}（${reason}）`;
  pre.after(note);
}

let diagramSeq = 0;

export function useDocMermaid(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
  enabled: boolean,
): void {
  const seq = useRef(0);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return undefined;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid'));
    if (!blocks.length) return undefined;
    let cancelled = false;

    void (async () => {
      let mermaid: typeof import('mermaid').default;
      try {
        mermaid = (await import('mermaid')).default;
      } catch {
        if (!cancelled) blocks.forEach((block) => revealSource(block, t('doc.mermaidLoadFailed')));
        return;
      }
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: 'inherit',
      });
      for (const block of blocks) {
        if (cancelled) return;
        const source = sourceOf(block);
        try {
          seq.current += 1;
          diagramSeq += 1;
          const { svg } = await mermaid.render(`handmux-mermaid-${diagramSeq}-${seq.current}`, source);
          if (cancelled) return;
          block.classList.remove('is-loading');
          block.innerHTML = svg;
        } catch (error) {
          if (cancelled) return;
          revealSource(block, error instanceof Error && error.message ? error.message : 'error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [html, enabled, rootRef]);
}
