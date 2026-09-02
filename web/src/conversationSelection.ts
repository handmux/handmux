export interface TextOffsetRange {
  start: number;
  end: number;
}

interface TextEntry {
  node: Text;
  start: number;
  end: number;
}

export interface ConversationTextMap {
  text: string;
  entries: TextEntry[];
}

const invisibleText = (node: Text, root: HTMLElement): boolean => {
  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) return true;
  return !!parent.closest('[aria-hidden="true"], .chat-copy-ignore');
};

export function conversationTextMap(root: HTMLElement): ConversationTextMap {
  const entries: TextEntry[] = [];
  let text = '';
  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter ?? NodeFilter;
  const walker = root.ownerDocument.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return invisibleText(node as Text, root)
        ? nodeFilter.FILTER_REJECT : nodeFilter.FILTER_ACCEPT;
    },
  });
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    const value = node.data;
    if (!value) continue;
    const start = text.length;
    text += value;
    entries.push({ node, start, end: text.length });
  }
  return { text, entries };
}

export function normalizedOffsetRange(
  anchorOffset: number,
  draggedOffset: number,
  textLength: number,
): TextOffsetRange | null {
  if (textLength <= 0) return null;
  const anchor = Math.max(0, Math.min(textLength, anchorOffset));
  const dragged = Math.max(0, Math.min(textLength, draggedOffset));
  if (anchor === dragged) {
    return dragged >= textLength
      ? { start: textLength - 1, end: textLength }
      : { start: dragged, end: dragged + 1 };
  }
  return { start: Math.min(anchor, dragged), end: Math.max(anchor, dragged) };
}

function pointAt(map: ConversationTextMap, rawOffset: number): { node: Text; offset: number } | null {
  if (!map.entries.length) return null;
  const offset = Math.max(0, Math.min(map.text.length, rawOffset));
  const entry = map.entries.find((candidate) => offset < candidate.end)
    ?? map.entries.at(-1)!;
  return { node: entry.node, offset: Math.max(0, Math.min(entry.node.length, offset - entry.start)) };
}

export function domRangeForOffsets(
  root: HTMLElement,
  range: TextOffsetRange,
  map = conversationTextMap(root),
): Range | null {
  if (range.end <= range.start) return null;
  const start = pointAt(map, range.start);
  const end = pointAt(map, range.end);
  if (!start || !end) return null;
  const result = root.ownerDocument.createRange();
  result.setStart(start.node, start.offset);
  result.setEnd(end.node, end.offset);
  return result;
}

function textOffsetForDomPoint(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
  map: ConversationTextMap,
): number | null {
  if (!root.contains(node) && root !== node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const entry = map.entries.find((candidate) => candidate.node === node);
    if (entry) return Math.max(entry.start, Math.min(entry.end, entry.start + nodeOffset));
  }
  try {
    const before = root.ownerDocument.createRange();
    before.setStart(root, 0);
    before.setEnd(node, nodeOffset);
    return Math.max(0, Math.min(map.text.length, before.toString().length));
  } catch {
    return null;
  }
}

export function textOffsetAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
  fallbackTarget?: EventTarget | null,
): number | null {
  const map = conversationTextMap(root);
  if (!map.text) return null;
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (clientX: number, clientY: number) => CaretPosition | null;
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    const offset = textOffsetForDomPoint(root, position.offsetNode, position.offset, map);
    if (offset != null) return offset;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) {
    const offset = textOffsetForDomPoint(root, range.startContainer, range.startOffset, map);
    if (offset != null) return offset;
  }
  const fallback = fallbackTarget instanceof Node
    ? map.entries.find((entry) => fallbackTarget === entry.node
      || (fallbackTarget instanceof Element && fallbackTarget.contains(entry.node)))
    : undefined;
  return fallback?.start ?? map.entries[0]?.start ?? null;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const pathOrCommandToken = (value: string): boolean => (
  /[\\/]/.test(value) || /^~(?:[\\/]|$)/.test(value)
  || /^-{1,2}[A-Za-z0-9]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
);

