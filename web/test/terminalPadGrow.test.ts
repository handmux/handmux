// Regression guard for the "new window, short content, cursor at bottom, content stranded mid-grid"
// bug. Terminal seeds bottom-aligned padding against term.rows AT SEED TIME, then fit() grows the grid
// to fill the container AFTER the seed — so short content padded for the pre-fit row count ends up
// mid-grid with the cursor at the grown bottom, until a repaint re-pads it ("type to fix"). The fix
// (reframeForRows in Terminal.tsx) re-pads for the FINAL row count once fit settles. These headless
// assertions capture the xterm buffer geometry the fix depends on (per CLAUDE.md: verify real bytes).
import { describe, it, expect } from 'vitest';
import xterm from '@xterm/headless';
import { prepareSeed } from '../src/terminalSeed.js';
import { bottomPadRows } from '../src/terminalViewport.js';

const { Terminal } = xterm;
type HeadlessTerminal = InstanceType<typeof Terminal>;
const write = (terminal: HeadlessTerminal, data: string): Promise<void> => (
  new Promise((resolve) => terminal.write(data, resolve))
);
const rowFromBottom = (terminal: HeadlessTerminal, offset: number): string | undefined => {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.viewportY + terminal.rows - 1 - offset)
    ?.translateToString(true).trimEnd();
};

describe('short-content bottom-pad survives a fit grow', () => {
  const seed = prepareSeed('r0\nr1\nr2\n'); // 3 content rows; r2 is the live prompt row
  const contentRows = 3;
  const seedFramed = (rows: number): string => (
    '\x1b[2J\x1b[3J\x1b[H' + '\n'.repeat(bottomPadRows(contentRows, rows)) + seed
  );

  it('padding for the seed-time rows bottom-aligns the prompt', async () => {
    const t = new Terminal({ cols: 12, rows: 24, allowProposedApi: true, scrollback: 200 });
    await write(t, seedFramed(24));
    expect(rowFromBottom(t, 0)).toBe('r2'); // prompt flush with the grid bottom
    t.dispose();
  });

  it('WITHOUT re-pad: growing the grid strands the prompt above a blank bottom row (the bug)', async () => {
    const t = new Terminal({ cols: 12, rows: 24, allowProposedApi: true, scrollback: 200 });
    await write(t, seedFramed(24));
    t.resize(12, 40); t.scrollToBottom(); // fit grows the grid, no re-pad
    expect(rowFromBottom(t, 0)).not.toBe('r2'); // bottom row is now blank → prompt mid-grid, cursor below it
    t.dispose();
  });

  it('WITH re-pad for the grown rows: the prompt is flush with the bottom again (the fix)', async () => {
    const t = new Terminal({ cols: 12, rows: 24, allowProposedApi: true, scrollback: 200 });
    await write(t, seedFramed(24));
    t.resize(12, 40);
    await write(t, seedFramed(40)); // reframeForRows: re-pad for the FINAL row count
    t.scrollToBottom();
    expect(rowFromBottom(t, 0)).toBe('r2');
    t.dispose();
  });
});
