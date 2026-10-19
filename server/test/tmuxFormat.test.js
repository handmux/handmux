import { describe, expect, it } from 'vitest';
import { parseTmuxFields, parseTmuxRows, tmuxFormat } from '../src/tmux/format.js';

describe('tmux q format fields', () => {
  it('builds an unambiguous q-escaped pipe format', () => {
    expect(tmuxFormat(['session_id', 'session_name', '@handmux_session_id']))
      .toBe('#{q:session_id}|#{q:session_name}|#{q:@handmux_session_id}');
  });

  it('decodes escaped pipes, backslashes, spaces, and empty fields', () => {
    expect(parseTmuxFields('a\\|b|a\\\\b||two\\ words', 4, 'probe'))
      .toEqual(['a|b', 'a\\b', '', 'two words']);
  });

  it.each([
    ['3.7c', 'abcd,80x24,0,0{40x24,0,0,7,39x24,41,0,8}'],
    ['3.8', 'abcd,80x24,0,0\\{40x24,0,0,7,39x24,41,0,8\\}'],
  ])('decodes tmux %s horizontal layouts without changing the layout', (_version, encoded) => {
    expect(parseTmuxFields(encoded, 1)).toEqual(['abcd,80x24,0,0{40x24,0,0,7,39x24,41,0,8}']);
  });

  it('decodes the additional tmux 3.8 q escapes as literal characters', () => {
    expect(parseTmuxFields('a\\{b\\}c\\\nd\\\te', 1)).toEqual(['a{b}c\nd\te']);
  });

  it.each([
    ['a\\', 'dangling escape'],
    ['a\\xb', 'unsupported escape'],
    ['a|b', 'expected 3 fields'],
  ])('fails closed for malformed q output: %s', (line, message) => {
    expect(() => parseTmuxFields(line, 3, 'probe')).toThrow(message);
  });
});

describe('tmux q format rows', () => {
  it('preserves escaped newlines and tabs inside fields across multiple rows', () => {
    expect(parseTmuxRows('first\\\nsecond|tab\\\there\nnext|a\\|b\\\\c\n', 2))
      .toEqual([['first\nsecond', 'tab\there'], ['next', 'a|b\\c']]);
  });

  it.each([
    ['LF', 'one|tail\\\\\ntwo|end\n'],
    ['CRLF', 'one|tail\\\\\r\ntwo|end\r\n'],
    ['mixed endings without a trailing delimiter', 'one|tail\\\\\r\ntwo|end'],
  ])('keeps %s record boundaries after an escaped backslash', (_label, output) => {
    expect(parseTmuxRows(output, 2)).toEqual([['one', 'tail\\'], ['two', 'end']]);
  });

  it('distinguishes three backslashes before a literal newline from a record boundary', () => {
    expect(parseTmuxRows('one|tail\\\\\\\ncontinued\ntwo|end\n', 2))
      .toEqual([['one', 'tail\\\ncontinued'], ['two', 'end']]);
  });

  it('retains a final escaped newline when there is no record delimiter', () => {
    expect(parseTmuxRows('one|tail\\\n', 2)).toEqual([['one', 'tail\n']]);
  });

  it('preserves raw characters accepted from older tmux versions', () => {
    expect(parseTmuxRows('one|{raw}\ttab\r\ntwo|last\n', 2))
      .toEqual([['one', '{raw}\ttab'], ['two', 'last']]);
  });

  it.each(['', '\n', '\r\n'])('keeps empty tmux output empty: %j', (output) => {
    expect(parseTmuxRows(output, 2)).toEqual([]);
  });

  it.each([
    ['one|bad\\x\n', 'unsupported escape'],
    ['one|bad\\', 'dangling escape'],
    ['one|bad\\\ncontinued\\x\n', 'unsupported escape'],
    ['one|bad\\\r\n', 'dangling escape'],
    ['one|raw\nnewline\n', 'expected 2 fields'],
    ['one|ok\n\n', 'expected 2 fields'],
  ])('rejects malformed rows without accepting partial data: %j', (output, message) => {
    expect(() => parseTmuxRows(output, 2)).toThrow(message);
  });
});
