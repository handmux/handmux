import { describe, it, expect } from 'vitest';
import { trimCopy } from '../src/terminalSelection.js';

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
