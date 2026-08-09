// Sentence helpers for document TTS (read-aloud). Two pieces:
//   splitSentences(text)  — pure string → sentence[]; used by tests and as the fallback.
//   markSentences(rootEl) — wrap each sentence in the rendered Markdown DOM in a <span.tts-sent
//                           data-tts="i"> (preserving inline markup), and return the sentence texts.
// We read one sentence per utterance (see useDocSpeech), so these define the unit of both speech
// and highlight.

// One regex segment = text up to AND INCLUDING the next terminator run, or end-of-input. CJK
// terminators (。！？…) always end a sentence; ASCII .!? only when followed by whitespace/end, so
// "3.14" and "v1.2" don't split. `.` here never matches a newline (no s flag), so line breaks fall
// through to the trailing `$`/boundary and start a fresh sentence too.
const SEG_RE = /[^\n]*?(?:[。！？…]+|[.!?]+(?=\s|$)|\n+|$)/gu;
// Does a segment already end at a sentence terminator (vs. just running out of text node)?
const ENDS_SENTENCE = /[。！？…]$|[.!?]$/;

// Split prose into sentences. Terminators stay attached; whitespace is collapsed; blanks dropped.
export function splitSentences(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(SEG_RE)) {
    const s = m[0].replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

// True if any ancestor up to (not including) root is a tag whose text we must NOT read/wrap.
function inSkippedBlock(node: Node, root: HTMLElement): boolean {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    const t = p.nodeName;
    if (t === 'PRE' || t === 'SCRIPT' || t === 'STYLE' || t === 'CODE') return true;
  }
  return false;
}

// Walk the rendered DOM, wrapping each sentence run in <span.tts-sent data-tts="i">. A sentence may
// span multiple text nodes (e.g. across <strong>/<a>); we keep a running index that only advances on
// a terminator, so every span of one sentence shares its index. Idempotent: if already marked, we
// just re-read the existing spans. Returns the sentence texts, densely indexed to match data-tts.
export function markSentences(root: HTMLElement | null): string[] {
  if (!root) return [];
  if (root.querySelector('span.tts-sent')) return readMarked(root);

  // Collect first (we'll replace nodes as we go, which would disturb a live TreeWalker).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) =>
      node.nodeValue && node.nodeValue.trim() && !inSkippedBlock(node, root)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) nodes.push(walker.currentNode);
  }

  const provisional: string[] = [];
  const spansByIdx: HTMLSpanElement[][] = [];
  let cur = 0;
  for (const node of nodes) {
    const frag = node.ownerDocument.createDocumentFragment();
    const nodeValue = node.nodeValue || '';
    for (const m of nodeValue.matchAll(SEG_RE)) {
      const text = m[0];
      if (text === '') continue;
      const span = node.ownerDocument.createElement('span');
      span.className = 'tts-sent';
      span.textContent = text;
      frag.appendChild(span);
      (spansByIdx[cur] ||= []).push(span);
      provisional[cur] = (provisional[cur] || '') + text;
      if (ENDS_SENTENCE.test(text)) cur++;
    }
    node.parentNode?.replaceChild(frag, node);
  }

  // Drop whitespace-only provisional sentences and renumber the rest densely so data-tts indices
  // line up with the returned array (the speech queue indexes into it).
  const result: string[] = [];
  provisional.forEach((txt, provIdx) => {
    const t = (txt || '').replace(/\s+/g, ' ').trim();
    if (!t) return; // its spans stay untagged → never highlighted/spoken
    const finalIdx = result.length;
    result.push(t);
    for (const span of spansByIdx[provIdx] || []) span.dataset.tts = String(finalIdx);
  });
  return result;
}

// Rebuild the sentence list from already-wrapped spans (idempotent re-entry).
function readMarked(root: HTMLElement): string[] {
  const acc: string[] = [];
  root.querySelectorAll<HTMLSpanElement>('span.tts-sent[data-tts]').forEach((span) => {
    const i = Number(span.dataset.tts);
    acc[i] = (acc[i] || '') + (span.textContent || '');
  });
  return acc.map((t) => (t || '').replace(/\s+/g, ' ').trim());
}
