// Detect "orphan" Claude Code sessions: a `claude` process running on this host that is NOT inside a
// tmux pane, so handmux can't see or steer it. We can't migrate a live process into tmux (reptyr needs
// Linux ptrace+/proc — out on macOS — and breaks on multithreaded Node + child processes), so instead
// we surface these in the Inbox and offer a "takeover": spawn `claude --resume <sessionId>` in a fresh
// tmux pane (Claude's own persistence continues the conversation), then optionally kill the original.
//
// Detection is process-based, NOT a scan of ~/.claude/projects (which is unbounded history and can't
// tell a live session from a dead one). Cost scales with the number of LIVE claude processes only.
//
// tmux membership is decided by TTY/PPID match against `tmux list-panes`, NOT by reading the process
// environment: on macOS `ps eww` can't read another process's env (SIP), so `$TMUX` is a false signal.
// A claude whose controlling tty is one of tmux's pane ttys (or whose parent is a pane's shell) is in
// tmux; anything else with a real tty is an orphan.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Tolerant promisified execFile: resolves '' on any error (no server, missing binary, non-zero exit).
// Detection is best-effort and must never throw the whole request.
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

export const defaultProjectsDir = (home = os.homedir()) => path.join(home, '.claude', 'projects');

// A Claude session id is the jsonl filename (a UUID). Validate strictly: takeover types
// `claude --resume <id>` into a shell via send-keys, so a non-UUID id would be a shell-injection vector.
export const isSessionUuid = (s) =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Strip /dev/ and fold "no controlling terminal" markers (macOS '??', Linux '?') to '' so ps ttys and
// tmux pane_ttys compare equal: ps 'ttys010' / tmux '/dev/ttys010' → 'ttys010'; ps 'pts/3' / tmux
// '/dev/pts/3' → 'pts/3'.
function normTty(t) {
  const s = String(t || '').trim();
  if (!s || s === '??' || s === '?' || s === '-') return '';
  return s.replace(/^\/dev\//, '');
}

// The `claude` CLI sets its process title to "claude" (verified via ps), so match the program token at
// the start of argv: bare "claude", "claude --continue", or an absolute path ending in /claude. Anchored
// so "vim claude.js" / "node build/claude.js" don't match.
const CLAUDE_ARGS = /^(\S*\/)?claude(\s|$)/;

// Parse `ps -Ao pid=,ppid=,stat=,tty=,args=` → LIVE claude processes only. args (last column) may
// contain spaces. STOPPED (STAT 'T', a Ctrl-Z-suspended job-control stack — verified real: one terminal
// can hold 8 suspended `claude`s) and ZOMBIE ('Z') processes are dropped: they aren't active sessions to
// steer, and a suspended original can't write its jsonl so there's nothing to race. Everything else
// (R/S/I/D…) is a live session.
export function parseClaudeProcs(psOut) {
  const out = [];
  for (const line of String(psOut).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const stat = m[3];
    if (stat[0] === 'T' || stat[0] === 'Z') continue;
    const args = m[5].trim();
    if (!CLAUDE_ARGS.test(args)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: normTty(m[4]), args });
  }
  return out;
}

// Parse `tmux list-panes -a -F '#{pane_tty}\t#{pane_pid}'` → the set of pane ttys and pane (shell) pids.
export function parsePaneMembership(tmuxOut) {
  const ttys = new Set();
  const pids = new Set();
  for (const line of String(tmuxOut).split('\n')) {
    if (!line) continue;
    const [tty, pid] = line.split('\t');
    const nt = normTty(tty);
    if (nt) ttys.add(nt);
    const n = Number(pid);
    if (n) pids.add(n);
  }
  return { ttys, pids };
}

// Orphan = a claude WITH a real controlling tty that is neither one of tmux's pane ttys nor a child of a
// pane's shell. The tty requirement drops background/headless claudes (SDK/`-p` piped, tty '') — those
// aren't interactive sessions a user would "take over".
export function findOrphans(procs, membership) {
  return procs.filter(
    (p) => p.tty && !membership.ttys.has(p.tty) && !membership.pids.has(p.ppid),
  );
}

