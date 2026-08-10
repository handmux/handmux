// Pure geometry for the pane layout map: a SIMPLIFIED schematic of the real tmux split. No DOM —
// unit-tested. Same "extract the pure bits" pattern as terminalViewport.js / terminalSeed.js.
//
// Deliberately NOT proportional: we don't reproduce each pane's real cell size, only the split
// STRUCTURE. Every split divides its space EQUALLY (a left/right split → two equal columns; a top/
// bottom split → two equal rows), so the map is a clean binary-division diagram you read to pick a
// pane, never a pixel-faithful mirror. This also means tiles can never collapse to slivers, so there's
// no min-size / map-growth machinery — the map box is always the fixed base size.

export const MAP_W = 248;
export const MAP_H = 158;
// Inner gutter between tiles and the map's frosted edge. Baked into each cell's left/top by the
// COMPONENT (CSS `padding` can't inset absolutely-positioned children), while w/h include it both sides.
export const MAP_PAD = 6;
// A tmux pane border is 1 cell; that shows as a thin fixed seam between tiles, not an equal track.
const SEAM = 2;
// Below these rendered pixel sizes a cell can't legibly show its command, so content degrades:
// too NARROW → seq only; too FLAT (short) → seq + command on one row; both → seq only.
const NARROW_PX = 52;
const FLAT_PX = 34;

export interface PaneLayoutSource {
  id: string;
  active?: boolean;
  command?: string | null;
  left?: number | null;
  top?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface PaneGeometry extends PaneLayoutSource {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneLayoutCell {
  id: string;
  active: boolean;
  command?: string | null;
  seq: number;
  left: number;
  top: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export interface PaneMapLayout {
  w: number;
  h: number;
  cells: PaneLayoutCell[];
}

export type PaneCellFit = '' | 'flat' | 'narrow' | 'tiny';

const fin = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// True when panes is non-empty and every pane carries finite left/top/width/height, so a map can be
// drawn. When false, callers fall back to the flat pane list.
export function hasGeometry(panes: unknown): panes is PaneGeometry[] {
  return Array.isArray(panes) && panes.length > 0 &&
    panes.every((pane) => pane !== null && typeof pane === 'object' && !Array.isArray(pane)
      && typeof pane.id === 'string'
      && fin(pane.left) && fin(pane.top) && fin(pane.width) && fin(pane.height));
}

// A pane has an independently movable WIDTH only when one of its vertical edges meets another pane
// over a non-empty row range. Pure top/bottom stacks share the window width, so showing an x-stepper
// there would be a control that tmux cannot meaningfully apply. Accept a 0/1-cell gap because fixtures
// may omit tmux's one-cell border while live pane coordinates include it.
export function canResizePaneWidth(
  panes: readonly PaneLayoutSource[] | null | undefined,
  paneId: string,
): boolean {
  if (!hasGeometry(panes) || panes.length < 2) return false;
  const target = panes.find((pane) => pane.id === paneId);
  if (!target) return false;
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  return panes.some((pane) => {
    if (pane.id === paneId) return false;
    const overlapsRows = Math.min(bottom, pane.top + pane.height) > Math.max(target.top, pane.top);
    if (!overlapsRows) return false;
    const paneRight = pane.left + pane.width;
    return Math.abs(pane.left - right) <= 1 || Math.abs(target.left - paneRight) <= 1;
  });
}

const uniqSorted = (numbers: readonly number[]): number[] => [...new Set(numbers)].sort((a, b) => a - b);

// Split lines along one axis → equal pixel tracks. A track is a BORDER SEAM when it's ≤1 cell and no
// pane exactly fills it (tmux's 1-cell pane border); a seam gets a fixed hairline. Every other track
// gets an EQUAL share of the remaining length — that's the "binary division" simplification: real cell
// sizes are ignored, only the split structure is kept. `spans` are the panes' [start,end] extents on
// this axis. Returns [{ at }] prefix offsets: a pane spanning edges[i]..edges[j] gets left=out[i].at,
// width=out[j].at-out[i].at.
function trackOffsets(edges: readonly number[], spans: readonly (readonly [number, number])[], inner: number): { at: number }[] {
  const seams: boolean[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const a = edges[i];
    const b = edges[i + 1];
    const isPane = spans.some(([s, e]) => s === a && e === b);
    seams.push(b - a <= 1 && !isPane);
  }
  const realCount = seams.filter((s) => !s).length;
  const each = realCount > 0 ? (inner - seams.filter(Boolean).length * SEAM) / realCount : inner;
  const offsets = [{ at: 0 }];
  let acc = 0;
  for (let i = 0; i < seams.length; i += 1) {
    acc += seams[i] ? SEAM : each;
    offsets.push({ at: acc });
  }
  return offsets;
}

// The map mosaic: pixel rects on the fixed base box, one per pane, laid out by equal division of each
// split. Cell width/height are rendered pixels; cols/rows preserve the real tmux terminal dimensions
// for quiet metadata in roomy tiles. Returns null when geometry is missing.
export function paneLayout(panes: readonly PaneLayoutSource[] | null | undefined): PaneMapLayout | null {
  if (!hasGeometry(panes)) return null;
  const totalCols = Math.max(...panes.map((p) => p.left + p.width));
  const totalRows = Math.max(...panes.map((p) => p.top + p.height));
  if (totalCols <= 0 || totalRows <= 0) return null;

  const xs = uniqSorted(panes.flatMap((p) => [p.left, p.left + p.width]));
  const ys = uniqSorted(panes.flatMap((p) => [p.top, p.top + p.height]));
  const xSpans = panes.map((pane): [number, number] => [pane.left, pane.left + pane.width]);
  const ySpans = panes.map((pane): [number, number] => [pane.top, pane.top + pane.height]);
  const xOff = trackOffsets(xs, xSpans, MAP_W - MAP_PAD * 2);
  const yOff = trackOffsets(ys, ySpans, MAP_H - MAP_PAD * 2);

  const cells = panes.map((p, seq) => {
    const x0 = xOff[xs.indexOf(p.left)].at;
    const x1 = xOff[xs.indexOf(p.left + p.width)].at;
    const y0 = yOff[ys.indexOf(p.top)].at;
    const y1 = yOff[ys.indexOf(p.top + p.height)].at;
    return {
      id: p.id, active: !!p.active,
      ...(p.command !== undefined ? { command: p.command } : {}),
      seq,
      left: x0, top: y0, width: x1 - x0, height: y1 - y0,
      cols: p.width, rows: p.height,
    };
  });
  return { w: MAP_W, h: MAP_H, cells };
}

// Classify one pixel-sized cell (a paneLayout cell) so the component can degrade content for cramped
// cells (only happens with many panes now): '' (full), 'flat' (short → seq + command on one row),
// 'narrow' (thin → seq only), 'tiny'.
export function cellFit(cell: Pick<PaneLayoutCell, 'width' | 'height'>): PaneCellFit {
  const narrow = cell.width < NARROW_PX;
  const flat = cell.height < FLAT_PX;
  if (narrow && flat) return 'tiny';
  if (narrow) return 'narrow';
  if (flat) return 'flat';
  return '';
}
