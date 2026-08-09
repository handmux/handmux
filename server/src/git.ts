import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { isUnder } from './docPath.js';
import { defaultExtraRoots } from './docs.js';

// 只读子命令白名单：命令层硬过滤，杜绝任何写操作混入。
const READONLY = new Set(['rev-parse', 'status', 'log', 'for-each-ref', 'diff', 'show', 'diff-tree']);
const MAX_BUFFER = 8 * 1024 * 1024;

export interface GitError {
  error: string;
  status: number;
}

export interface GitRepo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
}

export interface GitChange {
  x: string;
  y: string;
  path: string;
}

export interface GitCommitSummary {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relDate: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitDiffOptions {
  path?: unknown;
  commit?: unknown;
  staged?: unknown;
}

export interface GitService {
  resolveRepo(rawPath: unknown): Promise<{ real: string } | GitError>;
  isRepo(dir: string): Promise<boolean>;
  detectRepos(rawDir: unknown): Promise<{ repos: GitRepo[] } | GitError>;
  status(rawRepo: unknown): Promise<{ changes: GitChange[] } | GitError>;
  log(rawRepo: unknown, limit?: unknown, ref?: unknown): Promise<{ commits: GitCommitSummary[] } | GitError>;
  branches(rawRepo: unknown): Promise<{ branches: GitBranch[] } | GitError>;
  diff(rawRepo: unknown, options?: GitDiffOptions): Promise<{ diff: string; truncated: boolean } | GitError>;
  commit(rawRepo: unknown, hash: unknown): Promise<{ message: string; files: GitChange[] } | GitError>;
}

interface CreateGitOptions {
  home?: string;
  extraRoots?: readonly unknown[];
}

export function createGit({ home = homedir(), extraRoots = [] }: CreateGitOptions = {}): GitService {
  const realHomeP = fs.realpath(home);
  // Same multi-root allow-list as createDocs: $HOME plus a few roots OUTSIDE it (/tmp, $TMPDIR) so a repo
  // an agent is working in under /tmp is reachable from the phone. Resolved once — realpath'd, deduped,
  // missing ones skipped, extras already inside home dropped (home covers them). Keeps git browsing in
  // lock-step with the file/doc browser; git.js used to be home-only, which rejected legit repos under
  // /tmp with a red "outside home".
  const rootsP = (async () => {
    const rh = await realHomeP;
    const out = [rh];
    for (const root of extraRoots) {
      if (typeof root !== 'string' || !root) continue;
      let real: string;
      try { real = await fs.realpath(root); } catch { continue; } // not present on this host → skip
      if (isUnder(real, rh) || out.includes(real)) continue;   // already covered by home / dup
      out.push(real);
    }
    return out;
  })();
  // The allowed root that contains `real` (longest match wins should roots ever nest), or null.
  const rootOf = (real: string, roots: readonly string[]): string | null => {
    let best: string | null = null;
    for (const root of roots) if (isUnder(real, root) && (!best || root.length > best.length)) best = root;
    return best;
  };

  function git(cwd: string, args: readonly string[]): Promise<string> {
    const sub = args[0];
    if (!sub || !READONLY.has(sub)) return Promise.reject(new Error(`blocked subcommand: ${sub}`));
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
  }

  async function resolveRepo(rawPath: unknown): Promise<{ real: string } | GitError> {
    if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) return { error: 'not absolute', status: 400 };
    let real: string;
    try { real = await fs.realpath(rawPath); } catch { return { error: 'not found', status: 404 }; }
    if (!rootOf(real, await rootsP)) return { error: 'outside home', status: 400 };
    return { real };
  }

  async function isRepo(dir: string): Promise<boolean> {
    try { return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; }
    catch { return false; }
  }

