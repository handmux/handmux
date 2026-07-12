import { describe, it, expect } from 'vitest';
import { findDocLinks, isAbsolute, joinPath } from '../src/docPath.js';

describe('findDocLinks', () => {
  it('finds an absolute md path with correct offsets', () => {
    const line = 'wrote /home/runner/docs/foo.md done';
    expect(findDocLinks(line)).toEqual([{ start: 6, end: 30, path: '/home/runner/docs/foo.md' }]);
  });
  it('finds relative and ./ paths, and html', () => {
    expect(findDocLinks('see ./notes.md and bar/baz.html').map((l) => l.path))
      .toEqual(['./notes.md', 'bar/baz.html']);
  });
  it('strips trailing prose punctuation via lookahead', () => {
    expect(findDocLinks('open report.html.').map((l) => l.path)).toEqual(['report.html']);
    expect(findDocLinks('(see /x/y.md)').map((l) => l.path)).toEqual(['/x/y.md']);
  });
  it('ignores non-openable extensions and plain text', () => {
    expect(findDocLinks('archive.mdx and data.bin')).toEqual([]);
    expect(findDocLinks('no links here')).toEqual([]);
  });
  it('finds plain-text paths (txt/log/sh) so they are tappable', () => {
    expect(findDocLinks('tail app.log and ./run.sh, notes.txt').map((l) => l.path))
      .toEqual(['app.log', './run.sh', 'notes.txt']);
  });
  it('also finds image paths (png/jpg/gif/webp/svg…) so terminal images are tappable', () => {
    expect(findDocLinks('saved /tmp/out/chart.png ok').map((l) => l.path)).toEqual(['/tmp/out/chart.png']);
    expect(findDocLinks('see ./demo.gif and a/b.jpeg, c.webp').map((l) => l.path))
      .toEqual(['./demo.gif', 'a/b.jpeg', 'c.webp']);
    expect(findDocLinks('图：截图.png，').map((l) => l.path)).toEqual(['截图.png']);
  });
  it('finds a CJK filename bounded by full-width punctuation', () => {
    // CC output: a Chinese filename wrapped in full-width colon/comma — the ASCII-only delimiter
    // set used to drop it entirely.
    expect(findDocLinks('纯口播稿好了：口播稿-纯配音版.md，').map((l) => l.path)).toEqual(['口播稿-纯配音版.md']);
    expect(findDocLinks('看 报告.md').map((l) => l.path)).toEqual(['报告.md']);
  });
  it('does not match a bare extension with no name before it', () => {
    expect(findDocLinks('type: .md')).toEqual([]);
    expect(findDocLinks('foo(.html)')).toEqual([]);
  });
});

describe('isAbsolute', () => {
  it('is true only for a leading slash', () => {
    expect(isAbsolute('/a/b.md')).toBe(true);
    expect(isAbsolute('a/b.md')).toBe(false);
    expect(isAbsolute('./a.md')).toBe(false);
  });
});

describe('joinPath', () => {
  it('joins relative against base', () => {
    expect(joinPath('/home/u/proj', 'docs/a.md')).toBe('/home/u/proj/docs/a.md');
  });
  it('resolves . and ..', () => {
    expect(joinPath('/home/u/proj', './a.md')).toBe('/home/u/proj/a.md');
    expect(joinPath('/home/u/proj/sub', '../a.md')).toBe('/home/u/proj/a.md');
  });
  it('ignores base when rel is absolute, and tolerates a trailing slash on base', () => {
    expect(joinPath('/home/u', '/abs/x.md')).toBe('/abs/x.md');
    expect(joinPath('/home/u/', 'a.md')).toBe('/home/u/a.md');
  });
  it('clamps .. past root without throwing', () => {
    expect(joinPath('/a', '../../evil')).toBe('/evil');
  });
});
