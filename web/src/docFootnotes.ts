import { t } from './i18n';
// GFM footnotes, minimally.
//
// marked 12 has no footnote support and its link-reference handling makes `[^1]` worse than unsupported:
// with a definition present it renders `[^1]` as a LINK to the definition text and drops the definition
// line entirely (verified against marked 12). So the definitions are lifted OUT before parsing and
// re-attached after sanitizing:
//
//   stripFootnoteDefs(source)  — removes `[^id]: text` lines, returns them in document order
//   applyFootnotes(root, notes) — turns each literal `[^x]` reference into a superscript link and
//                                 appends the notes list with back-links
//
// Deliberately simple: single-line definitions, one reference per note, and code blocks / inline code
// are left alone (a `[^1]` inside code is code, not a reference).
export interface FootnoteDef {
  id: string;
  text: string;
}

const DEF_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const REF_RE = /\[\^([^\]\s]+)\]/g;

/** Lift `[^id]: …` definition lines out of the source (they must not reach marked). */
export function stripFootnoteDefs(source: string): { source: string; notes: FootnoteDef[] } {
  const notes: FootnoteDef[] = [];
  const kept: string[] = [];
  for (const line of source.split('\n')) {
    const match = DEF_RE.exec(line);
    if (!match) { kept.push(line); continue; }
    notes.push({ id: match[1] ?? '', text: (match[2] ?? '').trim() });
  }
  return { source: kept.join('\n'), notes };
}

const inCode = (node: Node, root: HTMLElement): boolean => {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    const tag = (p as Element).nodeName;
    if (tag === 'PRE' || tag === 'CODE') return true;
  }
  return false;
};

/** Replace literal `[^id]` references and append the notes list. No-op when there are no definitions. */
export function applyFootnotes(root: HTMLElement, notes: readonly FootnoteDef[]): void {
  if (!notes.length) return;
  const index = new Map(notes.map((note, i) => [note.id, i + 1]));

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue && node.nodeValue.includes('[^') && !inCode(node, root)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  const used = new Set<string>();
  for (const node of nodes) {
    const text = node.nodeValue || '';
    REF_RE.lastIndex = 0;
    let match = REF_RE.exec(text);
    if (!match) continue;
    const frag = document.createDocumentFragment();
    let offset = 0;
    while (match) {
      const id = match[1] ?? '';
      const number = index.get(id);
      if (number) {
        frag.append(document.createTextNode(text.slice(offset, match.index)));
        const sup = document.createElement('sup');
        sup.className = 'md-fn-ref';
        const link = document.createElement('a');
        link.id = `fnref-${id}`;
        link.href = `#fn-${id}`;
        link.textContent = String(number);
        sup.append(link);
        frag.append(sup);
        used.add(id);
        offset = match.index + match[0].length;
      }
      match = REF_RE.exec(text);
    }
    frag.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(frag);
  }

  // Only notes that were actually referenced get a list entry, renumbered to match the references.
  const list = notes.filter((note) => used.has(note.id));
  if (!list.length) return;
  const section = document.createElement('section');
  section.className = 'md-footnotes';
  const heading = document.createElement('div');
  heading.className = 'md-footnotes-title';
  heading.textContent = t('doc.footnotes');
  section.append(heading);
  const ol = document.createElement('ol');
  for (const note of list) {
    const li = document.createElement('li');
    li.id = `fn-${note.id}`;
    li.append(document.createTextNode(note.text + ' '));
    const back = document.createElement('a');
    back.className = 'md-fn-back';
    back.href = `#fnref-${note.id}`;
    back.textContent = '↩';
    li.append(back);
    ol.append(li);
  }
  section.append(ol);
  root.append(section);
}