export function wordRangeAt(text: string, rawOffset: number): TextOffsetRange | null {
  if (!text) return null;
  let offset = Math.max(0, Math.min(text.length - 1, rawOffset));
  if (/\s/.test(text[offset] ?? '')) {
    let next = offset;
    while (next < text.length && /\s/.test(text[next] ?? '')) next += 1;
    let previous = offset - 1;
    while (previous >= 0 && /\s/.test(text[previous] ?? '')) previous -= 1;
    if (next < text.length) offset = next;
    else if (previous >= 0) offset = previous;
    else return null;
  }
  let tokenStart = offset;
  let tokenEnd = offset + 1;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? '')) tokenStart -= 1;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd += 1;
  const token = text.slice(tokenStart, tokenEnd);
  if (pathOrCommandToken(token)) {
    return { start: tokenStart, end: tokenEnd };
  }

  const touched = text[offset] ?? '';
  if (/[\x21-\x7e]/.test(touched)) {
    let start = offset;
    let end = offset + 1;
    while (start > tokenStart && /[\x21-\x7e]/.test(text[start - 1] ?? '')) start -= 1;
    while (end < tokenEnd && /[\x21-\x7e]/.test(text[end] ?? '')) end += 1;
    return { start, end };
  }

  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const segment of segmenter.segment(text)) {
      const end = segment.index + segment.segment.length;
      if (segment.index <= offset && offset < end && (segment.isWordLike || CJK.test(segment.segment))) {
        return { start: segment.index, end };
      }
    }
  }
  const codePoint = text.codePointAt(offset);
  const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  return { start: offset, end: Math.min(text.length, offset + width) };
}

function elementOffsetRange(
  element: Element,
  map: ConversationTextMap,
): TextOffsetRange | null {
  const entries = map.entries.filter((entry) => element.contains(entry.node));
  if (!entries.length) return null;
  return { start: entries[0]!.start, end: entries.at(-1)!.end };
}

const PARAGRAPH_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre';

function semanticBlock(root: HTMLElement, offset: number, map: ConversationTextMap): Element | null {
  const point = pointAt(map, offset);
  if (!point) return null;
  const block = point.node.parentElement?.closest(PARAGRAPH_SELECTOR) ?? null;
  return block && root.contains(block) ? block : null;
}

function blankLineParagraph(text: string, range: TextOffsetRange): TextOffsetRange {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const previousBlank = before.lastIndexOf('\n\n');
  const nextBlank = after.indexOf('\n\n');
  return {
    start: previousBlank < 0 ? 0 : previousBlank + 2,
    end: nextBlank < 0 ? text.length : range.end + nextBlank,
  };
}

function paragraphAtOffset(
  root: HTMLElement,
  offset: number,
  map: ConversationTextMap,
): TextOffsetRange {
  const block = semanticBlock(root, offset, map);
  const blockRange = block ? elementOffsetRange(block, map) : null;
  if (block?.matches('pre') && blockRange) {
    const localText = map.text.slice(blockRange.start, blockRange.end);
    const localOffset = Math.max(0, Math.min(localText.length - 1, offset - blockRange.start));
    const local = blankLineParagraph(localText, { start: localOffset, end: localOffset + 1 });
    return { start: blockRange.start + local.start, end: blockRange.start + local.end };
  }
  if (blockRange) return blockRange;
  return blankLineParagraph(map.text, { start: offset, end: Math.min(map.text.length, offset + 1) });
}

