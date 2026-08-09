// Terminal QR using vertical half-blocks: each character stacks TWO module rows (top + bottom) in one cell,
// one module wide. A terminal cell is ~2× taller than wide, so a 1-wide × 2-tall module pair renders as a
// SQUARE module — the whole code comes out square and scans cleanly.
//
// (The earlier 2×2 "quadrant" packing was half the width, but putting 2 modules across a 2:1 cell made each
// module twice as tall as wide, stretching the whole code vertically. Square + scannable beats narrow.)
//
// Polarity: a LIGHT module (quiet zone / non-ink) renders bright, a DARK (ink) module renders empty — so on
// a dark terminal it reads as a black code on a white field, the quiet zone being the white border.
//
// matrix[r][c] === true means a DARK module. renderCompactQr is pure (no I/O) so it's unit-tested; the CLI
// builds the matrix from qrcode-terminal's QR model and hands it here.

export function renderCompactQr(matrix: readonly (readonly boolean[])[], { quiet = 2 }: { quiet?: number } = {}): string {
  const n = matrix.length;
  const side = n + quiet * 2;
  // A module is LIGHT when it's outside the code (quiet zone, incl. a dangling final half-row) or the matrix
  // cell is not dark.
  const light = (r: number, c: number): boolean => {
    const mr = r - quiet, mc = c - quiet;
    if (mr < 0 || mr >= n || mc < 0 || mc >= n) return true;
    return !(matrix[mr]?.[mc] ?? false);
  };
  let out = '';
  for (let r = 0; r < side; r += 2) {
    for (let c = 0; c < side; c++) {
      const top = light(r, c);
      const bottom = light(r + 1, c); // overflow row (odd side) is out-of-range → LIGHT, i.e. quiet border
      out += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    out += '\n';
  }
  return out;
}
