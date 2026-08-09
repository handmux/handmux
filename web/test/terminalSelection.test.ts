import { describe, expect, it } from 'vitest';
import { trimCopy, cellToPx, selectionCounts } from '../src/terminalSelection.js';
import { expandToLines, expandToParagraph } from '../src/terminalSelection.js';

describe('trimCopy', () => {
  it('去掉每行首尾空白（含行首缩进）', () => {
    expect(trimCopy('   ls -la   ')).toBe('ls -la');
    expect(trimCopy('    foo\n      bar  ')).toBe('foo\nbar');
  });
  it('去掉整块开头/结尾的空白行，保留中间空行', () => {
    expect(trimCopy('\n\n  a\n\n b \n\n')).toBe('a\n\nb');
  });
  it('保留行内词之间的空格', () => {
    expect(trimCopy('  a   b  ')).toBe('a   b');
  });
  it('空/纯空白 → 空串', () => {
    expect(trimCopy('   \n  \n')).toBe('');
  });
});

describe('selectionCounts', () => {
  it('行数用原始换行，字数用 copy-trim 后去掉换行', () => {
    // 3 行；trim 后 "ls -la"+"foo"+"bar" = 6+3+3 = 12 字
    expect(selectionCounts('  ls -la  \n foo \n bar ')).toEqual({ lines: 3, chars: 12 });
  });
  it('字数与实际复制内容一致（去掉行首尾padding空格）', () => {
    // trimCopy 去掉首尾空白行 + 每行首尾空白；中间空行保留但计 0 字
    expect(selectionCounts('\n  a  \n\n b \n')).toEqual({ lines: 5, chars: 2 });
  });
  it('空串 → 0/0', () => {
    expect(selectionCounts('')).toEqual({ lines: 0, chars: 0 });
  });
});

describe('expandToLines', () => {
  it('每端扩到整行', () => {
    const r = { start: { col: 3, row: 5 }, end: { col: 7, row: 8 } };
    expect(expandToLines(r, 80)).toEqual({ start: { col: 0, row: 5 }, end: { col: 79, row: 8 } });
  });
});

describe('expandToParagraph', () => {
  // rows: 10 空, 11 "foo", 12 "bar", 13 "  ", 14 "baz"
  const text: Record<number, string> = { 10: '', 11: 'foo', 12: 'bar', 13: '  ', 14: 'baz' };
  const lineText = (row: number) => text[row] ?? '';
  it('扩到空白行界定的段（13 是空白行，11-12 成段）', () => {
    const r = { start: { col: 1, row: 12 }, end: { col: 1, row: 12 } };
    expect(expandToParagraph(r, 80, lineText, 0, 20))
      .toEqual({ start: { col: 0, row: 11 }, end: { col: 79, row: 12 } });
  });
  it('夹在 buffer 边界内', () => {
    const r = { start: { col: 0, row: 11 }, end: { col: 0, row: 11 } };
    expect(expandToParagraph(r, 80, lineText, 11, 12))
      .toEqual({ start: { col: 0, row: 11 }, end: { col: 79, row: 12 } });
  });
});

describe('cellToPx', () => {
  it('col*cellW，行减去视口顶行再*cellH', () => {
    expect(cellToPx(4, 12, 10, 8, 18)).toEqual({ x: 32, y: 36 }); // (12-10)*18=36
  });
  it('视口内第一行 y=0', () => {
    expect(cellToPx(0, 10, 10, 8, 18)).toEqual({ x: 0, y: 0 });
  });
});
