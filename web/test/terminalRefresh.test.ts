import { describe, it, expect } from 'vitest';
import xterm from '@xterm/headless';
import { prepareSeed, prepareLiveSeed, cursorSeq } from '../src/terminalSeed.js';

const { Terminal } = xterm;
type HeadlessTerminal = InstanceType<typeof Terminal>;
const write = (terminal: HeadlessTerminal, data: string): Promise<void> => (
  new Promise((resolve) => terminal.write(data, resolve))
);
const line = (terminal: HeadlessTerminal, row: number): string | undefined => (
  terminal.buffer.active.getLine(row)?.translateToString(true).trimEnd()
);

describe('prepareSeed alignment', () => {
  it('keeps live history in scrollback while the latest pane grid stays visible', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true, scrollback: 100 });
    const seed = prepareLiveSeed('h0\nh1\nr0\nr1\nr2\n', 3);
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + seed);
    t.scrollToBottom();

    expect(t.buffer.active.baseY).toBe(2);
    expect(line(t, 0)).toBe('h0');
    expect(line(t, 1)).toBe('h1');
    expect(line(t, t.buffer.active.baseY)).toBe('r0');
    expect(line(t, t.buffer.active.baseY + 2)).toBe('r2');
    t.dispose();
  });

  it('aligns the visible screen to the bottom rows (drops the trailing-newline shift)', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true, scrollback: 100 });
    // 1 scrollback line + a 3-row screen + capture-pane's trailing newline.
    await write(t, prepareSeed('old\nr0\nr1\nr2\n'));
    const base = t.buffer.active.baseY;
    expect(line(t, base + 0)).toBe('r0'); // visible top aligns to r0, not r1 (the old bug)
    expect(line(t, base + 1)).toBe('r1');
    expect(line(t, base + 2)).toBe('r2');
    t.dispose();
  });

  it('full-replace refresh clears the old buffer instead of accumulating', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true, scrollback: 100 });
    await write(t, prepareSeed('a0\na1\na2\na3\na4\n'));
    // the exact sequence Terminal uses each refresh: clear screen + scrollback, home, repaint
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('b0\nb1\nb2\nb3\nb4\n'));
    expect(t.buffer.active.length).toBe(5); // not 10 — old a* lines were cleared
    expect(line(t, 0)).toBe('b0'); // oldest scroll-up line is b0, not a0
    expect(line(t, 4)).toBe('b4');
    t.dispose();
  });

  it('anchors the viewport to the same content when more history is pulled in above', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true, scrollback: 100 });
    // small live window: n5..n9, then user scrolls to the very top
    await write(t, prepareSeed('n5\nn6\nn7\nn8\nn9\n'));
    t.scrollToLine(0);
    const anchorFromBottom = t.buffer.active.length - t.buffer.active.viewportY; // 5 - 0 = 5

    // reaching the top pulls a deeper slice: n0..n9 (10 lines), repainted
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('n0\nn1\nn2\nn3\nn4\nn5\nn6\nn7\nn8\nn9\n'));
    t.scrollToLine(Math.max(0, t.buffer.active.length - anchorFromBottom)); // 10 - 5 = 5

    // the line that was at the top before (n5) is at the top again — seamless "load more above"
    expect(line(t, t.buffer.active.viewportY)).toBe('n5');
    t.dispose();
  });

  it('lets a multi-line highlight flow across its rows and stops where the capture closes it', async () => {
    const t = new Terminal({ cols: 10, rows: 5, allowProposedApi: true, scrollback: 100 });
    // capture-pane -e -N style: a background is opened and flows across a text row and a blank row
    // (which -N keeps as real spaces, so they carry the bg), then the pane's own reset (\x1b[49m)
    // closes it. Every row of the highlight must stay shaded (the multi-line case), and the row
    // after the close must NOT inherit it (no bleed down).
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('\x1b[41mline1\n     \nlast\x1b[49m\nplain\n'));
    const b = t.buffer.active;
    const bgAt = (row: number, col: number): boolean => {
      const cell = b.getLine(row)?.getCell(col);
      return !!(cell && (cell.getBgColorMode() !== 0 || cell.isInverse()));
    };
    expect(bgAt(0, 0)).toBe(true); // line1 is highlighted
    expect(bgAt(1, 0)).toBe(true); // the blank middle row (spaces) keeps the background (flow)
    expect(bgAt(2, 0)).toBe(true); // 'last' is still highlighted
    expect(bgAt(3, 0)).toBe(false); // after \x1b[49m the plain row is NOT shaded (no bleed)
    expect(bgAt(3, 9)).toBe(false);
    t.dispose();
  });

  it('keeps the complete three-row message box: top padding, text, and bottom padding', async () => {
    const t = new Terminal({ cols: 10, rows: 5, allowProposedApi: true, scrollback: 100 });
    // Codex capture -e -N style: a full-width top padding row, the user text, a full-width bottom
    // padding row, then the next plain line closes the background.
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('\x1b[48;5;237m          \n❯ hi      \n          \n\x1b[49mout\n'));
    const b = t.buffer.active;
    const bgAt = (row: number, col: number): boolean => {
      const cell = b.getLine(row)?.getCell(col);
      return !!(cell && (cell.getBgColorMode() !== 0 || cell.isInverse()));
    };
    expect(bgAt(0, 0)).toBe(true); // top padding
    expect(bgAt(0, 9)).toBe(true);
    expect(bgAt(1, 0)).toBe(true); // user text
    expect(bgAt(1, 9)).toBe(true);
    expect(bgAt(2, 0)).toBe(true); // bottom padding
    expect(bgAt(2, 9)).toBe(true);
    expect(bgAt(3, 0)).toBe(false); // following plain output unaffected
    t.dispose();
  });

  it('keeps Claude one-line shading off its real default blank row when the seed scrolls (BCE)', async () => {
    // The server resolves capture-pane's cross-line SGR ambiguity by independently reading the blank
    // row. Claude's row is default, so it arrives with an explicit 49 before its spaces. A short
    // viewport forces seed scrolling and exercises BCE: the reset must land before the scroll can
    // paint the blank row with the message background.
    const t = new Terminal({ cols: 10, rows: 3, allowProposedApi: true, scrollback: 100 });
    const cap = 'x0\nx1\n\x1b[48;5;237m❯ hi\x1b[39m   \n\x1b[49m\nout\n';
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed(cap));
    const b = t.buffer.active;
    const bgAt = (row: number, col: number): boolean => {
      const cell = b.getLine(row)?.getCell(col);
      return !!(cell && (cell.getBgColorMode() !== 0 || cell.isInverse()));
    };
    expect(bgAt(2, 0)).toBe(true);  // the message row stays shaded
    expect(bgAt(3, 0)).toBe(false); // Claude's spacing row is truly default
    expect(bgAt(3, 9)).toBe(false);
    expect(bgAt(4, 0)).toBe(false); // following output also remains plain
    expect(bgAt(4, 9)).toBe(false);
    t.dispose();
  });

  it('places the cursor on Claude\'s cell as a SEPARATE write after the seed + scroll (absolute CUP)', async () => {
    // The server hands the cursor over as {row,col,vis}; cursorSeq addresses it absolutely from the
    // viewport bottom. 5-row screen, cursor 2 rows up (on 'r2') at column 3 → cursorY=2, cursorX=3.
    const t = new Terminal({ cols: 12, rows: 5, allowProposedApi: true, scrollback: 100 });
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('r0\nr1\nr2XX\nr3\nr4\n'));
    t.scrollToBottom();
    await write(t, cursorSeq({ row: 2, col: 3, vis: true }, t.rows));
    const b = t.buffer.active;
    expect(b.cursorY).toBe(2); // on the r2 row, not parked at the bottom (the stray-box bug)
    expect(b.cursorX).toBe(3); // column 3 (0-based)
    expect(line(t, b.baseY + b.cursorY)).toBe('r2XX');
    t.dispose();
  });

  it('places the cursor ON the content (top), not the empty grid bottom, when the pane is sparse', async () => {
    // Fresh shell / sparse pane: a 2-row seed (prompt + a line) written top-anchored into a taller
    // 6-row grid leaves 4 blank rows BELOW. cur.row counts up from the seed's last row (the prompt),
    // so passing seedRows=2 lands the cursor on row 1 ('p1'), NOT at row 5 (the stranded-at-bottom bug).
    const t = new Terminal({ cols: 12, rows: 6, allowProposedApi: true, scrollback: 100 });
    const seed = prepareSeed('p0\np1\n');
    const seedRows = seed.split('\n').length; // 2 — same count Terminal.tsx computes
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + seed);
    t.scrollToBottom();
    await write(t, cursorSeq({ row: 0, col: 0, vis: true }, t.rows, seedRows));
    const b = t.buffer.active;
    expect(b.cursorY).toBe(1); // on 'p1' (the prompt), with the content — not row 5 at the blank bottom
    expect(line(t, b.baseY + b.cursorY)).toBe('p1');
    // Without the seedRows fix the old 2-arg form would strand it at the bottom:
    await write(t, cursorSeq({ row: 0, col: 0, vis: true }, t.rows));
    expect(t.buffer.active.cursorY).toBe(5); // demonstrates the bug the fix avoids
    t.dispose();
  });

  it('a grid GROW with the cursor at the bottom does NOT push content into scrollback (the top-half bug)', async () => {
    // The regression: cursorSeq used to park the cursor mid-buffer inside the seed, so fit()'s
    // term.resize() (window switch) reflowed content into scrollback → a half-blank screen. The fix
    // keeps the cursor at the bottom for the resize; content then stays compact (no scrollback push).
    const t = new Terminal({ cols: 12, rows: 4, allowProposedApi: true, scrollback: 500 });
    await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed('a0\na1\na2\na3\na4\na5\n')); // 6 rows into 4-row grid
    t.scrollToBottom();
    await write(t, `\x1b[${t.rows};1H`); // fit parks the cursor at the bottom before resizing
    t.resize(12, 10); // grow the grid (smaller font / taller pane)
    t.scrollToBottom();
    // 6 content rows in a 10-row grid: compact buffer (no rows shoved into scrollback), content at top.
    expect(t.buffer.active.length).toBe(10);
    expect(t.buffer.active.baseY).toBe(0);
    expect(line(t, 0)).toBe('a0');
    t.dispose();
  });

  it('does not accumulate buffer lines across many refreshes (bounded memory)', async () => {
    const t = new Terminal({ cols: 12, rows: 3, allowProposedApi: true, scrollback: 5100 });
    const frame = 'l0\nl1\nl2\nl3\nl4\n'; // a 5-line snapshot
    for (let i = 0; i < 500; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await write(t, '\x1b[2J\x1b[3J\x1b[H' + prepareSeed(frame));
    }
    // 500 refreshes of a 5-line frame must NOT grow to ~2500 lines — the clear keeps it bounded
    expect(t.buffer.active.length).toBeLessThanOrEqual(6);
    t.dispose();
  });
});
