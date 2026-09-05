import { describe, expect, it } from 'vitest';
import {
  normalizeSeedNewlines, prepareSeed, prepareLiveSeed, trimTrailingShadow, cursorSeq,
} from '../src/terminalSeed.js';

describe('normalizeSeedNewlines', () => {
  it('converts bare LF to CRLF (fixes the staircase)', () => {
    expect(normalizeSeedNewlines('a\nb\nc')).toBe('a\r\nb\r\nc');
  });
  it('leaves existing CRLF unchanged (idempotent)', () => {
    expect(normalizeSeedNewlines('a\r\nb')).toBe('a\r\nb');
  });
  it('handles mixed endings', () => {
    expect(normalizeSeedNewlines('a\r\nb\nc')).toBe('a\r\nb\r\nc');
  });
  it('preserves ANSI color escapes around newlines', () => {
    expect(normalizeSeedNewlines('\x1b[31mred\x1b[0m\nplain')).toBe('\x1b[31mred\x1b[0m\r\nplain');
  });
  it('returns empty string unchanged', () => {
    expect(normalizeSeedNewlines('')).toBe('');
  });
});

describe('prepareSeed', () => {
  it('drops the single trailing newline and converts to CRLF, writing the rest verbatim', () => {
    expect(prepareSeed('a\nb\nc\n')).toBe('a\r\nb\r\nc');
  });
  it('keeps interior/blank rows (only the trailing artifact is removed)', () => {
    expect(prepareSeed('a\n\nb\n')).toBe('a\r\n\r\nb');
  });
  it('handles input without a trailing newline', () => {
    expect(prepareSeed('a\nb')).toBe('a\r\nb');
  });
  it('does not inject fills or resets — the -N capture is written faithfully', () => {
    // capture-pane -e -N: bg set, padding preserved, background closed by the pane's own reset.
    expect(prepareSeed('\x1b[48;5;237mmsg   \x1b[49m\nnext\n'))
      .toBe('\x1b[48;5;237mmsg   \x1b[49m\r\nnext');
  });
});

describe('prepareLiveSeed', () => {
  it('restores the exact pane height after snapshot cleanup drops trailing padding', () => {
    const seed = prepareLiveSeed('one\n\n', 3);
    expect(seed.split('\r\n')).toEqual(['one', '', '']);
  });

  it('keeps captured history above the pane grid', () => {
    const seed = prepareLiveSeed('history\nscreen-1\nscreen-2\n', 2);
    expect(seed.split('\r\n')).toEqual(['history', 'screen-1', 'screen-2']);
  });
});

describe('trimTrailingShadow', () => {
  it('keeps one shaded bottom-padding row and seals the run bg there', () => {
    // text row (bg left open), blank padding row, then a plain row (bg reset by the pane). The run's
    // bottom-padding row gets \x1b[49m so scroll-BCE cannot shade the following plain row.
    const out = trimTrailingShadow(['\x1b[48;5;237m❯ hi\x1b[39m   ', '\x1b[48;5;237m   ', '\x1b[49mplain']);
    expect(out).toEqual(['\x1b[48;5;237m❯ hi\x1b[39m   ', '\x1b[48;5;237m   \x1b[49m', '\x1b[49mplain']);
  });

  it('keeps a blank row that sits BETWEEN two highlighted text rows', () => {
    const out = trimTrailingShadow([
      '\x1b[48;5;237mline1', '\x1b[48;5;237m   ', '\x1b[48;5;237mline2\x1b[49m', '\x1b[49mafter',
    ]);
    expect(out).toEqual([
      '\x1b[48;5;237mline1', '\x1b[48;5;237m   ', '\x1b[48;5;237mline2\x1b[49m', '\x1b[49mafter',
    ]);
  });

  it('keeps one trailing blank highlight row at end-of-capture', () => {
    const out = trimTrailingShadow(['\x1b[48;5;237m❯ hi\x1b[39m', '\x1b[48;5;237m   ', '']);
    expect(out).toEqual(['\x1b[48;5;237m❯ hi\x1b[39m', '\x1b[48;5;237m   \x1b[49m', '']);
  });

  it('keeps a padding row that explicitly opens and closes its own bg', () => {
    // The sent-message box draws its bottom padding as a self-contained grey bar: the bg is set
    // and reset on the same row, so neither the previous nor this row leaves bg flowing. It must
    // still be recognised as the real blank bottom-padding row and kept.
    const out = trimTrailingShadow([
      '\x1b[48;5;237m❯ hi\x1b[49m', '\x1b[48;5;237m   \x1b[49m', 'plain',
    ]);
    expect(out).toEqual([
      '\x1b[48;5;237m❯ hi\x1b[49m',
      '\x1b[48;5;237m   \x1b[49m',
      'plain',
    ]);
  });

  it('keeps a self-contained shaded padding row at end-of-capture', () => {
    const out = trimTrailingShadow(['\x1b[48;5;237m❯ hi\x1b[49m', '\x1b[48;5;237m   \x1b[49m']);
    expect(out).toEqual([
      '\x1b[48;5;237m❯ hi\x1b[49m',
      '\x1b[48;5;237m   \x1b[49m',
    ]);
  });

  it('clears extra inherited shaded blanks after preserving the first bottom-padding row', () => {
    const out = trimTrailingShadow([
      '\x1b[48;5;237m❯ hi',
      '   ',
      '   ',
      '\x1b[49mplain',
    ]);
    expect(out).toEqual([
      '\x1b[48;5;237m❯ hi',
      '   \x1b[49m',
      '',
      '\x1b[49mplain',
    ]);
  });

  it('leaves plain (un-highlighted) text untouched', () => {
    expect(trimTrailingShadow(['hello', '', 'world'])).toEqual(['hello', '', 'world']);
  });
});

