// capture-pane faithfully includes the empty grid below the cursor: a fresh shell draws its prompt
// at the TOP of the pane and leaves every row below it blank, so the capture is "prompt + a wall of
// blank rows". The phone bottom-anchors the capture, so that blank tail lands at the bottom of the
// screen and pushes the real content above the viewport — you open a session and see nothing, and
// have to scroll up (which pauses the live refresh) to find it.
//
// Fix at the source: cap the trailing run of blank rows so the last content row anchors near the
// bottom. We apply this BEFORE hashing/sending, so the change-hash, the transferred body, and the
// client's render + at-bottom logic all key off the same trimmed capture.
//
// A row counts as blank only if it has no glyph AND no SGR escape. captureBackground normalizes
// ambiguous blank rows before this step, so genuinely shaded padding carries its explicit SGR while
// a default-background blank may be trimmed normally.
export const MAX_TRAILING_BLANK = 3;

const isBlank = (row: string): boolean => row === '' || (/^[ \t]*$/.test(row) && !row.includes('\x1b'));

export function capTrailingBlankRows(ansi: string, max = MAX_TRAILING_BLANK): string {
  // capture-pane terminates every row with \n (including a trailing one). Peel that off so split
  // gives exactly the rows, then restore it so the output keeps capture-pane's shape (prepareSeed
  // drops a single trailing newline downstream).
  const hadNL = ansi.endsWith('\n');
  const rows = (hadNL ? ansi.slice(0, -1) : ansi).split('\n');
  let end = rows.length;
  while (end > 0 && isBlank(rows[end - 1])) end -= 1;
  if (rows.length - end > max) rows.length = end + max;
  return rows.join('\n') + (hadNL ? '\n' : '');
}