function diffParagraphRange(
  root: HTMLElement,
  range: TextOffsetRange,
  map: ConversationTextMap,
): TextOffsetRange | null {
  if (!root.matches('.chat-diff, .dv')) return null;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.chat-diff-line, .dv-row'));
  const rowRanges = rows.map((row) => elementOffsetRange(row, map));
  const startIndex = rowRanges.findIndex((candidate) => candidate
    && candidate.start <= range.start && range.start < candidate.end);
  let endIndex = rowRanges.findIndex((candidate) => candidate
    && candidate.start < range.end && range.end <= candidate.end);
  if (startIndex < 0) return null;
  if (endIndex < 0) endIndex = startIndex;
  const blank = (index: number): boolean => {
    const candidate = rowRanges[index];
    if (!candidate) return true;
    const row = rows[index];
    const code = row?.matches('.dv-row')
      ? row.querySelector<HTMLElement>('.dv-code')?.textContent ?? ''
      : map.text.slice(candidate.start, candidate.end).replace(/^[+\- ]/, '');
    return !code.trim();
  };
  let first = startIndex;
  let last = endIndex;
  while (first > 0 && !blank(first - 1)) first -= 1;
  while (last < rows.length - 1 && !blank(last + 1)) last += 1;
  while (first <= last && blank(first)) first += 1;
  while (last >= first && blank(last)) last -= 1;
  const firstRange = rowRanges[first];
  const lastRange = rowRanges[last];
  return firstRange && lastRange ? { start: firstRange.start, end: lastRange.end } : null;
}

export function paragraphRange(
  root: HTMLElement,
  range: TextOffsetRange,
  map = conversationTextMap(root),
): TextOffsetRange {
  const diffRange = diffParagraphRange(root, range, map);
  if (diffRange) return diffRange;
  const startRange = paragraphAtOffset(root, range.start, map);
  const endRange = paragraphAtOffset(root, Math.max(range.start, range.end - 1), map);
  return {
    start: Math.min(startRange.start, endRange.start),
    end: Math.max(startRange.end, endRange.end),
  };
}

export interface LineRect { top: number; bottom: number }

export function visualLineRange(
  range: TextOffsetRange,
  textLength: number,
  rectAt: (offset: number) => LineRect | null,
  scopeAt?: (offset: number) => TextOffsetRange | null,
): TextOffsetRange {
  if (textLength <= 0) return range;
  const firstOffset = Math.min(textLength - 1, Math.max(0, range.start));
  const lastOffset = Math.min(textLength - 1, Math.max(firstOffset, range.end - 1));
  const firstRect = rectAt(firstOffset);
  const lastRect = rectAt(lastOffset);
  if (!firstRect || !lastRect) return range;
  const sameLine = (a: LineRect, b: LineRect): boolean => Math.abs(a.top - b.top) < 2;
  const firstScope = scopeAt?.(firstOffset) ?? { start: 0, end: textLength };
  const lastScope = scopeAt?.(lastOffset) ?? { start: 0, end: textLength };
  let low = Math.max(0, Math.min(firstOffset, firstScope.start));
  let high = firstOffset;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const rect = rectAt(middle);
    if (rect && sameLine(rect, firstRect)) high = middle;
    else low = middle + 1;
  }
  const start = low;
  low = lastOffset + 1;
  high = Math.max(low, Math.min(textLength, lastScope.end));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const rect = rectAt(middle);
    if (rect && sameLine(rect, lastRect)) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

export function visualLineFlowRange(
  root: HTMLElement,
  offset: number,
  map = conversationTextMap(root),
): TextOffsetRange {
  const point = pointAt(map, offset);
  const cell = point?.node.parentElement?.closest('td, th') ?? null;
  return cell && root.contains(cell)
    ? elementOffsetRange(cell, map) ?? { start: 0, end: map.text.length }
    : { start: 0, end: map.text.length };
}

export function characterRect(
  root: HTMLElement,
  offset: number,
  map = conversationTextMap(root),
): DOMRect | null {
  const range = domRangeForOffsets(root, { start: offset, end: offset + 1 }, map);
  if (!range || typeof range.getClientRects !== 'function') return null;
  return Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0) ?? null;
}

function listMarker(item: HTMLElement): string {
  const explicit = item.dataset.chatCopyMarker;
  if (explicit) return explicit;
  const list = item.parentElement;
  if (list?.tagName !== 'OL') return '-';
  const start = Number.parseInt(list.getAttribute('start') || '1', 10);
  const index = Array.from(list.children).filter((child) => child.tagName === 'LI').indexOf(item);
  return `${(Number.isFinite(start) ? start : 1) + Math.max(0, index)}.`;
}

