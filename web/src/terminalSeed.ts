// `tmux capture-pane -p` separates lines with a bare LF (`\n`). xterm.js is configured
// with convertEol:false, so a bare LF moves the cursor DOWN without returning to column 0,
// producing a "staircase" where each line marches right. Normalize to CRLF.
export function normalizeSeedNewlines(ansi: string): string {
  return ansi.replace(/\r?\n/g, '\r\n');
}

// Walk one captured line, tracking whether a non-default background is active, and report what we
// find. The server captures with -e (SGR escapes) and -N (trailing whitespace preserved), so a
// highlighted row keeps its full-width padding and the SGR state flows line to line.
//   bgEnd       — is a non-default background active at the line's end (flows to the next line)?
//   hasText     — any non-whitespace character on the line?
//   hasShadeText— any non-whitespace character drawn while the background was active?
//   hasShadeBlank—any cell (incl. blanks) painted while the background was active. This catches a
//                 padding row that opens AND closes its background within the row (so neither
//                 bgStart nor bgEnd is set, yet it still renders as a full-width grey bar).
interface AnalyzedLine {
  bgEnd: boolean;
  hasText: boolean;
  hasShadeText: boolean;
  hasShadeBlank: boolean;
}

function analyzeLine(line: string, bgStart: boolean): AnalyzedLine {
  let bg = bgStart;
  let hasText = false;
  let hasShadeText = false;
  let hasShadeBlank = false;
  const note = (chunk: string): void => {
    if (/\S/.test(chunk)) { hasText = true; if (bg) hasShadeText = true; }
    if (bg && chunk.length) hasShadeBlank = true;
  };
  const sgr = /\x1b\[([0-9;]*)m/g;
  let idx = 0;
  let m = sgr.exec(line);
  while (m) {
    note(line.slice(idx, m.index));
    idx = sgr.lastIndex;
    const ps = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < ps.length; i += 1) {
      const p = ps[i];
      if (p === 0 || p === 49) bg = false; // reset-all / default background
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) bg = true; // 8/16-colour bg
      else if (p === 38 || p === 48) {
        // extended colour: 5;n (256) or 2;r;g;b (truecolor). Skip its args either way so a fg
        // colour's numbers can't be misread as a background.
        const isBg = p === 48;
        if (ps[i + 1] === 5) { i += 2; if (isBg) bg = true; } else if (ps[i + 1] === 2) { i += 4; if (isBg) bg = true; }
      }
    }
    m = sgr.exec(line);
  }
  note(line.slice(idx));
  return { bgEnd: bg, hasText, hasShadeText, hasShadeBlank };
}

// The server makes an ambiguous blank row's real tmux background explicit: Codex padding starts with
// its own background SGR, while Claude spacing starts with 49 (default). Preserve one genuinely shaded
// lower-padding row, but strip additional inherited blanks so an unclosed background cannot wash down.
//
// We classify each line against the flowing background state:
//   - has shaded text          → a real content row: keep it, and keep any blank rows held before it.
//   - blank cells actually shaded → hold the row (could be an interior gap or bottom padding).
//   - blank row that first resets bg → end the run on the PREVIOUS row, before LF can BCE-paint it.
//   - anything else (plain row) → keep the first held row as bottom padding, clear any extras.
//
// Closing the kept row is essential: xterm scrolls while we write a tall seed
// into a shorter viewport, and a scroll erases the newly-exposed bottom row with the CURRENT
// background (BCE). Append \x1b[49m to the bottom padding itself so it stays shaded but the following
// row cannot inherit the background.
export function trimTrailingShadow(lines: string[]): string[] {
  const out: string[] = [];
  let bgOpen = false;
  let held: Array<{ line: string; bgEnd: boolean }> = [];
  let lastShaded = -1;        // index in `out` of the run's most recent shaded text row
  let lastShadedOpen = false; // did that row leave a non-default bg open at its end?
  const closeRun = (): void => {
    if (held.length) {
      // The closest blank row is the box's real lower padding. Seal it at its own end; closing the
      // preceding text row would erase the inherited shade before this row is drawn.
      out.push(`${held[0].line}${held[0].bgEnd ? '\x1b[49m' : ''}`);
      for (let i = 1; i < held.length; i += 1) out.push('');
    } else if (lastShaded >= 0 && lastShadedOpen) {
      out[lastShaded] += '\x1b[49m';
    }
    held = [];
    lastShaded = -1;
    lastShadedOpen = false;
  };
  const keepInteriorHeld = (): void => {
    if (!held.length) return;
    out.push(...held.map(({ line }) => line));
    held = [];
  };
  for (const line of lines) {
    const a = analyzeLine(line, bgOpen);
    if (a.hasShadeText) {
      keepInteriorHeld(); // blanks held before this text row were interior gaps — keep them shaded
      out.push(line);
      lastShaded = out.length - 1;
      lastShadedOpen = a.bgEnd;
    } else if (!a.hasText && (a.bgEnd || a.hasShadeBlank)) {
      held.push({ line, bgEnd: a.bgEnd }); // blank row while shaded — defer the decision
    } else {
      closeRun(); // a plain row ends the shaded run — keep one bottom-padding row and seal its bg
      out.push(line);
    }
    bgOpen = a.bgEnd;
  }
  closeRun();
  return out;
}

