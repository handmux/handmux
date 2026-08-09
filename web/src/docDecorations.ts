import { findDocLinks } from './docPath.js';
import type { DocumentPathLink } from './docPath.js';
import { findLocalUrls } from './localUrl.js';
import type { LocalUrlLink } from './localUrl.js';

export type OutputLink =
  | (DocumentPathLink & { kind: 'doc' })
  | (Omit<LocalUrlLink, 'path'> & { kind: 'url'; urlPath: string });

export interface TerminalDecorationSegment {
  y: number;
  x: number;
  width: number;
  kind: OutputLink['kind'];
  path: string;
}

export interface TerminalLineLink {
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  kind: OutputLink['kind'];
  path: string;
  protocol?: 'http' | 'https';
  port?: number;
  urlPath?: string;
  raw?: string;
}

interface TerminalBufferCell {
  getChars(): string;
  getWidth(): number;
}

interface TerminalBufferLine {
  readonly isWrapped: boolean;
  getCell(column: number): TerminalBufferCell | undefined;
}

interface TerminalBuffer {
  readonly length: number;
  getLine(line: number): TerminalBufferLine | undefined;
}

interface DecorationTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: TerminalBuffer };
}

interface LogicalCell {
  row: number;
  col: number;
  w: number;
}

// Merge the two kinds of tappable spans on ONE logical line: web URLs (kind:'url') and doc paths
// (kind:'doc'). URLs win — a doc-path match that OVERLAPS a URL span is dropped, because `:` is a
// doc-path delimiter, so `example.com:3000/foo.html` would otherwise also surface a spurious `3000/foo.html`
// doc link. Returns start/end (char offsets into `text`) + a small payload the tap handler routes on:
//   url → { protocol, port, urlPath, raw };  doc → { path }.
export function findOutputLinks(text: string): OutputLink[] {
  const urls = findLocalUrls(text);
  const links: OutputLink[] = urls.map((url) => ({
    start: url.start,
    end: url.end,
    kind: 'url',
    protocol: url.protocol,
    port: url.port,
    urlPath: url.path,
    raw: url.raw,
  }));
  for (const d of findDocLinks(text)) {
    if (urls.some((u) => d.start < u.end && d.end > u.start)) continue; // inside a URL → not a doc path
    links.push({ start: d.start, end: d.end, kind: 'doc', path: d.path });
  }
  links.sort((a, b) => a.start - b.start);
  return links;
}

// Is row `r` filled right up to its last column (i.e. it was folded by width, not ended early)?
//   - a glyph in the final column → filled;
//   - a width-0 cell in the final column → the tail of a wide glyph that fills the edge → filled;
//   - the final column blank BUT the penultimate is a width-0 wide-glyph tail → filled: a wide (CJK)
//     glyph that couldn't fit the last column was bumped to the next row, leaving the last column a
//     spacer that tmux pads with a real space. Without this case, every CJK path that soft-folds one
//     glyph short of the edge looks "short" and never stitches to its continuation.
function reachesEdge(line: TerminalBufferLine, cols: number): boolean {
  const last = line.getCell(cols - 1);
  if (!last) return false;
  if (last.getWidth() === 0) return true;
  const ch = last.getChars();
  if (ch && ch !== ' ') return true;
  const prev = cols > 1 ? line.getCell(cols - 2) : undefined;
  return !!prev && prev.getWidth() === 0;
}

// Does row `r+1` continue row `r`'s logical line? True for a soft wrap (xterm sets isWrapped when it
// auto-folds at the column boundary) OR a HARD fold: a program that width-folds its OWN output (Ink /
// Claude Code) emits a real `\n`, so the continuation is NOT flagged isWrapped. We infer that fold when
// row `r` is filled to its last column AND row `r+1` starts flush at column 0 (no leading space/indent).
// Box-drawn panels (`│ … │`) have trailing/leading padding, so they fail the flush test and stay
// un-stitched — and `│` is a delimiter anyway, so even a padding-free frame can't fuse a false path.
function isContinuation(buf: TerminalBuffer, r: number, cols: number): boolean {
  const next = buf.getLine(r + 1);
  if (!next) return false;
  if (next.isWrapped) return true;
  const cur = buf.getLine(r);
  if (!cur || !reachesEdge(cur, cols)) return false;
  const first = next.getCell(0)?.getChars();
  return !!first && first !== ' ';
}

