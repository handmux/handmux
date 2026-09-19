// In-document find (single document only). Every match is wrapped in its own <mark class="doc-find-hit">
// — DOM wrapping rather than the CSS Custom Highlight API, so the current match can carry extra UI and
// so the behaviour is testable; it also nests safely inside the read-aloud's <span.tts-sent> markers
// (those own the data-tts indices, so clearing find ONLY unwraps our own marks and never touches them).
//
// The mark class must never collide with the toolbar's search-row class (`.doc-find`): each mark is an
// INLINE element, and a class shared with a flex row blockified every match — each hit landed on its own
// full-width line (a device-only symptom, since jsdom has no layout).
const MARK_CLASS = 'doc-find-hit';
const CURRENT_CLASS = 'is-current';
// A pathological query ("a") on a big document would otherwise wrap tens of thousands of nodes.
const MAX_MATCHES = 500;

function isFindable(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  const tag = parent.nodeName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return false;
  if (!node.nodeValue || node.nodeValue.length === 0) return false;
  // Folded-away sections are not searchable: the reader cannot see the match to act on it.
  for (let p: Element | null = parent; p; p = p.parentElement) {
    if (p.classList.contains('md-section-hidden')) return false;
    if (p.classList.contains('md-mermaid') || p.classList.contains('md-mermaid-source')) return false;
  }
  return true;
}

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node instanceof Text && isFindable(node)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/** Remove every find mark and put the text back together (merges the split text nodes). */
export function clearFind(root: HTMLElement | null): void {
  if (!root) return;
  const marks = Array.from(root.querySelectorAll(`mark.${MARK_CLASS}`));
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    mark.replaceWith(...Array.from(mark.childNodes)); // keeps any nested <span.tts-sent> alive
    parents.add(parent);
  }
  for (const parent of parents) {
    if (parent instanceof HTMLElement) parent.normalize();
  }
}

/** Wrap every occurrence of `query` (case-insensitive) and return the match count. */
export function runFind(root: HTMLElement | null, query: string): number {
  if (!root) return 0;
  clearFind(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (const node of textNodes(root)) {
    const text = node.nodeValue || '';
    const haystack = text.toLowerCase();
    let from = 0;
    let at = haystack.indexOf(needle, from);
    if (at < 0) continue;
    const frag = document.createDocumentFragment();
    while (at >= 0 && count < MAX_MATCHES) {
      if (at > from) frag.append(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      mark.dataset.find = String(count);
      mark.textContent = text.slice(at, at + needle.length);
      frag.append(mark);
      count += 1;
      from = at + needle.length;
      at = count < MAX_MATCHES ? haystack.indexOf(needle, from) : -1;
    }
    frag.append(document.createTextNode(text.slice(from)));
    node.parentNode?.replaceChild(frag, node);
  }
  return count;
}

/** Highlight match `index` as the current one. Returns it so the caller can scroll its OWN container
 *  (see DocView.scrollToElement — scrollIntoView would also scroll ancestor scrollers, which pans the
 *  fixed file sheet away and takes the toolbar with it). */
export function focusMatch(root: HTMLElement | null, index: number): HTMLElement | null {
  if (!root) return null;
  const marks = Array.from(root.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}`));
  marks.forEach((mark) => mark.classList.remove(CURRENT_CLASS));
  const target = marks[index];
  if (!target) return null;
  target.classList.add(CURRENT_CLASS);
  return target;
}
