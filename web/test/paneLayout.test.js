import { describe, it, expect } from 'vitest';
import { hasGeometry, paneLayout, cellFit, MAP_W, MAP_H } from '../src/paneLayout.js';

const hsplit = [ // real tmux half-split of an 80-col window: a 1-col BORDER seam at col 40 between them
  { id: '%1', active: true,  command: 'zsh',  left: 0,  top: 0, width: 40, height: 24 },
  { id: '%2', active: false, command: 'node', left: 41, top: 0, width: 39, height: 24 },
];
const grid = [ // 2x2 (no borders in this fixture)
  { id: '%1', active: true,  command: 'a', left: 0,  top: 0,  width: 40, height: 12 },
  { id: '%2', active: false, command: 'b', left: 40, top: 0,  width: 40, height: 12 },
  { id: '%3', active: false, command: 'c', left: 0,  top: 12, width: 40, height: 12 },
  { id: '%4', active: false, command: 'd', left: 40, top: 12, width: 40, height: 12 },
];

describe('hasGeometry', () => {
  it('true when every pane has finite left/top/width/height', () => {
    expect(hasGeometry(hsplit)).toBe(true);
  });
  it('false on empty, or when any pane is missing a coordinate', () => {
    expect(hasGeometry([])).toBe(false);
    expect(hasGeometry([{ id: '%1', width: 80, height: 24 }])).toBe(false); // no left/top
    expect(hasGeometry([{ id: '%1', left: 0, top: 0, width: 80, height: NaN }])).toBe(false);
  });
});

describe('paneLayout (equal-division schematic)', () => {
  it('always uses the fixed base box (no growth)', () => {
    expect(paneLayout(hsplit)).toMatchObject({ w: MAP_W, h: MAP_H });
    expect(paneLayout(grid)).toMatchObject({ w: MAP_W, h: MAP_H });
  });

  it('a left/right split → two EQUAL columns, with a hairline border seam between them', () => {
    const { cells } = paneLayout(hsplit);
    expect(cells.map((c) => c.id)).toEqual(['%1', '%2']);
    expect(cells[0].width).toBeCloseTo(119); // (240 - 1 seam*2) / 2 columns
    expect(cells[1].width).toBeCloseTo(119); // equal — real 40 vs 39 cells is ignored
    expect(cells[1].left - (cells[0].left + cells[0].width)).toBeCloseTo(2); // the 2px seam, not a big gap
    expect(cells[0].height).toBeCloseTo(150); // both full height (150-8... = MAP_H-8)
  });

  it('2x2 grid → four EQUAL quarter tiles', () => {
    const { cells } = paneLayout(grid);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => Math.abs(c.width - 120) < 0.5 && Math.abs(c.height - 75) < 0.5)).toBe(true);
    expect(cells[3]).toMatchObject({ command: 'd', seq: 3 });
    expect(cells[3].left).toBeCloseTo(120);
    expect(cells[3].top).toBeCloseTo(75);
  });

  it('ignores real cell ratios: a lopsided 90/10 stack renders as two EQUAL rows', () => {
    const stack = [
      { id: '%1', active: true,  command: 'vim', left: 0, top: 0,  width: 80, height: 90 },
      { id: '%2', active: false, command: 'zsh', left: 0, top: 90, width: 80, height: 10 },
    ];
    const { cells } = paneLayout(stack);
    expect(cells[0].height).toBeCloseTo(75); // not 135 — equal division, real 90:10 discarded
    expect(cells[1].height).toBeCloseTo(75);
  });

  it('the screenshot layout: full-height left + right column split → right tiles are EQUAL, left is full', () => {
    const cols = [
      { id: '%1', active: false, command: 'claude', left: 0,  top: 0,  width: 40, height: 24 }, // full height
      { id: '%2', active: false, command: 'claude', left: 41, top: 0,  width: 39, height: 12 }, // right-top
      { id: '%3', active: true,  command: 'zsh',    left: 41, top: 13, width: 39, height: 11 }, // right-bottom
    ];
    const { w, h, cells } = paneLayout(cols);
    expect({ w, h }).toMatchObject({ w: MAP_W, h: MAP_H }); // no growth
    const [left, rTop, rBot] = cells;
    expect(left.height).toBeCloseTo(150);   // left spans full height
    expect(rTop.height).toBeCloseTo(74);    // right-top == right-bottom, though real is 12 vs 11... and
    expect(rBot.height).toBeCloseTo(74);    // even a 51-vs-11 real split would render equal here
    expect(rBot.top - (rTop.top + rTop.height)).toBeCloseTo(2); // hairline seam, not the old 24px gap
  });

  it('returns null when geometry is missing or degenerate', () => {
    expect(paneLayout([{ id: '%1', command: 'zsh' }])).toBe(null);
    expect(paneLayout([{ id: '%1', left: 0, top: 0, width: 0, height: 0 }])).toBe(null);
  });
});

describe('cellFit', () => {
  it('full content when the pixel cell is roomy in both dimensions', () => {
    expect(cellFit({ width: 119, height: 150 })).toBe('');
  });
  it("'flat' when the cell is short (can't stack seq over command)", () => {
    expect(cellFit({ width: 234, height: 20 })).toBe('flat');
  });
  it("'narrow' when the cell is thin (command can't fit horizontally)", () => {
    expect(cellFit({ width: 30, height: 144 })).toBe('narrow');
  });
  it("'tiny' when the cell is both thin and short", () => {
    expect(cellFit({ width: 30, height: 20 })).toBe('tiny');
  });
});
