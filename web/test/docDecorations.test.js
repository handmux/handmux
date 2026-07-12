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

  it('scans the WHOLE buffer, so every path (incl. scrollback) is decorated regardless of scroll', async () => {
    // Decorations ride the content on markers, so scanning the whole buffer once means a path stays lit
    // wherever you scroll — no per-scroll rebuild (which flickered on a fling). Many path lines + a short
    // viewport → most sit in the scrollback, yet all are found at any scroll position.
    const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true, scrollback: 200 });
    let s = '';
    for (let i = 1; i <= 20; i++) s += `line${i} dir/f${i}.md x\r\n`;
    await write(t, `${s}prompt$ `);
    const paths = () => [...new Set(scanDocLinks(t).map((x) => x.path))];
    const atBottom = paths();
    expect(atBottom).toContain('dir/f1.md'); // top-of-scrollback path found even while at the bottom
    expect(atBottom).toContain('dir/f20.md'); // …and the bottom one
    expect(atBottom).toHaveLength(20); // every path, in one scan
    t.scrollToTop();
    expect(paths()).toEqual(atBottom); // scroll position doesn't change what's decorated
    t.dispose();
  });

  it('returns [] when no doc path is on screen', async () => {
    const t = new Terminal({ cols: 40, rows: 2, allowProposedApi: true, scrollback: 100 });
    await write(t, 'plain line\r\nanother one');
    expect(scanDocLinks(t)).toEqual([]);
    t.dispose();
  });

  // A program (Ink / Claude Code) that width-folds its OWN output emits a real '\n', so the second row
  // is NOT flagged isWrapped. We still stitch it when the first row is filled to the edge and the next
  // starts flush at col 0 — otherwise only the tail fragment ('plans/push-api.md') would be tappable.
  it('stitches a HARD-newline fold (filled row + flush next row) into the full path', async () => {
    const t = new Terminal({ cols: 24, rows: 5, allowProposedApi: true, scrollback: 100 });
    await write(t, 'Write(/root/aa/bb/cc/dd/\r\nplans/push-api.md)'); // 24 chars fills row 0 exactly
    expect(scanDocLinks(t).map((s) => s.path)).toEqual([
      '/root/aa/bb/cc/dd/plans/push-api.md',
      '/root/aa/bb/cc/dd/plans/push-api.md',
    ]);
    t.dispose();
  });

  it('does NOT stitch when the first row ends early (a real line break, not a width fold)', async () => {
    // Row 0 has trailing space → it wasn't folded by width, so the two rows are independent lines.
    const t = new Terminal({ cols: 40, rows: 4, allowProposedApi: true, scrollback: 100 });
    await write(t, 'edited /root/aa/bb/\r\nplans/push-api.md done');
    // The prefix has no extension → no link; only the second line's own path is found (unfused).
    expect(scanDocLinks(t).map((s) => s.path)).toEqual(['plans/push-api.md']);
    t.dispose();
  });

  it('stitches a wide-char (CJK) path that soft-wraps on a full-width glyph', async () => {
    // A wide glyph can't straddle the wrap: the last column is left EMPTY and the glyph moves to the
    // next row. That spacer must NOT become a space, or the path would sever mid-name (…中文 目录…).
    const t = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, scrollback: 100 });
    const p = '~/zxy/query-rule-validation/超长中文目录名称占位占位占位占位占位占位占位占位/最终验证报告-完整版.md';
    await write(t, `看 ${p} 完`);
    expect([...new Set(scanDocLinks(t).map((s) => s.path))]).toEqual([p]);
    t.dispose();
  });

  it('stitches a CJK path HARD-folded by tmux (wide glyph one short of the edge, space-padded spacer)', async () => {
    // The real gotcha: panes come from tmux's padded capture, so a soft-wrapped CJK path arrives as two
    // HARD lines (no isWrapped). row1 ends with a wide glyph at cols-2 and a real SPACE padding the final
    // column (the wide glyph that couldn't fit was bumped down). That must still count as "reaches edge"
    // and stitch — else row1 has no extension, so only the tail (…/报告.md) would be found/tappable.
    const t = new Terminal({ cols: 16, rows: 6, allowProposedApi: true, scrollback: 100 });
    await write(t, 'xx ~/目录占位占 \r\n位/报告.md end');
    expect(t.buffer.active.getLine(1).isWrapped).toBe(false); // genuinely a hard line, like tmux delivers
    expect([...new Set(scanDocLinks(t).map((s) => s.path))]).toEqual(['~/目录占位占位/报告.md']);
    t.dispose();
  });

  it('does not fuse a boxed path across the frame padding (only the leaf is found)', async () => {
    const t = new Terminal({ cols: 28, rows: 4, allowProposedApi: true, scrollback: 100 });
    await write(t, '│ /home/u/very/long/path/ │\r\n│ report.md               │');
    expect(scanDocLinks(t).map((s) => s.path)).toEqual(['report.md']);
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
