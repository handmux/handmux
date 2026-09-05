// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  createTerminalStreamMirror,
  type TerminalStreamMirror,
  type TerminalStreamSnapshot,
} from '../src/terminalStreamMirror.js';
import { cursorSeq } from '../src/terminalSeed.js';

const encoder = new TextEncoder();
const bytes = (data: string): Uint8Array => encoder.encode(data);
const write = (term: Terminal, data: string | Uint8Array): Promise<void> => (
  new Promise((resolve) => term.write(data, resolve))
);
const textAt = (term: Terminal, line: number): string | undefined => (
  term.buffer.active.getLine(line)?.translateToString(true).trimEnd()
);
const visibleText = (term: Terminal): Array<string | undefined> => {
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, row) => textAt(term, buffer.viewportY + row));
};
const shadedAt = (term: Terminal, line: number, col = 0): boolean => {
  const cell = term.buffer.active.getLine(line)?.getCell(col);
  return !!(cell && (cell.getBgColorMode() !== 0 || cell.isInverse()));
};

const snapshot = (mirror: TerminalStreamMirror): TerminalStreamSnapshot => {
  const frame = mirror.snapshot();
  if (!frame) throw new Error('terminal stream mirror is not ready');
  return frame;
};

const create = () => createTerminalStreamMirror({
  scrollback: 100,
  TerminalCtor: Terminal,
  SerializeAddonCtor: SerializeAddon,
});

