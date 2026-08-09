import { describe, it, expect } from 'vitest';
import { renderCompactQr } from '../src/cli/qr.js';

const GLYPHS = new Set([...' ▀▄█']);

describe('renderCompactQr (half-block, square)', () => {
  it('stacks two module rows per character (top/bottom half-blocks)', () => {
    // quiet:0, a 2×2 matrix → one output line of two chars. LIGHT renders bright.
    expect(renderCompactQr([[true, true], [false, false]], { quiet: 0 })).toBe('▄▄\n'); // top dark, bottom light → ▄
    expect(renderCompactQr([[false, false], [true, true]], { quiet: 0 })).toBe('▀▀\n'); // top light, bottom dark → ▀
    expect(renderCompactQr([[true, true], [true, true]], { quiet: 0 })).toBe('  \n');   // both dark → empty
    expect(renderCompactQr([[false, false], [false, false]], { quiet: 0 })).toBe('██\n'); // both light → full block
  });

  it('treats the quiet zone (and out-of-range) as LIGHT', () => {
    // 1×1 dark module ringed by quiet:1 → 3×3 grid → 3 wide × 2 lines.
    // line0 = rows0/1: █ (L/L), ▀ (L/dark), █ (L/L); line1 = row2/overflow: all LIGHT → ███.
    expect(renderCompactQr([[true]], { quiet: 1 })).toBe('█▀█\n███\n');
  });

  it('is square on a 2:1 cell — full module width, two module-rows per line', () => {
    const n = 33; // a real v4 QR module count
    const matrix = Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => (r + c) % 2 === 0));
    const lines = renderCompactQr(matrix).split('\n').filter(Boolean);
    const side = n + 4; // quiet:2 default
    expect([...(lines[0] ?? '')].length).toBe(side);  // one char per module across → full width
    expect(lines.length).toBe(Math.ceil(side / 2));   // two module-rows packed per line
    for (const line of lines) for (const ch of line) expect(GLYPHS.has(ch)).toBe(true);
  });
});
