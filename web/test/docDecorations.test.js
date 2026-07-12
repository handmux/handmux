import { describe, it, expect } from 'vitest';
import xterm from '@xterm/headless';
import { scanDocLinks, docLinksOnLine } from '../src/docDecorations.js';

const { Terminal } = xterm;
const write = (t, d) => new Promise((res) => t.write(d, res));

describe('scanDocLinks', () => {
  it('locates a doc path on a visible row with correct y/x/width/path', async () => {
    const t = new Terminal({ cols: 40, rows: 3, allowProposedApi: true, scrollback: 100 });
    await write(t, 'row0 has none\r\nsee /h/docs/a.md now\r\nrow2');
    const links = scanDocLinks(t);
    const base = t.buffer.active.baseY;
    // 'see ' 占 4 列起、'/h/docs/a.md' 长 12
    expect(links).toEqual([{ y: base + 1, x: 4, width: 12, path: '/h/docs/a.md' }]);
    t.dispose();
  });

  it('stitches a path wrapped across physical rows into one segment per row', async () => {
    // cols=20 forces '/aa/bb/cc/dd/ee/report.md' (25 chars, starting at col 5 after 'open ') to wrap.
    const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true, scrollback: 100 });
    await write(t, 'open /aa/bb/cc/dd/ee/report.md ok');
    const links = scanDocLinks(t);
    const base = t.buffer.active.baseY;
    const path = '/aa/bb/cc/dd/ee/report.md';
    expect(links).toEqual([
      { y: base + 0, x: 5, width: 15, path }, // cols 5..19 on the first row
      { y: base + 1, x: 0, width: 10, path }, // the remaining 10 chars on the wrapped row
    ]);
    // every segment carries the full path, and the widths sum to the path length
    expect(links.reduce((a, s) => a + s.width, 0)).toBe(path.length);
    t.dispose();
  });

  it('places columns correctly for a wide-char (CJK) filename', async () => {
    const t = new Terminal({ cols: 30, rows: 3, allowProposedApi: true, scrollback: 100 });
    await write(t, '看 报告.md done'); // 看(2 cols) + space + 报告(4 cols) + .md
    const base = t.buffer.active.baseY;
    // '报告.md' starts at col 3 ('看 ' = 3 cols) and spans 7 cells (报报告告..md = 2+2+1+1+1)
    expect(scanDocLinks(t)).toEqual([{ y: base, x: 3, width: 7, path: '报告.md' }]);
    t.dispose();
  });

  it('returns [] when no doc path is on screen', async () => {
    const t = new Terminal({ cols: 40, rows: 2, allowProposedApi: true, scrollback: 100 });
    await write(t, 'plain line\r\nanother one');
    expect(scanDocLinks(t)).toEqual([]);
    t.dispose();
  });
});

describe('docLinksOnLine', () => {
  it('returns a 1-based inclusive range for a path on a single line', async () => {
    const t = new Terminal({ cols: 40, rows: 3, allowProposedApi: true, scrollback: 100 });
    await write(t, 'row0\r\nsee /h/docs/a.md now\r\nrow2');
    // 'see ' is cols 1-4, '/h/docs/a.md' (12 chars) is cols 5-16 on buffer line 2.
    expect(docLinksOnLine(t, 2)).toEqual([
      { range: { start: { x: 5, y: 2 }, end: { x: 16, y: 2 } }, path: '/h/docs/a.md' },
    ]);
    expect(docLinksOnLine(t, 1)).toEqual([]); // no link on line 1
    t.dispose();
  });

  it('reports a wrapped path with a multi-row range from EITHER of its rows', async () => {
    const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true, scrollback: 100 });
    await write(t, 'open /aa/bb/cc/dd/ee/report.md ok');
    const expected = [{ range: { start: { x: 6, y: 1 }, end: { x: 10, y: 2 } }, path: '/aa/bb/cc/dd/ee/report.md' }];
    expect(docLinksOnLine(t, 1)).toEqual(expected); // querying the first row
    expect(docLinksOnLine(t, 2)).toEqual(expected); // querying the wrapped continuation row
    t.dispose();
  });

  it('gives cell-accurate ranges for a wide-char (CJK) filename', async () => {
    const t = new Terminal({ cols: 30, rows: 3, allowProposedApi: true, scrollback: 100 });
    await write(t, '看 报告.md done');
    // 1-based inclusive cells: '报告.md' is cols 4..10 on buffer line 1
    expect(docLinksOnLine(t, 1)).toEqual([
      { range: { start: { x: 4, y: 1 }, end: { x: 10, y: 1 } }, path: '报告.md' },
    ]);
    t.dispose();
  });

  it('returns [] for a line with no doc path and for out-of-range lines', async () => {
    const t = new Terminal({ cols: 40, rows: 2, allowProposedApi: true, scrollback: 100 });
    await write(t, 'plain line\r\nanother one');
    expect(docLinksOnLine(t, 1)).toEqual([]);
    expect(docLinksOnLine(t, 999)).toEqual([]);
    t.dispose();
  });
});
