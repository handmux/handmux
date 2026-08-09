// Pure selection helpers for the terminal copy UX. No DOM — unit-tested; see terminalSeed.js for the
// same "extract the pure bits" pattern.

// Trim each line's leading + trailing whitespace (row padding AND indentation — the user wants copied
// text directly usable), then drop leading/trailing blank lines. Interior blank lines are kept.
export function trimCopy(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === '') a++;
  while (b > a && lines[b - 1] === '') b--;
  return lines.slice(a, b).join('\n');
}

// The blue "复制模式 · N 行 · M 字" status strip's counts for a selection's text. Lines = rows the
// selection spans (raw newline count). Chars = characters AFTER the copy-trim (trimCopy) with newlines
// removed — so it matches what actually lands on the clipboard, not the row-padding spaces. Empty text → 0/0.
export function selectionCounts(text: string): SelectionCounts {
  if (!text) return { lines: 0, chars: 0 };
  return {
    lines: text.split('\n').length,
    chars: trimCopy(text).replace(/\n/g, '').length,
  };
}

// Expand a cell range to cover the whole line(s) it spans.
export function expandToLines(range: TerminalCellRange, cols: number): TerminalCellRange {
  return {
    start: { col: 0, row: range.start.row },
    end: { col: cols - 1, row: range.end.row },
  };
}

// Expand to a blank-line-bounded paragraph: walk up while the line above is non-blank, down likewise,
// clamped to [minRow, maxRow] (the buffer's first/last row).
export function expandToParagraph(
  range: TerminalCellRange,
  cols: number,
  lineText: (row: number) => string,
  minRow: number,
  maxRow: number,
): TerminalCellRange {
  let top = range.start.row;
  let bot = range.end.row;
  while (top > minRow && lineText(top - 1).trim() !== '') top--;
  while (bot < maxRow && lineText(bot + 1).trim() !== '') bot++;
  return { start: { col: 0, row: top }, end: { col: cols - 1, row: bot } };
}

// Absolute buffer cell → px relative to the .xterm-screen box. The component adds the screen→wrap
// offset. cellW/cellH come from the live screen box so they track font size + horizontal scroll.
export function cellToPx(
  col: number,
  absRow: number,
  viewportY: number,
  cellW: number,
  cellH: number,
): { x: number; y: number } {
  return { x: col * cellW, y: (absRow - viewportY) * cellH };
}
export interface TerminalCell {
  col: number;
  row: number;
}

export interface TerminalCellRange {
  start: TerminalCell;
  end: TerminalCell;
}

export interface SelectionCounts {
  lines: number;
  chars: number;
}
