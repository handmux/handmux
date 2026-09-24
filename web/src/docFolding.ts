// Collapsible sections in the DOCUMENT BODY (doc mode only).
//
// Every section heading gets a caret; tapping it hides that heading's content up to the next heading of
// the same or higher level — so folding an h1 takes its h2/h3 along, exactly like the outline drawer.
// The first h1 is the document title, not a section, so it always stays expanded and has no caret.
//
// Done as a DOM pass plus one delegated listener on the document root (the same shape as the inline
// image loader and the code-block copy buttons): the markdown HTML is injected wholesale, so React does
// not own these nodes.
//
// Visibility is RECOMPUTED from the headings' own `.is-folded` flags rather than toggled per sibling:
// that way folding a parent and unfolding it again leaves a previously folded child folded, and the
// caret of a nested heading keeps telling the truth.
//
// Collapsed content is deliberately invisible to BOTH read-aloud and find — a folded section is not what
// the reader is looking at (see docSpeech.inSkippedBlock / docFind.textNodes).
import { t } from './i18n';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const HIDDEN_CLASS = 'md-section-hidden';
const FOLDED_CLASS = 'is-folded';

const levelOf = (el: Element): number => (
  el.nodeName.length === 2 && el.nodeName[0] === 'H' ? Number(el.nodeName[1]) : 0
);
const isHeading = (el: Element): boolean => levelOf(el) > 0;

/**
 * Recompute which blocks are hidden from the headings' folded flags.
 *
 * Headings are NEVER hidden: folding a section hides its content, and the sub-headings inside it stay on
 * screen as the structure you are folding around (each keeps its own caret and its own folded state).
 */
function applyFolding(root: HTMLElement): void {
  const folded: number[] = []; // levels of the headings currently folded, outermost first
  for (const el of Array.from(root.children)) {
    if (isHeading(el)) {
      const level = levelOf(el);
      while (folded.length && (folded[folded.length - 1] ?? 0) >= level) folded.pop();
      el.classList.remove(HIDDEN_CLASS); // a heading line is always visible
      if (el.classList.contains(FOLDED_CLASS)) folded.push(level);
    } else {
      el.classList.toggle(HIDDEN_CLASS, folded.length > 0);
    }
  }
}

/** Add carets to section headings and wire the toggle. Returns a cleanup function. */
export function installHeadingFolding(root: HTMLElement): () => void {
  const documentTitle = root.querySelector<HTMLElement>('h1');
  documentTitle?.classList.add('md-document-title');
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR))) {
    if (heading === documentTitle) {
      heading.querySelector(':scope > .md-fold')?.remove();
      heading.classList.remove(FOLDED_CLASS);
      continue;
    }
    if (heading.querySelector(':scope > .md-fold')) continue; // already installed
    const caret = document.createElement('span');
    caret.className = 'md-fold';
    caret.setAttribute('role', 'button');
    caret.setAttribute('tabindex', '0');
    caret.setAttribute('aria-label', t('doc.tocCollapse'));
    heading.prepend(caret);
  }

  const activate = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const caret = target?.closest('.md-fold');
    const heading = caret?.closest<HTMLElement>(HEADING_SELECTOR);
    if (!caret || !heading) return;
    event.preventDefault();
    event.stopPropagation(); // never fall through to tap-to-read, anchors or image taps
    const folded = !heading.classList.contains(FOLDED_CLASS);
    heading.classList.toggle(FOLDED_CLASS, folded);
    caret.setAttribute('aria-label', folded ? t('doc.tocExpand') : t('doc.tocCollapse'));
    applyFolding(root);
  };

  const onClick = (event: Event): void => activate(event);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') activate(event);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeyDown);
  };
}