// Prepare a capture-pane snapshot for writing into xterm. capture-pane terminates EVERY
// row with \n — including a trailing one after the bottom row. Written verbatim, that
// trailing newline adds an extra blank line and shifts the whole visible screen up by one
// row. capture-pane always returns exactly `height` rows, so dropping just that single
// trailing newline makes the screen occupy xterm's bottom `height` rows exactly.
//
// Then drop the shade from blank rows that trail a highlight (see trimTrailingShadow) so a sent
// message shades only its text, not the box padding below it.
export function prepareSeed(ansi: string): string {
  const body = normalizeSeedNewlines(ansi.replace(/\n$/, ''));
  return trimTrailingShadow(body.split('\r\n')).join('\r\n');
}

// A live %output stream addresses the source pane's exact grid. Keep any captured scrollback ABOVE that
// grid so xterm can browse history immediately, while restoring plain blank rows when snapshot cleanup
// leaves fewer than the pane's visible row count.
export function prepareLiveSeed(ansi: string, rows: number): string {
  const lines = prepareSeed(ansi).split('\r\n');
  const target = Math.max(1, Number(rows) || 1);
  while (lines.length < target) lines.push('');
  return lines.join('\r\n');
}

// The escape string that places xterm's OWN cursor on Claude's input cell (or hides it). capture-pane
// snapshots cells only — not the terminal cursor — so without this xterm parks its cursor at the end
// of the seed (a stray box at the bottom-left). tmux tracks the cursor separately; the server hands it
// over as { row, col, vis }:
//   row — rows ABOVE the bottom of the visible screen the cursor sits on (0 = the bottom row)
//   col — 0-based column
//   vis — is the cursor visible (Claude shows it while accepting input, hides it while working)
// This is applied as a SEPARATE write AFTER the grid is sized + scrolled to the bottom — NEVER inside
// the seed — because a cursor parked mid-buffer makes a later term.resize() (fit, on a window switch)
// reflow content into scrollback and leave the screen half-blank for a poll. We address it ABSOLUTELY
// via CUP so it's correct at any grid height and can be re-applied verbatim after a resize. Hidden
// (DECTCEM) when not visible or unknown — so no stray box ever shows.
//
// `cur.row` counts up from the BOTTOM OF THE SEED CONTENT, but the seed is written from the buffer TOP
// (\x1b[H). When the content is shorter than the grid (a sparse pane / fresh shell: the prompt plus a
// few rows, with blank rows below), it sits at the TOP with blanks under it — so we must count from the
// content's last row, i.e. min(rows, seedRows), or the cursor lands on the empty grid bottom instead of
// on the prompt. When the content fills/overflows the grid, seedRows ≥ rows and this is the plain
// viewport-bottom count (unchanged). seedRows = 0 (unknown) ⇒ fall back to the bare viewport bottom.
// `force` overrides the app's DECTCEM-hide (cur.vis === false): after the user sends a key/command we
// briefly light the block at the cursor's real position even if the app has it hidden, so operating the
// terminal always shows WHERE you're operating (see forceCursorRef in Terminal.jsx). We still need cur
// (row/col) — tmux reports position even while the cursor is hidden — so a genuinely absent cur stays hidden.
export function cursorSeq(
  cur: TerminalCursor | null | undefined,
  rows: number,
  seedRows = 0,
  force = false,
): string {
  if (!cur || (!cur.vis && !force)) return '\x1b[?25l';
  const base = seedRows ? Math.min(rows | 0, seedRows | 0) : (rows | 0);
  const row = Math.max(1, base - Math.max(0, cur.row | 0)); // 1-based, from the content's bottom row
  const col = Math.max(0, (cur.col ?? 0) | 0) + 1; // CUP is 1-based
  return `\x1b[${row};${col}H\x1b[?25h`;
}
import type { TerminalCursor } from './terminalViewport.js';
