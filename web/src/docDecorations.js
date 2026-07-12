import { findDocLinks } from './docPath.js';

// Read the logical line that contains absolute buffer row `idx` by walking CELLS (not the string),
// so wide CJK glyphs map to the right columns: a full-width char occupies 2 cells (its char in the
// first, a width-0 placeholder in the second). Walking up from a wrapped continuation to its start
// and down through every isWrapped continuation also stitches a path folded across rows.
//
// Returns { text, cells } where text[i] is the i-th visible char and cells[i] = { row, col, w } is
// its absolute buffer row, starting column, and cell width (1 or 2). Blank cells become a single
// space so word boundaries survive for the matcher.
function readLogicalLine(buf, idx, cols) {
  let start = idx;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let text = '';
  const cells = [];
  let r = start;
  do {
    const line = buf.getLine(r);
    if (!line) break;
    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // placeholder trailing a wide char — already counted
      text += cell.getChars() || ' ';
      cells.push({ row: r, col, w });
    }
    r++;
  } while (r < buf.length && buf.getLine(r)?.isWrapped);
  return { text, cells };
}

// Visible doc-path links as decoration segments → [{ y, x, width, path }], y = ABSOLUTE buffer row,
// x/width = CELL columns on that row (wide-char aware). A path wrapped across rows yields one
// segment per row. Used ONLY for the persistent underline — taps go through the link provider
// (docLinksOnLine), since decorations sit under the event-capturing viewport.
export function scanDocLinks(term) {
  const buf = term.buffer.active;
  const cols = term.cols;
  const top = buf.baseY;
  const bottom = top + term.rows; // exclusive
  const out = [];

  let y = top;
  while (y > 0 && buf.getLine(y)?.isWrapped) y--; // back up if the top row is a continuation
  while (y < bottom) {
    if (!buf.getLine(y)) { y++; continue; }
    const { text, cells } = readLogicalLine(buf, y, cols);
    for (const { start, end } of findDocLinks(text)) {
      let i = start;
      while (i < end) {
        const row = cells[i].row;
        let j = i;
        while (j < end && cells[j].row === row) j++;
        const xStart = cells[i].col;
        const lastCell = cells[j - 1];
        const xEnd = lastCell.col + lastCell.w; // exclusive end column
        if (row >= top && row < bottom) out.push({ y: row, x: xStart, width: xEnd - xStart, path: text.slice(start, end) });
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
export function docLinksOnLine(term, bufferLineNumber) {
  const buf = term.buffer.active;
  const cols = term.cols;
  const idx = bufferLineNumber - 1; // 0-based absolute row
  if (idx < 0 || idx >= buf.length) return [];
  const { text, cells } = readLogicalLine(buf, idx, cols);
  const out = [];
  for (const { start, end } of findDocLinks(text)) {
    const s = cells[start];
    const e = cells[end - 1];
    if (idx < s.row || idx > e.row) continue; // this link isn't on the queried line
    out.push({
      range: { start: { x: s.col + 1, y: s.row + 1 }, end: { x: e.col + e.w, y: e.row + 1 } },
      path: text.slice(start, end),
    });
  }
  return out;
}