export function copyTextForRange(range: Range, includeEnclosingListItem = false): string {
  const copyRoot = range.startContainer.parentElement?.closest<HTMLElement>(
    '[data-conversation-copy-root]',
  ) ?? null;
  const enclosingItem = includeEnclosingListItem
    ? range.startContainer.parentElement?.closest<HTMLElement>('li') ?? null
    : null;
  const sameEnclosingItem = enclosingItem && enclosingItem.contains(range.endContainer)
    ? enclosingItem : null;
  const wholeEnclosingItem = sameEnclosingItem
    && range.toString() === conversationTextMap(sameEnclosingItem).text;
  const decorated: Array<{
    item: HTMLElement;
    marker: string | undefined;
    depth: string | undefined;
  }> = [];
  copyRoot?.querySelectorAll<HTMLElement>('li').forEach((item) => {
    const list = item.parentElement;
    const listDepth = (() => {
      let count = 0;
      let parent = list?.parentElement ?? null;
      while (parent && parent !== copyRoot) {
        if (parent.tagName === 'LI') count += 1;
        parent = parent.parentElement;
      }
      return count;
    })();
    decorated.push({
      item,
      marker: item.dataset.chatCopyMarker,
      depth: item.dataset.chatCopyDepth,
    });
    item.dataset.chatCopyMarker = listMarker(item);
    item.dataset.chatCopyDepth = String(listDepth);
  });
  let fragment: DocumentFragment;
  let enclosingItemClone: HTMLElement | null = null;
  try {
    fragment = range.cloneContents();
    if (wholeEnclosingItem) enclosingItemClone = sameEnclosingItem.cloneNode(true) as HTMLElement;
  } finally {
    decorated.forEach(({ item, marker, depth }) => {
      if (marker === undefined) delete item.dataset.chatCopyMarker;
      else item.dataset.chatCopyMarker = marker;
      if (depth === undefined) delete item.dataset.chatCopyDepth;
      else item.dataset.chatCopyDepth = depth;
    });
  }
  const blockTags = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FIGCAPTION', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'P',
    'PRE', 'SECTION', 'TR',
  ]);
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
    if (node instanceof HTMLElement && (
      node.matches('[aria-hidden="true"], .chat-copy-ignore')
      || node.hidden
    )) return '';
    if (node instanceof HTMLBRElement) return '\n';
    if (node instanceof HTMLElement && node.tagName === 'LI') {
      let direct = '';
      let nested = '';
      node.childNodes.forEach((child) => {
        if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) {
          nested += read(child);
        } else {
          direct += read(child);
        }
      });
      const depth = Number.parseInt(node.dataset.chatCopyDepth || '0', 10) || 0;
      const line = `${'  '.repeat(depth)}${listMarker(node)} ${direct.replace(/\n+$/, '')}`;
      return `${line}\n${nested}`;
    }
    let text = '';
    node.childNodes.forEach((child) => { text += read(child); });
    if (node instanceof HTMLElement && (node.tagName === 'TD' || node.tagName === 'TH')
      && node.nextElementSibling && text && !text.endsWith('\t')) text += '\t';
    if (node instanceof HTMLElement && blockTags.has(node.tagName)
      && !node.matches('.dv-row, .chat-diff-line') && text && !text.endsWith('\n')) {
      text += '\n';
    }
    return text;
  };
  let text = enclosingItemClone ? read(enclosingItemClone) : read(fragment);
  if (sameEnclosingItem && !enclosingItemClone) {
    const item = sameEnclosingItem;
    const itemMap = conversationTextMap(item);
    const startsAtItemBoundary = textOffsetForDomPoint(
      item,
      range.startContainer,
      range.startOffset,
      itemMap,
    ) === 0;
    if (!startsAtItemBoundary) return text
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/(?:\n[ \t]*)+$/, '');
    let depth = 0;
    let parent = item.parentElement?.parentElement ?? null;
    while (parent && parent !== copyRoot) {
      if (parent.tagName === 'LI') depth += 1;
      parent = parent.parentElement;
    }
    text = `${'  '.repeat(depth)}${listMarker(item)} ${text}`;
  }
  return text
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}
