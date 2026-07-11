// Agent-agnostic scan/parse helpers shared by every agent driver and the orphan engine. This is the LEAF
// layer: it imports nothing from the agent registry, so drivers (claude.js / codex.js) and the engine
// (orphans.js) can all depend on it without an import cycle.
//
// Everything here is about turning `ps`/`tmux`/`lsof` output and session jsonl files into structured data;
// none of it knows which coding agent it's looking at — the per-agent specifics (which process name, where
// sessions live, how to resume) live in the driver descriptors that USE these helpers.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

// Tolerant promisified execFile: resolves '' on any error (no server, missing binary, non-zero exit).
// Detection is best-effort and must never throw the whole request.
export function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

// A coding-agent session id is a UUID (Claude's jsonl filename; Codex's rollout-file trailing id). Validate
// strictly: takeover types `<bin> resume <id>` into a shell via send-keys, so a non-UUID id would be a
// shell-injection vector.
export const isSessionUuid = (s) =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Strip /dev/ and fold "no controlling terminal" markers (macOS '??', Linux '?') to '' so ps ttys and
// tmux pane_ttys compare equal: ps 'ttys010' / tmux '/dev/ttys010' → 'ttys010'; ps 'pts/3' / tmux
// '/dev/pts/3' → 'pts/3'.
export function normTty(t) {
  const s = String(t || '').trim();
  if (!s || s === '??' || s === '?' || s === '-') return '';
  return s.replace(/^\/dev\//, '');
}

// ps `etime` (elapsed since start) → milliseconds. Formats (macOS + Linux, no spaces): "MM:SS",
// "HH:MM:SS", "DD-HH:MM:SS". Used only to derive a startedAt for display/recognition (the "A加成"),
// NOT for session attribution — a resumed session's process starts long after its jsonl's first event.
export function etimeToMs(etime) {
  const s = String(etime).trim();
  if (!s) return 0;
  let days = 0;
  let rest = s;
  const dash = s.indexOf('-');
  if (dash >= 0) { days = Number(s.slice(0, dash)) || 0; rest = s.slice(dash + 1); }
  let sec = 0;
  for (const p of rest.split(':')) sec = sec * 60 + (Number(p) || 0);
  return (days * 86400 + sec) * 1000;
}

// Parse `ps -Ao pid=,ppid=,stat=,etime=,tty=,args=` → LIVE agent processes only, each tagged with the id of
// the FIRST driver whose `procMatch` regex matches its argv. `agents` is the driver list; a proc matching
// none is dropped. args (last column) may contain spaces; etime has none. STOPPED (STAT 'T', a Ctrl-Z-
// suspended job-control stack — verified real: one terminal can hold 8 suspended `claude`s) and ZOMBIE
// ('Z') processes are dropped: they aren't active sessions to steer, and a suspended original can't write
// its jsonl so there's nothing to race.
export function parseAgentProcs(psOut, agents) {
  const out = [];
  for (const line of String(psOut).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const stat = m[3];
    if (stat[0] === 'T' || stat[0] === 'Z') continue;
    const args = m[6].trim();
    const agent = agents.find((a) => a.procMatch.test(args));
    if (!agent) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), etimeMs: etimeToMs(m[4]), tty: normTty(m[5]), args, agent: agent.id });
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

// Orphan = an agent proc WITH a real controlling tty that is neither one of tmux's pane ttys nor a child of
// a pane's shell. The tty requirement drops background/headless runs (SDK/`-p`/`exec` piped, tty '') —
// those aren't interactive sessions a user would "take over".
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
export async function readTail(file, bytes = 65536) {
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
export async function readHead(file, bytes = 65536) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

// First `"cwd":"..."` anywhere in a chunk (both Claude and Codex record the session cwd early in the file).
export function firstCwd(headText) {
  const m = String(headText).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

// Pull the last user-typed message text out of a Claude jsonl tail, for a recognizable one-line label.
// Entries are line-delimited JSON; conversational turns are type 'user' with message.role 'user', whose
// content is either a string or an array of blocks ({type:'text',text}). Meta rows (last-prompt/ai-title/
// mode/attachment/summary) are ignored. Scans newest-first.
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

// Resolve a cwd to the newest jsonl in its ENCODED project dir whose recorded cwd matches (guards against
// the lossy encoding colliding two real paths). This is Claude's layout (~/.claude/projects/<enc-cwd>/
// <uuid>.jsonl); Codex has its own resolver. `snippet` extracts the last user turn (parser injected so
// each agent's jsonl shape is handled). Returns sessionId, a busy/idle guess (mtime recency), the snippet,
// and the last-activity timestamp; {} when the dir is absent or nothing matches.
export async function resolveEncodedDirSession(
  projectsDir, cwd, { busyMs = 8000, now = Date.now, snippet = lastUserSnippet } = {},
) {
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
    let snip = '';
    try { snip = snippet(await readTail(file)); } catch { /* best effort */ }
    return {
      sessionId: n.replace(/\.jsonl$/, ''),
      state: now() - mtime < busyMs ? 'busy' : 'idle',
      snippet: snip,
      lastActivity: Math.round(mtime),
    };
  }
  return {};
}

// A tmux session name derived from a cwd basename, kept within isValidSessionName ([A-Za-z0-9-], ≤16):
// `<prefix>-<alnum label, ≤8>-<n>`. n disambiguates against existing sessions.
export function takeoverSessionName(cwdLabel, n, prefix = 'cc') {
  const base = String(cwdLabel || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || prefix;
  return `${prefix}-${base}-${n}`.slice(0, 16);
}

// Coerce a user-typed takeover name into a valid tmux session name (isValidSessionName: [A-Za-z0-9-], ≤16):
// non-alnum runs → a single '-', trimmed of edge hyphens, capped at 16. Returns '' if nothing usable is
// left (caller then falls back to the generated name).
export function sanitizeSessionName(s) {
  return String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '');
}

// First name in `<base>, base-2, base-3, …` (each capped at 16) that isn't already taken. null if none free.
export function freeSessionName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`.slice(0, 16);
    if (!taken.has(cand)) return cand;
  }
  return null;
}

export const isShell = (c) => /^-?(zsh|bash|sh|fish|dash|tcsh|csh|ksh)$/.test(String(c || ''));

export async function lsofCwd(run, pid) {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  for (const line of out.split('\n')) if (line[0] === 'n') return line.slice(1).trim();
  return '';
}
