import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../src/git.js';

const run = promisify(execFile);
let home, repo, sub, clean, git;

async function gitC(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

beforeAll(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'gitviewer-'));
  repo = join(home, 'proj');
  await fs.mkdir(repo);
  await gitC(repo, 'init', '-q', '-b', 'main');
  await gitC(repo, 'config', 'user.email', 't@t');
  await gitC(repo, 'config', 'user.name', 'T');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n');
  await gitC(repo, 'add', '.');
  await gitC(repo, 'commit', '-qm', 'first');
  await fs.writeFile(join(repo, 'a.txt'), 'hello world\n');   // working-tree change
  await fs.writeFile(join(repo, 'b.txt'), 'new\n');           // untracked
  // clean repo (nothing uncommitted)
  clean = join(home, 'clean');
  await fs.mkdir(clean);
  await gitC(clean, 'init', '-q', '-b', 'main');
  await gitC(clean, 'config', 'user.email', 't@t');
  await gitC(clean, 'config', 'user.name', 'T');
  await fs.writeFile(join(clean, 'c.txt'), 'clean\n');
  await gitC(clean, 'add', '.');
  await gitC(clean, 'commit', '-qm', 'init');
  // monorepo sibling
  sub = join(home, 'mono');
  await fs.mkdir(sub);
  for (const name of ['fe', 'be']) {
    const d = join(sub, name);
    await fs.mkdir(d);
    await gitC(d, 'init', '-q', '-b', 'main');
  }
  git = createGit({ home });
});

afterAll(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe('detectRepos', () => {
  it('treats a repo dir as a single repo', async () => {
    const out = await git.detectRepos(repo);
    expect(out.repos.map((r) => r.path)).toEqual([repo]);
    expect(out.repos[0].branch).toBe('main');
    expect(out.repos[0].dirty).toBe(true);
  });
  it('expands a parent one level down into child repos', async () => {
    const out = await git.detectRepos(sub);
    expect(out.repos.map((r) => r.name).sort()).toEqual(['be', 'fe']);
  });
  it('rejects a path outside home', async () => {
    expect((await git.detectRepos('/etc')).error).toBe('outside home');
  });
  it('accepts a repo under an extra root outside home', async () => {
    // A second temp tree, NOT under `home`, handed in as an extra root — mirrors the /tmp allow-list the
    // default git shares with the file/doc browser. Without extraRoots this same repo is 'outside home'.
    const alt = await fs.mkdtemp(join(tmpdir(), 'gitviewer-alt-'));
    try {
      const r = join(alt, 'proj');
      await fs.mkdir(r);
      await gitC(r, 'init', '-q', '-b', 'main');
      const gated = createGit({ home });
      expect((await gated.detectRepos(r)).error).toBe('outside home');
      const opened = createGit({ home, extraRoots: [alt] });
      const out = await opened.detectRepos(r);
      expect(out.error).toBeUndefined();
      expect(out.repos.map((x) => x.path)).toEqual([r]);
    } finally {
      await fs.rm(alt, { recursive: true, force: true });
    }
  });
});

describe('worktree', () => {
  it('resolves a nested cwd to its Git worktree root', async () => {
    const nested = join(repo, 'src', 'feature');
    await fs.mkdir(nested, { recursive: true });
    const realRepo = await fs.realpath(repo);
    await expect(git.worktree(nested)).resolves.toEqual({
      worktree: { path: realRepo },
    });
  });

  it('returns null for a non-Git directory', async () => {
    await expect(git.worktree(home)).resolves.toEqual({ worktree: null });
  });

  it('keeps the existing path boundary', async () => {
    expect((await git.worktree('/etc')).error).toBe('outside home');
  });
});

describe('status', () => {
  it('lists working-tree + untracked changes with XY codes', async () => {
    const out = await git.status(repo);
    const byPath = Object.fromEntries(out.changes.map((c) => [c.path, c]));
    expect(byPath['a.txt'].y).toBe('M');
    expect(byPath['b.txt'].x).toBe('?');
  });
  it('returns empty changes for a clean repo', async () => {
    const out = await git.status(clean);
    expect(out.changes).toEqual([]);
  });
  it('rejects a non-repo dir', async () => {
    expect((await git.status(home)).error).toBe('not a repo');
  });
});

describe('log', () => {
  it('returns commits newest-first with parsed fields', async () => {
    const out = await git.log(repo, 10);
    expect(out.commits[0].subject).toBe('first');
    expect(out.commits[0].short).toHaveLength(7);
    expect(out.commits[0].hash).toHaveLength(40);
    expect(out.commits[0].author).toBe('T');
    expect(typeof out.commits[0].relDate).toBe('string');
  });
  it('reads a named branch read-only (no checkout)', async () => {
    await gitC(repo, 'branch', 'feature');   // points at HEAD; never switches the work tree
    const out = await git.log(repo, 10, 'feature');
    expect(out.commits[0].subject).toBe('first');
  });
  it('rejects an option-injection ref', async () => {
    expect((await git.log(repo, 10, '--output=/tmp/x')).error).toBe('bad ref');
    expect((await git.log(repo, 10, '../evil')).error).toBe('bad ref');
  });
  it('returns empty commits for a nonexistent ref', async () => {
    expect((await git.log(repo, 10, 'no-such-branch')).commits).toEqual([]);
  });
});

describe('branches', () => {
  it('marks the current branch', async () => {
    const out = await git.branches(repo);
    const main = out.branches.find((b) => b.name === 'main');
    expect(main.current).toBe(true);
  });
});

describe('diff', () => {
  it('returns unified diff for a working-tree change', async () => {
    const out = await git.diff(repo, { path: 'a.txt' });
    expect(out.diff).toContain('-hello');
    expect(out.diff).toContain('+hello world');
    expect(out.truncated).toBe(false);
  });
  it('rejects an option-injection path', async () => {
    expect((await git.diff(repo, { path: '--output=/tmp/x' })).error).toBe('bad path');
  });
});

describe('commit', () => {
  it('returns message + changed files for a hash', async () => {
    const hash = (await git.log(repo, 1)).commits[0].hash;
    const out = await git.commit(repo, hash);
    expect(out.message).toContain('first');
    expect(out.files.map((f) => f.path)).toContain('a.txt');
  });
  it('returns { error: "git error" } for a well-formed but nonexistent hash', async () => {
    const out = await git.commit(repo, 'deadbeef');
    expect(out.error).toBe('git error');
    expect(out.status).toBe(500);
  });
});