// Read the logical line that contains absolute buffer row `idx` by walking CELLS (not the string),
// so wide CJK glyphs map to the right columns: a full-width char occupies 2 cells (its char in the
// first, a width-0 placeholder in the second). Walking up from a continuation row to its start and
// down through every continuation (soft- OR hard-wrapped, see isContinuation) stitches a path folded
// across rows.
//
// Returns { text, cells } where text[i] is the i-th visible char and cells[i] = { row, col, w } is
// its absolute buffer row, starting column, and cell width (1 or 2). Blank cells become a single
// space so word boundaries survive for the matcher.
function readLogicalLine(
  buf: TerminalBuffer,
  idx: number,
  cols: number,
): { text: string; cells: LogicalCell[] } {
  let start = idx;
  while (start > 0 && isContinuation(buf, start - 1, cols)) start--;
  let text = '';
  const cells: LogicalCell[] = [];
  let r = start;
  for (;;) {
    const line = buf.getLine(r);
    if (!line) break;
    const cont = r + 1 < buf.length && isContinuation(buf, r, cols);
    // Collect this row's glyphs (skipping the width-0 placeholder that trails a wide char).
    const chars: string[] = [];
    const rowCells: LogicalCell[] = [];
    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // placeholder trailing a wide char — already counted
      chars.push(cell.getChars());
      rowCells.push({ row: r, col, w });
    }
    // A wrap that lands on a wide (CJK) glyph can't split it: the last column is left a spacer and the
    // glyph moves to the continuation row. That spacer is EMPTY on a soft wrap but a real SPACE when the
    // rows came from tmux's padded capture (a hard fold) — either way, appending it would inject a break
    // INTO a wrapped path (`…超长中文 目录…`) and sever it. So when this row continues into the next, drop
    // its trailing blanks — the content then flows straight through. A blank in the MIDDLE stays a space.
    let n = chars.length;
    if (cont) while (n > 0 && (chars[n - 1] === '' || chars[n - 1] === ' ')) n--;
    for (let k = 0; k < n; k++) {
      text += chars[k] || ' ';
      cells.push(rowCells[k]);
    }
    if (cont) { r++; continue; }
    break;
  }
  return { text, cells };
}

// Visible doc-path links as decoration segments → [{ y, x, width, path }], y = ABSOLUTE buffer row,
// x/width = CELL columns on that row (wide-char aware). A path wrapped across rows yields one
// segment per row. Used ONLY for the persistent underline — taps go through the link provider
// (docLinksOnLine), since decorations sit under the event-capturing viewport.
export function scanDocLinks(term: DecorationTerminal): TerminalDecorationSegment[] {
  const buf = term.buffer.active;
  const cols = term.cols;
  // Scan the WHOLE buffer (every seeded row incl. the pulled-in scrollback), not just the visible
  // viewport. Decorations are anchored to buffer LINES by markers, so once a path is decorated it rides
  // the content as you scroll — no rebuild, no flicker, and it's already lit wherever you scroll to.
  // (Scanning only the viewport meant re-decorating on every scroll frame, which on a fling disposed the
  // marks before they could paint — so they only reappeared once the scroll stopped.) The buffer is
  // bounded by the current capture depth, and this runs on repaint (not per scroll frame).
  const top = 0;
  const bottom = buf.length; // exclusive
  const out: TerminalDecorationSegment[] = [];

  let y = top;
  while (y > 0 && isContinuation(buf, y - 1, cols)) y--; // back up if the top row is a continuation
  while (y < bottom) {
    if (!buf.getLine(y)) { y++; continue; }
    const { text, cells } = readLogicalLine(buf, y, cols);
    for (const { start, end, kind } of findOutputLinks(text)) {
      let i = start;
      while (i < end) {
        const firstCell = cells[i];
        if (!firstCell) break;
        const row = firstCell.row;
        let j = i;
        while (j < end && cells[j]?.row === row) j++;
        const xStart = firstCell.col;
        const lastCell = cells[j - 1];
        if (!lastCell) break;
        const xEnd = lastCell.col + lastCell.w; // exclusive end column
        if (row >= top && row < bottom) out.push({ y: row, x: xStart, width: xEnd - xStart, kind, path: text.slice(start, end) });
        i = j;
      }
    }
    // advance past every row this logical line covered
    y = cells.length ? cells[cells.length - 1].row + 1 : y + 1;
  }
  return out;
}

// Doc-path links on a 1-based buffer line, in the shape xterm's link provider wants:
// [{ range:{start:{x,y},end:{x,y}}, path }] with 1-based inclusive CELL x and buffer-line y. A tap
// on any row of a wrapped path activates it. Wide-char aware via the cell walk above.
export function docLinksOnLine(
  term: DecorationTerminal,
  bufferLineNumber: number,
): TerminalLineLink[] {
  const buf = term.buffer.active;
  const cols = term.cols;
  const idx = bufferLineNumber - 1; // 0-based absolute row
  if (idx < 0 || idx >= buf.length) return [];
  const { text, cells } = readLogicalLine(buf, idx, cols);
  const out: TerminalLineLink[] = [];
  for (const link of findOutputLinks(text)) {
    const { start, end, kind } = link;
    const s = cells[start];
    const e = cells[end - 1];
    if (!s || !e) continue;
    if (idx < s.row || idx > e.row) continue; // this link isn't on the queried line
    const range = {
      start: { x: s.col + 1, y: s.row + 1 },
      end: { x: e.col + e.w, y: e.row + 1 },
    };
    out.push(link.kind === 'url' ? {
      range,
      kind,
      path: text.slice(start, end),
      protocol: link.protocol,
      port: link.port,
      urlPath: link.urlPath,
      raw: link.raw,
    } : {
      range,
      kind,
      path: text.slice(start, end),
    });
  }
  return out;
}
