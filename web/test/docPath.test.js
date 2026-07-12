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

  // Real CC output clings decorators to a path that the ASCII/CJK delimiter set used to swallow into
  // the name, so the file couldn't be found.
  it("strips Claude Code's trailing truncation ellipsis (…)", () => {
    expect(findDocLinks('git add docs/adp-integration/overview.md…)').map((l) => l.path))
      .toEqual(['docs/adp-integration/overview.md']);
  });
  it('drops leading/surrounding markdown asterisks', () => {
    expect(findDocLinks('*note.md and more').map((l) => l.path)).toEqual(['note.md']);
    expect(findDocLinks('**foo.md** bold').map((l) => l.path)).toEqual(['foo.md']);
  });
  it('splits a label:path joined by a colon with no space, keeping only the path', () => {
    expect(findDocLinks('参考:docs/plan.md 下一步').map((l) => l.path)).toEqual(['docs/plan.md']);
    expect(findDocLinks('Referenced:CHANGELOG.md').map((l) => l.path)).toEqual(['CHANGELOG.md']);
  });
  it('keeps a file:line[:col] suffix out of the path (colon is a boundary)', () => {
    expect(findDocLinks('/home/u/file.md:12:5 error').map((l) => l.path)).toEqual(['/home/u/file.md']);
  });
  it("strips a leading @ (Claude Code's @file mention) but keeps an internal @", () => {
    const link = findDocLinks('see @src/notes.md mention');
    expect(link.map((l) => l.path)).toEqual(['src/notes.md']);
    expect(link[0].start).toBe(5); // offset advances past the '@' so the underline lands on the path
    expect(findDocLinks('open node_modules/@types/x.md here').map((l) => l.path))
      .toEqual(['node_modules/@types/x.md']);
  });
  it('does not fuse a path with a box-drawing border', () => {
    expect(findDocLinks('│ report.md │').map((l) => l.path)).toEqual(['report.md']);
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
