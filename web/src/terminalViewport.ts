// Pure viewport/scroll geometry for the terminal keyboard-fit + alt-screen scroll features. No DOM —
// unit-tested; see terminalSeed.js / terminalSelection.js for the same "extract the pure bits" pattern.

export type TerminalScrollDecision = 'internal' | 'forward';

export interface TerminalCursor {
  row: number;
  col?: number;
  vis: boolean;
}

export interface FollowTargetOptions {
  cursorLine: number;
  viewportY: number;
  visibleRows: number;
  baseY: number;
  armed: boolean;
}

const clamp = (value: number, low: number, high: number): number => (
  Math.max(low, Math.min(high, value))
);

// Rows that fit `availPx` of height at cell height `cellH`. Floor so the grid never exceeds the box.
export function fitRows(availPx: number, cellH: number): number {
  if (!cellH || cellH <= 0) return 1;
  return Math.max(1, Math.floor(availPx / cellH));
}

// Should a vertical drag scroll the terminal INTERNALLY (xterm viewport) or FORWARD to the app as keys?
// dir: -1 = drag content up (reveal earlier rows), +1 = drag content down (reveal later rows).
export function scrollDecision(viewportY: number, baseY: number, dir: number): TerminalScrollDecision {
  if (dir < 0) return viewportY > 0 ? 'internal' : 'forward';
  return viewportY < baseY ? 'internal' : 'forward';
}

// xterm's logical viewportY can lag one row behind the DOM viewport at a fractional row boundary.
// The browser's clamped scrollTop is authoritative when available: zero means the user can scroll
// no farther, regardless of xterm's rounded logical row.
export function viewportAtTop(viewportY: number, scrollTop?: number | null): boolean {
  return typeof scrollTop === 'number' && Number.isFinite(scrollTop)
    ? scrollTop <= 1
    : viewportY === 0;
}

// scrollToLine target that puts `cursorLine` on the FIRST (top) visible row, clamped to [0, baseY].
export function topTarget(cursorLine: number, baseY: number): number {
  return clamp(cursorLine, 0, baseY);
}

// scrollToLine target that puts `cursorLine` on the BOTTOM visible row, clamped to [0, baseY].
export function bottomTarget(cursorLine: number, visibleRows: number, baseY: number): number {
  return clamp(cursorLine - visibleRows + 1, 0, baseY);
}

// Absolute buffer line of the cursor. cur.row counts UP from the content's bottom row (see cursorSeq).
export function cursorBufferLine(cur: TerminalCursor | null | undefined, seedRows: number): number | null {
  if (!cur || !cur.vis) return null;
  return Math.max(0, (seedRows - 1) - Math.max(0, cur.row | 0));
}

// Blank rows to prepend so `contentRows` of content sits flush at the bottom of a `gridRows`-tall grid.
export function bottomPadRows(contentRows: number, gridRows: number): number {
  return Math.max(0, gridRows - contentRows);
}

// Follow-the-cursor scrollToLine target, or null to stay put — the editor "scroll into view" rule: scroll
// the minimum to the NEAREST edge the cursor left by. Above the window → put it on the first row (top-align);
// below → on the last row (bottom-align); still in view → don't move. Only acts when armed.
export function followTarget({
  cursorLine,
  viewportY,
  visibleRows,
  baseY,
  armed,
}: FollowTargetOptions): number | null {
  if (!armed) return null;
  if (cursorLine < viewportY) return topTarget(cursorLine, baseY);
  if (cursorLine >= viewportY + visibleRows) return bottomTarget(cursorLine, visibleRows, baseY);
  return null;
}