  // `realDir` is used for git operations; `displayPath` is what we expose (the caller's original path,
  // avoiding macOS /private/var vs /var confusion when the caller passed a non-realpath'd path).
  async function repoMeta(realDir: string, displayPath?: string | null): Promise<GitRepo> {
    const p = displayPath ?? realDir;
    let branch = 'HEAD';
    try { branch = (await git(realDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* empty repo */ }
    let dirty = false;
    try { dirty = (await git(realDir, ['status', '--porcelain'])).trim().length > 0; } catch { /* ignore */ }
    return { name: basename(p), path: p, branch, dirty };
  }

  async function detectRepos(rawDir: unknown): Promise<{ repos: GitRepo[] } | GitError> {
    const r = await resolveRepo(rawDir);
    if ('error' in r) return r;
    if (await isRepo(r.real)) return { repos: [await repoMeta(r.real, rawDir as string)] };
    const repos: GitRepo[] = [];
    let dirents: Dirent[] = [];
    try { dirents = await fs.readdir(r.real, { withFileTypes: true }); } catch { /* ignore */ }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const child = join(r.real, d.name);
      const childDisplay = join(rawDir as string, d.name);
      if (await isRepo(child)) repos.push(await repoMeta(child, childDisplay));
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return { repos };
  }

  async function status(rawRepo: unknown): Promise<{ changes: GitChange[] } | GitError> {
    const r = await resolveRepo(rawRepo);
    if ('error' in r) return r;
    if (!(await isRepo(r.real))) return { error: 'not a repo', status: 400 };
    let out: string;
    try { out = await git(r.real, ['status', '--porcelain']); }
    catch { return { error: 'git error', status: 500 }; }
    const changes = out.split('\n').filter(Boolean).map((line) => {
      const x = line[0] ?? '', y = line[1] ?? '';
      let path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      if (arrow >= 0) path = path.slice(arrow + 4);
      return { x: x === ' ' ? '' : x, y: y === ' ' ? '' : y, path };
    });
    return { changes };
  }

  const SEP = '\x1f';

  // 分支 / ref 名校验:挡选项注入(开头 '-')、路径穿越('..')、NUL,并限定到安全字符子集。
  // 只读 git log 用,失败时 git 自己会再拒一次。
  function safeRef(ref: unknown): string | null {
    if (typeof ref !== 'string' || !ref) return null;
    if (ref[0] === '-' || ref.includes('..') || ref.includes('\0')) return null;
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return null;
    return ref;
  }

  async function log(rawRepo: unknown, limit: unknown = 50, ref?: unknown): Promise<{ commits: GitCommitSummary[] } | GitError> {
    const r = await resolveRepo(rawRepo);
    if ('error' in r) return r;
    if (!(await isRepo(r.real))) return { error: 'not a repo', status: 400 };
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const safeR = ref == null || ref === '' ? null : safeRef(ref);
    if (ref && !safeR) return { error: 'bad ref', status: 400 };
    const args = ['log', `-n${n}`, `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ar`];
    if (safeR) args.push(safeR); // git log <ref> …(指定分支只读看历史,不动工作树)
    let out = '';
    try { out = await git(r.real, args); }
    catch { return { commits: [] }; } // 空仓库(无提交)/ 无此 ref → 空列表
    const commits = out.split('\n').filter(Boolean).map((line) => {
      const [hash = '', short = '', subject = '', author = '', relDate = ''] = line.split(SEP);
      return { hash, short, subject, author, relDate };
    });
    return { commits };
  }

  async function branches(rawRepo: unknown): Promise<{ branches: GitBranch[] } | GitError> {
    const r = await resolveRepo(rawRepo);
    if ('error' in r) return r;
    if (!(await isRepo(r.real))) return { error: 'not a repo', status: 400 };
    const fmt = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)'].join(SEP);
    let out: string;
    try { out = await git(r.real, ['for-each-ref', `--format=${fmt}`, 'refs/heads']); }
    catch { return { branches: [] }; }
    const branches = out.split('\n').filter(Boolean).map((line) => {
      const [name = '', head = '', upstream = '', track = ''] = line.split(SEP);
      const ahead = Number((track.match(/ahead (\d+)/) || [])[1] || 0);
      const behind = Number((track.match(/behind (\d+)/) || [])[1] || 0);
      return { name, current: head === '*', upstream: upstream || null, ahead, behind };
    });
    return { branches };
  }

  // 文件路径校验:相对、非绝对、不以 '-' 开头(防选项注入)、无 '..' 段、无 NUL。
  function safeRelPath(p: unknown): string | null {
    if (typeof p !== 'string' || !p || p[0] === '-' || isAbsolute(p)) return null;
    if (p.includes('\0') || p.split('/').some((seg) => seg === '..')) return null;
    return p;
  }

  const MAX_DIFF_BYTES = 512 * 1024;
  function cap(text: string): { diff: string; truncated: boolean } {
    if (text.length <= MAX_DIFF_BYTES) return { diff: text, truncated: false };
    return { diff: text.slice(0, MAX_DIFF_BYTES), truncated: true };
  }

  // diff 语义:仅 path → 工作区 vs HEAD;staged → 暂存区 vs HEAD;commit → 该提交 vs 其父。
  async function diff(rawRepo: unknown, { path, commit, staged }: GitDiffOptions = {}): Promise<{ diff: string; truncated: boolean } | GitError> {
    const r = await resolveRepo(rawRepo);
    if ('error' in r) return r;
    if (!(await isRepo(r.real))) return { error: 'not a repo', status: 400 };
    const rel = safeRelPath(path);
    if (!rel) return { error: 'bad path', status: 400 };
    let args: string[];
    if (commit) {
      if (typeof commit !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(commit)) return { error: 'bad commit', status: 400 };
      args = ['show', '--format=', commit, '--', rel];
    } else if (staged) {
      args = ['diff', '--staged', '--', rel];
    } else {
      args = ['diff', 'HEAD', '--', rel];
    }
    let out = '';
    try { out = await git(r.real, args); } catch (e) { return { error: 'diff failed', status: 500 }; }
    return cap(out);
  }

  async function commit(rawRepo: unknown, hash: unknown): Promise<{ message: string; files: GitChange[] } | GitError> {
    const r = await resolveRepo(rawRepo);
    if ('error' in r) return r;
    if (!(await isRepo(r.real))) return { error: 'not a repo', status: 400 };
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(hash)) return { error: 'bad commit', status: 400 };
    let message: string;
    let ns: string;
    try {
      message = (await git(r.real, ['show', '-s', '--format=%B', hash])).trim();
      // --root 让首次提交(无父)也能列出文件。
      ns = await git(r.real, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', hash]);
    } catch { return { error: 'git error', status: 500 }; }
    const files = ns.split('\n').filter(Boolean).map((line) => {
      const [code = '', ...rest] = line.split('\t');
      return { x: code[0] ?? '', y: '', path: rest[rest.length - 1] ?? '' };
    }).filter((file) => file.path);
    return { message, files };
  }

  return { resolveRepo, isRepo, detectRepos, status, log, branches, diff, commit };
}

export const defaultGit = createGit({ home: homedir(), extraRoots: defaultExtraRoots() });