describe('cursorSeq', () => {
  it('addresses the cell ABSOLUTELY from the viewport bottom (CUP rows-row;col+1), then shows it', () => {
    // 24-row viewport, cursor 2 rows above the bottom, column 3 (0-based) → CUP row 22, col 4
    expect(cursorSeq({ row: 2, col: 3, vis: true }, 24)).toBe('\x1b[22;4H\x1b[?25h');
  });
  it('puts the cursor on the bottom row when row is 0', () => {
    expect(cursorSeq({ row: 0, col: 0, vis: true }, 24)).toBe('\x1b[24;1H\x1b[?25h');
  });
  it('keeps the cursor hidden when tmux reports it hidden', () => {
    expect(cursorSeq({ row: 4, col: 2, vis: false }, 24)).toBe('\x1b[?25l');
  });
  it('hides the cursor when the server sent nothing (graceful fallback, never the stray box)', () => {
    expect(cursorSeq(undefined, 24)).toBe('\x1b[?25l');
    expect(cursorSeq(null, 24)).toBe('\x1b[?25l');
  });
  it('clamps the row to the top of the viewport when it would land above it', () => {
    expect(cursorSeq({ row: 30, col: 5, vis: true }, 24)).toBe('\x1b[1;6H\x1b[?25h'); // 24-30 < 1 → row 1
  });
  it('counts from the SEED content bottom, not the viewport, when content is shorter than the grid', () => {
    // Sparse pane: a 24-row grid holds only a 2-row seed (top-anchored, 22 blank rows below). A fresh
    // shell's cursor sits on the prompt (row 0 = the seed's last row) → CUP row 2, NOT row 24 (the empty
    // grid bottom). This is the fix for "content at top, cursor stranded at the bottom".
    expect(cursorSeq({ row: 0, col: 0, vis: true }, 24, 2)).toBe('\x1b[2;1H\x1b[?25h');
    // One row up within the seed → CUP row 1.
    expect(cursorSeq({ row: 1, col: 0, vis: true }, 24, 2)).toBe('\x1b[1;1H\x1b[?25h');
  });
  it('ignores seedRows once the content fills/overflows the grid (counts from the viewport bottom)', () => {
    // seedRows ≥ rows → min(rows, seedRows) === rows, so it matches the plain 2-arg behaviour.
    expect(cursorSeq({ row: 2, col: 3, vis: true }, 24, 40)).toBe('\x1b[22;4H\x1b[?25h');
    expect(cursorSeq({ row: 2, col: 3, vis: true }, 24, 24)).toBe('\x1b[22;4H\x1b[?25h');
  });
});