describe('terminal stream mirror', () => {
  it('uses the production xterm core without opening a DOM renderer', async () => {
    const mirror = createTerminalStreamMirror({ scrollback: 100 });
    await mirror.seed({
      ansi: 'history\nshell\n',
      width: 12,
      height: 1,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 5, vis: true });

    expect(mirror.snapshot()).toMatchObject({
      boundaryLine: 1,
      bufferRows: 2,
      paneRows: 1,
      paneCols: 12,
      cursorVisible: true,
    });
    mirror.dispose();
  });

  it('keeps raw cursor addressing pane-exact while one taller terminal restores history and cursor atomically', async () => {
    const mirror = create();
    await mirror.seed({
      ansi: 'h0\nh1\nr0\nr1\nr2\n',
      width: 12,
      height: 3,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 1, col: 2, vis: true });
    // CUP is interpreted by the exact 3-row parser, not by the taller visible terminal.
    await mirror.data(bytes('\x1b[3;5H!'));

    const frame = snapshot(mirror);
    const visible = new Terminal({ cols: 12, rows: 6, allowProposedApi: true, scrollback: 100 });
    const pad = '\r\n'.repeat(visible.rows - frame.bufferRows);
    await write(
      visible,
      `\x1b[?1049l\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H${pad}${frame.ansi}\x1b[?25h`,
    );

    expect(frame.boundaryLine).toBe(2);
    expect(frame.cursorVisible).toBe(true);
    expect(frame.cur).toEqual({ row: 0, col: 5, vis: true });
    expect(textAt(visible, 0)).toBe('');
    expect(textAt(visible, 1)).toBe('h0');
    expect(textAt(visible, 2)).toBe('h1');
    expect(textAt(visible, 3)).toBe('r0');
    expect(textAt(visible, 5)).toBe('r2  !');
    expect(visible.buffer.active.cursorY).toBe(5);
    expect(visible.buffer.active.cursorX).toBe(5);
    visible.dispose();
    mirror.dispose();
  });

  it('keeps the full parser state but bounds each visible repaint to one recent history page', async () => {
    const mirror = createTerminalStreamMirror({
      scrollback: 500,
      renderScrollback: 100,
      TerminalCtor: Terminal,
      SerializeAddonCtor: SerializeAddon,
    });
    const history = Array.from({ length: 250 }, (_, i) => `history-${String(i).padStart(3, '0')}`);
    await mirror.seed({
      ansi: [...history, 'live-0', 'live-1', 'live-2'].join('\n') + '\n',
      width: 20,
      height: 3,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 6, vis: true });

    const frame = snapshot(mirror);
    expect(frame.bufferRows).toBe(103);
    expect(frame.boundaryLine).toBe(100);
    expect(frame.ansi).not.toContain('history-000');
    expect(frame.ansi).toContain('history-249');
    expect(frame.ansi).toContain('live-2');
    mirror.dispose();
  });

  it('keeps sustained high-volume output bounded while snapshots follow the newest lines', async () => {
    const mirror = createTerminalStreamMirror({
      scrollback: 500,
      renderScrollback: 100,
      TerminalCtor: Terminal,
      SerializeAddonCtor: SerializeAddon,
    });
    await mirror.seed({
      ansi: Array.from({ length: 24 }, (_, i) => `boot-${i}`).join('\n') + '\n',
      width: 32,
      height: 24,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 0, vis: true });

    for (let batch = 0; batch < 200; batch += 1) {
      const output = Array.from(
        { length: 100 },
        (_, line) => `load-${String(batch * 100 + line).padStart(5, '0')}`,
      ).join('\n') + '\n';
      // Simulate a busy pane arriving in network-sized chunks, with a repaint candidate per batch.
      // eslint-disable-next-line no-await-in-loop
      await mirror.data(bytes(output));
      const frame = snapshot(mirror);
      expect(frame.bufferRows).toBeLessThanOrEqual(124);
    }

    const frame = snapshot(mirror);
    expect(frame.ansi).not.toContain('load-00000');
    expect(frame.ansi).toContain('load-19999');
    expect(frame.bufferRows).toBeLessThanOrEqual(124);
    mirror.dispose();
  });

  it('bottom-aligns a sparse tall pane without changing its exact live parser grid', async () => {
    const mirror = createTerminalStreamMirror({
      scrollback: 500,
      renderScrollback: 100,
      TerminalCtor: Terminal,
      SerializeAddonCtor: SerializeAddon,
    });
    const history = Array.from({ length: 100 }, (_, i) => `history-${i}`);
    await mirror.seed({
      ansi: [...history, 'prompt', ...Array(59).fill('')].join('\n') + '\n',
      width: 20,
      height: 60,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 59, col: 6, vis: true });

    const frame = snapshot(mirror);
    expect(frame).toMatchObject({
      bufferRows: 104,
      boundaryLine: 100,
      cur: { row: 3, col: 6, vis: true },
    });
    const visible = new Terminal({ cols: 20, rows: 20, allowProposedApi: true, scrollback: 500 });
    const pad = Math.max(0, visible.rows - frame.bufferRows);
    await write(visible, `\x1b[2J\x1b[3J\x1b[H${'\r\n'.repeat(pad)}${frame.ansi}${cursorSeq(frame.cur, visible.rows, frame.bufferRows + pad)}`);
    visible.scrollToBottom();
    expect(visibleText(visible).slice(-4)).toEqual(['prompt', '', '', '']);
    expect(visible.buffer.active.cursorY).toBe(16);
    expect(visible.buffer.active.cursorX).toBe(6);

    const tallVisible = new Terminal({ cols: 20, rows: 120, allowProposedApi: true, scrollback: 500 });
    const tallPad = tallVisible.rows - frame.bufferRows;
    await write(tallVisible, `\x1b[2J\x1b[3J\x1b[H${'\r\n'.repeat(tallPad)}${frame.ansi}${cursorSeq(frame.cur, tallVisible.rows, frame.bufferRows + tallPad)}`);
    tallVisible.scrollToBottom();
    expect(visibleText(tallVisible).slice(-4)).toEqual(['prompt', '', '', '']);
    expect(tallVisible.buffer.active.cursorY).toBe(116);

    // A later pane-addressed write still targets row 60 in the untouched hidden parser. If the seed
    // itself had been trimmed, this would overwrite the wrong row instead of expanding the projection.
    await mirror.data(bytes('\x1b[60;1Hbottom'));
    const expanded = snapshot(mirror);
    expect(expanded).toMatchObject({
      bufferRows: 160,
      cur: { row: 0, col: 6, vis: true },
    });
    expect(expanded.ansi).toContain('bottom');
    visible.dispose();
    tallVisible.dispose();
    mirror.dispose();
  });

  it('does not trim a styled blank at the bottom of the live grid', async () => {
    const mirror = create();
    await mirror.seed({
      ansi: [
        'prompt',
        ...Array(53).fill(''),
        '\x1b[48;5;237m          ',
        '\x1b[49m',
        ...Array(4).fill(''),
      ].join('\n') + '\n',
      width: 10,
      height: 60,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 59, col: 6, vis: true });

    const frame = snapshot(mirror);
    expect(frame).toMatchObject({ bufferRows: 58, cur: { row: 57, col: 6, vis: true } });
    const visible = new Terminal({ cols: 10, rows: 60, allowProposedApi: true, scrollback: 100 });
    await write(visible, frame.ansi);
    expect(shadedAt(visible, 54, 0)).toBe(true);
    mirror.dispose();
    visible.dispose();
  });

  it('publishes cursor visibility, mouse mode and alternate-screen state from the same revision', async () => {
    const mirror = create();
    await mirror.seed({
      ansi: 'shell\n',
      width: 12,
      height: 3,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 0, vis: true });
    await mirror.data(bytes('\x1b[?25l\x1b[?1000h\x1b[?1049h\x1b[Happ'));

    const frame = snapshot(mirror);
    expect(frame.alt).toBe(true);
    expect(frame.cursorVisible).toBe(false);
    expect(frame.cur).toEqual({ row: 2, col: 3, vis: false });
    expect(frame.mouseAware).toBe(true);
    expect(frame.boundaryLine).toBeNull();
    mirror.dispose();
  });

  it('publishes the normal-screen cursor from every immutable revision', async () => {
    const mirror = create();
    await mirror.seed({
      ansi: 'shell\n',
      width: 12,
      height: 3,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 0, vis: true });

    const before = snapshot(mirror);
    await mirror.data(bytes('\x1b[3;5H'));
    const after = snapshot(mirror);

    expect(before.cur).toEqual({ row: 0, col: 0, vis: true });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.cur).toEqual({ row: 0, col: 4, vis: true });
    mirror.dispose();
  });

  it('preserves Codex bottom shading through serialization into a taller visible grid', async () => {
    const mirror = create();
    await mirror.seed({
      ansi: '\x1b[48;5;237m          \n❯ hi      \n          \n\x1b[49mout\n',
      width: 10,
      height: 4,
      alt: false,
      mouseAware: false,
    });
    await mirror.ready({ row: 0, col: 3, vis: true });
    const frame = snapshot(mirror);
    const visible = new Terminal({ cols: 10, rows: 6, allowProposedApi: true, scrollback: 100 });
    const pad = '\r\n'.repeat(visible.rows - frame.bufferRows);
    await write(visible, `\x1b[2J\x1b[3J\x1b[H${pad}${frame.ansi}`);

    expect(shadedAt(visible, 2, 0)).toBe(true);
    expect(shadedAt(visible, 3, 9)).toBe(true);
    expect(shadedAt(visible, 4, 0)).toBe(true);
    expect(shadedAt(visible, 5, 0)).toBe(false);
    visible.dispose();
    mirror.dispose();
  });

  it('starts a resync from a clean parser state', async () => {
    const frame = {
      ansi: 'h0\nh1\nr0\nr1\nr2\nr3\n',
      width: 8,
      height: 4,
      alt: false,
      mouseAware: false,
    };
    const reused = create();
    await reused.seed(frame);
    await reused.ready({ row: 3, col: 2, vis: true });
    // Full-screen terminal applications can leave private modes and scroll margins active.
    await reused.data(bytes('\x1b[2;3r\x1b[?6h\x1b[2;1Hdirty'));
    await reused.seed(frame);
    await reused.ready({ row: 3, col: 2, vis: true });

    const fresh = create();
    await fresh.seed(frame);
    await fresh.ready({ row: 3, col: 2, vis: true });

    const freshFrame = snapshot(fresh);
    expect(snapshot(reused)).toMatchObject({
      ansi: freshFrame.ansi,
      boundaryLine: freshFrame.boundaryLine,
      bufferRows: freshFrame.bufferRows,
    });
    reused.dispose();
    fresh.dispose();
  });
});
