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
export const MAP_PAD = 4;
// A tmux pane border is 1 cell; that shows as a thin fixed seam between tiles, not an equal track.
const SEAM = 2;
// Below these rendered pixel sizes a cell can't legibly show its command, so content degrades:
// too NARROW → seq only; too FLAT (short) → seq + command on one row; both → seq only.
const NARROW_PX = 52;
const FLAT_PX = 34;

const fin = (n) => typeof n === 'number' && Number.isFinite(n);

// True when panes is non-empty and every pane carries finite left/top/width/height, so a map can be
// drawn. When false, callers fall back to the flat pane list.
export function hasGeometry(panes) {
  return Array.isArray(panes) && panes.length > 0 &&
    panes.every((p) => fin(p.left) && fin(p.top) && fin(p.width) && fin(p.height));
}

const uniqSorted = (nums) => [...new Set(nums)].sort((a, b) => a - b);

// Split lines along one axis → equal pixel tracks. A track is a BORDER SEAM when it's ≤1 cell and no
// pane exactly fills it (tmux's 1-cell pane border); a seam gets a fixed hairline. Every other track
// gets an EQUAL share of the remaining length — that's the "binary division" simplification: real cell
// sizes are ignored, only the split structure is kept. `spans` are the panes' [start,end] extents on
// this axis. Returns [{ at }] prefix offsets: a pane spanning edges[i]..edges[j] gets left=out[i].at,
// width=out[j].at-out[i].at.
function trackOffsets(edges, spans, inner) {
  const seams = [];
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
// split. Returns { w, h, cells:[{ id, active, command, seq, left, top, width, height }] } (w/h always
// the base size), or null when geometry is missing.
export function paneLayout(panes) {
  if (!hasGeometry(panes)) return null;
  const totalCols = Math.max(...panes.map((p) => p.left + p.width));
  const totalRows = Math.max(...panes.map((p) => p.top + p.height));
  if (totalCols <= 0 || totalRows <= 0) return null;

  const xs = uniqSorted(panes.flatMap((p) => [p.left, p.left + p.width]));
  const ys = uniqSorted(panes.flatMap((p) => [p.top, p.top + p.height]));
  const xSpans = panes.map((p) => [p.left, p.left + p.width]);
  const ySpans = panes.map((p) => [p.top, p.top + p.height]);
  const xOff = trackOffsets(xs, xSpans, MAP_W - MAP_PAD * 2);
  const yOff = trackOffsets(ys, ySpans, MAP_H - MAP_PAD * 2);

  const cells = panes.map((p, seq) => {
    const x0 = xOff[xs.indexOf(p.left)].at;
    const x1 = xOff[xs.indexOf(p.left + p.width)].at;
    const y0 = yOff[ys.indexOf(p.top)].at;
    const y1 = yOff[ys.indexOf(p.top + p.height)].at;
    return { id: p.id, active: !!p.active, command: p.command, seq, left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  });
  return { w: MAP_W, h: MAP_H, cells };
}

// Classify one pixel-sized cell (a paneLayout cell) so the component can degrade content for cramped
// cells (only happens with many panes now): '' (full), 'flat' (short → seq + command on one row),
// 'narrow' (thin → seq only), 'tiny'.
export function cellFit(cell) {
  const narrow = cell.width < NARROW_PX;
  const flat = cell.height < FLAT_PX;
  if (narrow && flat) return 'tiny';
  if (narrow) return 'narrow';
  if (flat) return 'flat';
  return '';
}