// A real cwd → its ~/.claude/projects directory name. Claude replaces every non-alphanumeric char with
// '-' (verified: '/home/user/handmux' → '-home-user-handmux'; both '/'
// and '_' fold to '-'). The mapping is LOSSY (not reversible), so we only ever encode forward, then
// confirm each candidate jsonl's recorded `cwd` matches before trusting it.
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Read the last `bytes` of a file (for the trailing conversation). The first line of the chunk may be
// truncated mid-JSON — callers skip lines that don't parse.
async function readTail(file, bytes = 65536) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Read the first `bytes` of a file (the session header carries `cwd` early).
async function readHead(file, bytes = 65536) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

// Pull the last user-typed message text out of a jsonl tail, for a recognizable one-line label. Entries
// are line-delimited JSON; conversational turns are type 'user' with message.role 'user', whose content
// is either a string or an array of blocks ({type:'text',text}). Meta rows (last-prompt/ai-title/mode/
// attachment/summary) are ignored. Scans newest-first.
export function lastUserSnippet(tailText, max = 80) {
  const rows = String(tailText).split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i].trim();
    if (!line || line[0] !== '{') continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || !d.message || d.message.role !== 'user') continue;
    const c = d.message.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
}

const firstCwd = (headText) => {
  const m = String(headText).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
};

// Resolve a live orphan's cwd to its Claude session: the newest jsonl in the encoded project dir whose
// recorded cwd matches (guards against the lossy encoding colliding two real paths). Returns sessionId,
// a busy/idle guess (from mtime recency — refined for the takeover gate in step 2), the last user
// snippet, and the last-activity timestamp.
export async function resolveSession(projectsDir, cwd, { busyMs = 8000, now = Date.now } = {}) {
  const dir = path.join(projectsDir, encodeProjectDir(cwd));
  let names;
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return {}; }
  const stats = [];
  for (const n of names) {
    try { stats.push({ n, mtime: (await fsp.stat(path.join(dir, n))).mtimeMs }); } catch { /* gone */ }
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  for (const { n, mtime } of stats) {
    const file = path.join(dir, n);
    let head;
    try { head = await readHead(file); } catch { continue; }
    if (firstCwd(head) !== cwd) continue; // different real path collided onto the same dir → skip
    let snippet = '';
    try { snippet = lastUserSnippet(await readTail(file)); } catch { /* best effort */ }
    return {
      sessionId: n.replace(/\.jsonl$/, ''),
      state: now() - mtime < busyMs ? 'busy' : 'idle',
      snippet,
      lastActivity: Math.round(mtime),
    };
  }
  return {};
}

async function lsofCwd(run, pid) {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  for (const line of out.split('\n')) if (line[0] === 'n') return line.slice(1).trim();
  return '';
}

// Scan the host for orphan claude sessions. Best-effort: any failing sub-command degrades to fewer/no
// results rather than throwing.
export async function scanOrphans({
  run = defaultRun, projectsDir = defaultProjectsDir(), busyMs = 8000, now = Date.now,
} = {}) {
  const [psOut, tmuxOut] = await Promise.all([
    run('ps', ['-Ao', 'pid=,ppid=,stat=,tty=,args=']),
    run('tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_pid}']),
  ]);
  const orphans = findOrphans(parseClaudeProcs(psOut), parsePaneMembership(tmuxOut));
  const results = [];
  for (const o of orphans) {
    const cwd = await lsofCwd(run, o.pid);
    const meta = cwd ? await resolveSession(projectsDir, cwd, { busyMs, now }) : {};
    results.push({
      pid: o.pid,
      cwd: cwd || '',
      cwdLabel: cwd ? path.basename(cwd) : '',
      sessionId: meta.sessionId || null,
      state: meta.state || 'unknown',
      snippet: meta.snippet || '',
      lastActivity: meta.lastActivity || 0,
    });
  }
  return results;
}
