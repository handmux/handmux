import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocs, encodeCwdKey } from '../src/docs.js';

let home, outside, docs, docsTinyDl;

beforeAll(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'twhome-'));
  outside = await fs.mkdtemp(join(tmpdir(), 'twout-'));
  await fs.writeFile(join(home, 'a.md'), '# hello');
  await fs.writeFile(join(home, 'page.html'), '<h1>hi</h1>');
  await fs.writeFile(join(home, 'note.txt'), 'plain');
  await fs.mkdir(join(home, 'docs'));
  await fs.mkdir(join(home, '.hidden'));
  await fs.mkdir(join(home, 'projects'));
  await fs.mkdir(join(home, 'proj'));
  await fs.writeFile(join(home, 'proj', 'a.md'), '# proj');
  await fs.mkdir(join(home, '.config'));
  await fs.writeFile(join(home, 'docs', 'b.md'), 'b');
  await fs.writeFile(join(home, 'docs', 'settings.toml'), 'theme = "dark"');
  await fs.writeFile(join(home, 'docs', 'NOTICE'), 'plain extensionless text');
  await fs.writeFile(join(home, 'docs', 'binary.dat'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
  await fs.writeFile(join(outside, 'secret.md'), 'secret');
  await fs.symlink(join(outside, 'secret.md'), join(home, 'escape.md')); // points outside home
  await fs.writeFile(join(home, 'big.md'), Buffer.alloc(2 * 1024 * 1024 + 1, '#'));
  docs = createDocs({ home });
  // a second instance with a tiny download cap to exercise the 413 path cheaply
  // note.txt is 5 bytes ('plain'), so cap must be < 5 to trigger 413
  docsTinyDl = createDocs({ home, maxDownloadBytes: 4 });
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('readDoc', () => {
  it('reads a markdown file under home', async () => {
    const out = await docs.readDoc(join(home, 'a.md'));
    expect(out).toMatchObject({ name: 'a.md', type: 'markdown', content: '# hello' });
  });
  it('expands a home-abbreviated document path', async () => {
    const out = await docs.readDoc('~/a.md');
    expect(out).toMatchObject({ name: 'a.md', type: 'markdown', content: '# hello' });
  });
  it('reads an html file under home', async () => {
    const out = await docs.readDoc(join(home, 'page.html'));
    expect(out).toMatchObject({ name: 'page.html', type: 'html' });
  });
  it('400s a non-absolute path', async () => {
    expect((await docs.readDoc('a.md')).status).toBe(400);
  });
  it('reads text files regardless of extension, including extensionless names', async () => {
    expect(await docs.readDoc(join(home, 'docs', 'settings.toml')))
      .toMatchObject({ name: 'settings.toml', type: 'text', content: 'theme = "dark"' });
    expect(await docs.readDoc(join(home, 'docs', 'NOTICE')))
      .toMatchObject({ name: 'NOTICE', type: 'text', content: 'plain extensionless text' });
  });
  it('rejects binary content instead of decoding it as text', async () => {
    expect((await docs.readDoc(join(home, 'docs', 'binary.dat'))).status).toBe(415);
  });
  it('reads a .txt/.log/.sh file as plain text', async () => {
    expect(await docs.readDoc(join(home, 'note.txt'))).toMatchObject({ name: 'note.txt', type: 'text', content: 'plain' });
  });
  it('404s a missing file', async () => {
    expect((await docs.readDoc(join(home, 'nope.md'))).status).toBe(404);
  });
  it('400s a symlink escaping home (realpath lands outside)', async () => {
    expect((await docs.readDoc(join(home, 'escape.md'))).status).toBe(400);
  });
  it('does not let a home-abbreviated path traverse outside home', async () => {
    expect((await docs.readDoc(`~/../${outside.split('/').at(-1)}/secret.md`)).status).toBe(400);
  });
  it('400s a directory path (not a file)', async () => {
    expect((await docs.readDoc(join(home, 'docs'))).status).toBe(400);
  });
  it('413s a file just over 2MB', async () => {
    expect((await docs.readDoc(join(home, 'big.md'))).status).toBe(413);
  });
  it('returns mtimeMs alongside the content', async () => {
    const out = await docs.readDoc(join(home, 'a.md'));
    expect(typeof out.mtimeMs).toBe('number');
  });
  it('conditional read: matching knownMtime → notModified, no content', async () => {
    const first = await docs.readDoc(join(home, 'a.md'));
    const again = await docs.readDoc(join(home, 'a.md'), first.mtimeMs);
    expect(again).toMatchObject({ name: 'a.md', type: 'markdown', notModified: true, mtimeMs: first.mtimeMs });
    expect(again.content).toBeUndefined();
  });
  it('conditional read: a changed file (newer mtime) → full content again', async () => {
    // Own throwaway home so mutating/creating files can't pollute the shared `home` (the listDir test
    // asserts its exact root listing).
    const h = await fs.mkdtemp(join(tmpdir(), 'twmut-'));
    try {
      const d = createDocs({ home: h });
      const p = join(h, 'mut.md');
      await fs.writeFile(p, '# v1');
      const first = await d.readDoc(p);
      await fs.writeFile(p, '# v2');
      await fs.utimes(p, new Date(), new Date(first.mtimeMs + 1000)); // set mtime deterministically newer
      const out = await d.readDoc(p, first.mtimeMs);
      expect(out.notModified).toBeUndefined();
      expect(out.content).toBe('# v2');
      expect(out.mtimeMs).not.toBe(first.mtimeMs);
    } finally {
      await fs.rm(h, { recursive: true, force: true });
    }
  });
});

describe('listDir', () => {
  it('lists dirs first, then all files (doc + non-doc) with size', async () => {
    const out = await docs.listDir(home);
    expect(out.parent).toBeNull();
    expect(out.entries).toEqual([
      { name: '.config', type: 'dir' },
      { name: '.hidden', type: 'dir' },
      { name: 'docs', type: 'dir' },
      { name: 'proj', type: 'dir' },
      { name: 'projects', type: 'dir' },
      { name: 'a.md', type: 'doc', size: (await fs.stat(join(home, 'a.md'))).size },
      { name: 'big.md', type: 'doc', size: (await fs.stat(join(home, 'big.md'))).size },
      { name: 'note.txt', type: 'doc', size: (await fs.stat(join(home, 'note.txt'))).size },
      { name: 'page.html', type: 'doc', size: (await fs.stat(join(home, 'page.html'))).size },
    ]);
  });
  it('classifies image files as type:image (openable inline)', async () => {
    const d = join(home, 'pics');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(join(d, 'anim.gif'), 'GIF89a');
    await fs.writeFile(join(d, 'shot.PNG'), 'x');
    await fs.writeFile(join(d, 'readme.md'), '#');
    await fs.writeFile(join(d, 'data.bin'), 'x');
    const out = await docs.listDir(d);
    const byName = Object.fromEntries(out.entries.map((e) => [e.name, e.type]));
    expect(byName['anim.gif']).toBe('image');
    expect(byName['shot.PNG']).toBe('image');
    expect(byName['readme.md']).toBe('doc');
    expect(byName['data.bin']).toBe('file');
  });
  it('still hides symlinks (lstat semantics, not followed)', async () => {
    const out = await docs.listDir(home);
    expect(out.entries.some((e) => e.name === 'escape.md')).toBe(false);
  });
  it('defaults to home when path is empty', async () => {
    const out = await docs.listDir('');
    expect(out.path).toBe(await fs.realpath(home));
  });
  it('gives a non-null parent for a subdir under home', async () => {
    const out = await docs.listDir(join(home, 'docs'));
    expect(out.parent).toBe(await fs.realpath(home));
  });
  it('400s a directory outside home', async () => {
    expect((await docs.listDir(outside)).status).toBe(400);
  });
  it('400s a file path (not a directory)', async () => {
    expect((await docs.listDir(join(home, 'a.md'))).status).toBe(400);
  });
});

describe('statForDownload', () => {
  it('resolves any regular file under home (not just docs)', async () => {
    const out = await docs.statForDownload(join(home, 'note.txt'));
    expect(out).toMatchObject({ name: 'note.txt' });
    expect(out.real).toBe(await fs.realpath(join(home, 'note.txt')));
    expect(out.size).toBe((await fs.stat(join(home, 'note.txt'))).size);
  });
  it('expands a home-abbreviated download path', async () => {
    const out = await docs.statForDownload('~/note.txt');
    expect(out).toMatchObject({ name: 'note.txt' });
    expect(out.real).toBe(await fs.realpath(join(home, 'note.txt')));
  });
  it('400s a non-absolute path', async () => {
    expect((await docs.statForDownload('note.txt')).status).toBe(400);
  });
  it('404s a missing file', async () => {
    expect((await docs.statForDownload(join(home, 'nope.x'))).status).toBe(404);
  });
  it('400s a symlink escaping home', async () => {
    expect((await docs.statForDownload(join(home, 'escape.md'))).status).toBe(400);
  });
  it('does not let a home-abbreviated download path traverse outside home', async () => {
    expect((await docs.statForDownload(`~/../${outside.split('/').at(-1)}/secret.md`)).status).toBe(400);
  });
  it('400s a directory path', async () => {
    expect((await docs.statForDownload(join(home, 'docs'))).status).toBe(400);
  });
  it('413s a file over the download cap', async () => {
    expect((await docsTinyDl.statForDownload(join(home, 'note.txt'))).status).toBe(413);
  });
});

describe('resolveUploadDir', () => {
  it('resolves a plain subdir under home', async () => {
    const out = await docs.resolveUploadDir(join(home, 'projects'));
    expect(out.real).toBe(await fs.realpath(join(home, 'projects')));
  });
  it('400s the home root itself (must be a subdir)', async () => {
    expect((await docs.resolveUploadDir(home)).status).toBe(400);
  });
  it('400s a hidden directory', async () => {
    expect((await docs.resolveUploadDir(join(home, '.hidden'))).status).toBe(400);
  });
  it('400s a directory outside home', async () => {
    expect((await docs.resolveUploadDir(outside)).status).toBe(400);
  });
  it('400s a non-absolute path', async () => {
    expect((await docs.resolveUploadDir('projects')).status).toBe(400);
  });
  it('400s a file path (not a directory)', async () => {
    expect((await docs.resolveUploadDir(join(home, 'a.md'))).status).toBe(400);
  });
  it('404s a missing directory', async () => {
    expect((await docs.resolveUploadDir(join(home, 'nope'))).status).toBe(404);
  });
});

describe('encodeCwdKey', () => {
  it('flattens an absolute cwd to one dash-joined segment', () => {
    expect(encodeCwdKey('/Users/x/proj')).toBe('-Users-x-proj');
  });
  it('replaces non-portable chars with _ (no separators survive)', () => {
    expect(encodeCwdKey('/a b/c:d')).toBe('-a_b-c_d');
  });
  it('maps empty / relative cwd to _default', () => {
    expect(encodeCwdKey('')).toBe('_default');
    expect(encodeCwdKey('relative')).toBe('_default');
    expect(encodeCwdKey(null)).toBe('_default');
  });
});

describe('resolveStashDir', () => {
  it('creates ~/.handmux/uploads/<encoded-cwd> and returns it', async () => {
    const out = await docs.resolveStashDir(join(home, 'projects'));
    const expected = join(home, '.handmux', 'uploads', encodeCwdKey(join(home, 'projects')));
    expect(out.real).toBe(await fs.realpath(expected));
    expect((await fs.stat(out.real)).isDirectory()).toBe(true);
  });
  it('keeps different cwds in separate spaces, and never inside the project dir', async () => {
    const realHome = await fs.realpath(home); // home may be a symlinked tmpdir on macOS
    const a = await docs.resolveStashDir(join(home, 'proj'));
    const b = await docs.resolveStashDir(join(home, 'projects'));
    expect(a.real).not.toBe(b.real);
    expect(a.real.startsWith(join(realHome, '.handmux', 'uploads'))).toBe(true);
    expect(a.real.includes(`${join(realHome, 'proj')}/`)).toBe(false); // not under the project tree
  });
  it('is idempotent for the same cwd', async () => {
    const first = await docs.resolveStashDir(join(home, 'proj'));
    const second = await docs.resolveStashDir(join(home, 'proj'));
    expect(second.real).toBe(first.real);
  });
  it('falls back to the _default space when cwd is empty', async () => {
    const out = await docs.resolveStashDir('');
    expect(out.real).toBe(await fs.realpath(join(home, '.handmux', 'uploads', '_default')));
  });
});

describe('makeDir', () => {
  it('creates a new directory under home and returns its real path', async () => {
    const r = await docs.makeDir(home, 'newdir1');
    expect(r.real).toBe(await fs.realpath(join(home, 'newdir1')));
    const st = await fs.stat(join(home, 'newdir1'));
    expect(st.isDirectory()).toBe(true);
  });
  it('creates a directory inside a subdir', async () => {
    const r = await docs.makeDir(join(home, 'proj'), 'sub1');
    expect(r.real).toBe(await fs.realpath(join(home, 'proj', 'sub1')));
  });
  it('rejects when the directory already exists (409)', async () => {
    await docs.makeDir(home, 'dup1');
    const r = await docs.makeDir(home, 'dup1');
    expect(r).toMatchObject({ status: 409 });
  });
  it('rejects a name containing a slash', async () => {
    const r = await docs.makeDir(home, 'a/b');
    expect(r).toMatchObject({ status: 400 });
  });
  it("rejects '.' and '..' names", async () => {
    expect((await docs.makeDir(home, '.')).status).toBe(400);
    expect((await docs.makeDir(home, '..')).status).toBe(400);
  });
  it('rejects an empty/whitespace name', async () => {
    expect((await docs.makeDir(home, '   ')).status).toBe(400);
  });
  it('rejects a parent outside home', async () => {
    const r = await docs.makeDir('/tmp', 'x');
    expect(r).toMatchObject({ error: 'outside home', status: 400 });
  });
  it('rejects a parent that does not exist', async () => {
    const r = await docs.makeDir(join(home, 'nope'), 'x');
    expect(r.status).toBe(404);
  });
  it('allows a name with spaces / unicode', async () => {
    const r = await docs.makeDir(home, '我的 文件夹');
    expect(r.real).toBe(await fs.realpath(join(home, '我的 文件夹')));
  });
});

describe('resolveCwd', () => {
  it('accepts a directory under home', async () => {
    const r = await docs.resolveCwd(join(home, 'proj'));
    expect(r.real).toBe(await fs.realpath(join(home, 'proj')));
    expect(r.error).toBeUndefined();
  });
  it('accepts the home root itself', async () => {
    const r = await docs.resolveCwd(home);
    expect(r.real).toBe(await fs.realpath(home));
  });
  it('accepts a hidden directory under home', async () => {
    const r = await docs.resolveCwd(join(home, '.config'));
    expect(r.real).toBe(await fs.realpath(join(home, '.config')));
  });
  it('rejects a path outside home', async () => {
    const r = await docs.resolveCwd('/tmp');
    expect(r).toMatchObject({ error: 'outside home', status: 400 });
  });
  it('rejects a non-existent path', async () => {
    const r = await docs.resolveCwd(join(home, 'nope'));
    expect(r).toMatchObject({ status: 404 });
  });
  it('rejects a file (not a directory)', async () => {
    const r = await docs.resolveCwd(join(home, 'proj', 'a.md'));
    expect(r).toMatchObject({ error: 'not a directory', status: 400 });
  });
  it('rejects a non-absolute path', async () => {
    const r = await docs.resolveCwd('proj');
    expect(r).toMatchObject({ error: 'not absolute', status: 400 });
  });
});

describe('extra roots (multi-root browse outside $HOME)', () => {
  let docsX, extraReal;
  beforeAll(async () => {
    // `outside` (a sibling temp dir, NOT under home) becomes an allowed extra root.
    extraReal = await fs.realpath(outside);
    await fs.mkdir(join(outside, 'sub'));
    await fs.writeFile(join(outside, 'sub', 'a.png'), 'x');
    await fs.mkdir(join(outside, '.hide'));
    docsX = createDocs({ home, extraRoots: [outside, join(home, 'docs') /* under home → dropped */, '/no/such/dir'] });
  });

  it('lists a dir under the extra root and reports the root set (home dropped duplicates)', async () => {
    const out = await docsX.listDir(join(outside, 'sub'));
    expect(out.path).toBe(join(extraReal, 'sub'));
    expect(out.entries).toEqual([{ name: 'a.png', type: 'image', size: 1 }]);
    expect(out.roots).toEqual([await fs.realpath(home), extraReal]); // the under-home + missing extras are dropped
    expect(out.home).toBe(await fs.realpath(home));
  });
  it('"up" stops at the extra root (parent null at the root itself)', async () => {
    expect((await docsX.listDir(outside)).parent).toBe(null);
  });
  it('reads a doc and downloads a file under the extra root', async () => {
    await fs.writeFile(join(outside, 'r.md'), '# x');
    expect((await docsX.readDoc(join(outside, 'r.md'))).type).toBe('markdown');
    expect((await docsX.statForDownload(join(outside, 'sub', 'a.png'))).name).toBe('a.png');
  });
  it('allows upload INTO the extra root itself and into its subdirs, but not a hidden subdir', async () => {
    expect((await docsX.resolveUploadDir(outside)).real).toBe(extraReal);            // root itself OK (unlike $HOME)
    expect((await docsX.resolveUploadDir(join(outside, 'sub'))).real).toBe(join(extraReal, 'sub'));
    expect(await docsX.resolveUploadDir(join(outside, '.hide')))
      .toMatchObject({ error: 'hidden directory not allowed', status: 400 });
  });
  it('still forbids uploading into the $HOME root and still rejects paths under no root', async () => {
    expect((await docsX.resolveUploadDir(home)).error).toBe('home root not allowed');
    expect((await docsX.listDir('/etc')).error).toBe('outside home');
  });
  it('home browsing is unchanged when extra roots are configured', async () => {
    const out = await docsX.listDir(home);
    expect(out.path).toBe(await fs.realpath(home));
    expect(out.parent).toBe(null); // home is a root → up stops here too
  });
});
