// Detect "orphan" coding-agent sessions: a `claude`/`codex`/… process running on this host that is NOT
// inside a tmux pane, so handmux can't see or steer it. We can't migrate a live process into tmux (reptyr
// needs Linux ptrace+/proc — out on macOS — and breaks on multithreaded Node + child processes), so instead
// we surface these in the Inbox and offer a "takeover": spawn the agent's `resume` command in a fresh tmux
// pane (the agent's own persistence continues the conversation), then optionally kill the original.
//
// Detection is process-based, NOT a scan of the agents' session history (which is unbounded and can't tell
// a live session from a dead one). Cost scales with the number of LIVE agent processes only.
//
// tmux membership is decided by TTY/PPID match against `tmux list-panes`, NOT by reading the process
// environment: on macOS `ps eww` can't read another process's env (SIP), so `$TMUX` is a false signal.
// A proc whose controlling tty is one of tmux's pane ttys (or whose parent is a pane's shell) is in tmux;
// anything else with a real tty is an orphan.
//
// This module is now the agent-AGNOSTIC engine: which processes count, where a cwd's session lives, and how
// to resume it all come from the driver descriptors in ./agents (parseAgentProcs tags each proc with its
// agent; scan/takeover dispatch through getAgent). The pure parse/file helpers live in ./agents/scanUtils.
import os from 'node:os';
import path from 'node:path';
import { AGENTS, getAgent } from './agents/index.js';
import { isSessionId } from './tmux/commands.js';
import {
  defaultRun, parseAgentProcs, parsePaneMembership, findOrphans,
  takeoverSessionName, isShell, lsofCwd, isSessionUuid,
} from './agents/scanUtils.js';

// Back-compat re-exports: these were originally defined here and are imported by tests and callers by this
// path. They're all agent-agnostic (or Claude's, kept as the default) and now live in scanUtils / claude.
export {
  parsePaneMembership, findOrphans, encodeProjectDir, isSessionUuid,
  lastUserSnippet, etimeToMs, takeoverSessionName,
  resolveEncodedDirSession as resolveSession,
} from './agents/scanUtils.js';
export { projectsDir as defaultProjectsDir } from './agents/claude.js';

// Parse `ps …` to LIVE Claude CLI procs only — the original Claude-specific helper, kept for the tests.
// The general engine uses parseAgentProcs(psOut, AGENTS) directly.
export function parseClaudeProcs(psOut) {
  return parseAgentProcs(psOut, [getAgent('claude')]);
}

// Take over an orphan: spawn the agent's `resume <sessionId>` in a fresh tmux session (target.mode 'new')
// or a new window of an existing session ('window'), so handmux can steer the continued conversation.
// Everything is re-verified server-side — the client's pid/sessionId are inputs to a fresh scan, never
// trusted directly. The original process is SIGTERM'd only AFTER the resumed agent is confirmed up
// (foreground command is no longer the shell) AND re-confirmed still the same orphan (guards pid reuse):
// `<agent> resume` appends to the SAME session file with no OS lock (verified for Claude), so two live
// writers corrupt history — killing guarantees a single writer. Injectable deps make it unit-testable.
export async function takeoverOrphan(
  {
    commands, scanFn = scanOrphans, scanOpts = {},
    killProc = (pid, sig) => process.kill(pid, sig),
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollTries = 16, pollMs = 400,
  },
  { pid, sessionId, target = { mode: 'new' }, kill = true } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return { error: 'bad pid', status: 400 };
  // Both agents use UUID session ids; validate up front (takeover types the id into a shell via send-keys).
  if (!isSessionUuid(sessionId)) return { error: 'bad session id', status: 400 };

  const o = (await scanFn(scanOpts)).find((x) => x.pid === pid);
  if (!o) return { error: 'gone', status: 409 };            // no longer a live orphan
  if (o.sessionId !== sessionId) return { error: 'session changed', status: 409 };
  if (!o.cwd) return { error: 'no cwd', status: 409 };
  const agent = getAgent(o.agent);
  const cmd = agent.sessions.resumeCmd(sessionId);

  let sid;
  let wid;
  let name; // the target session NAME — returned so the client can bind it into its session list
  if (target.mode === 'window') {
    if (!isSessionId(target.session)) return { error: 'bad target session', status: 400 };
    sid = target.session;
    name = (await commands.listSessions()).find((s) => s.id === sid)?.name || null;
    wid = await commands.newWindow(sid, o.cwd, agent.procName, cmd);
  } else {
    const existing = new Set((await commands.listSessions()).map((s) => s.name));
    for (let i = 1; i < 1000 && !name; i++) {
      const cand = takeoverSessionName(o.cwdLabel, i, agent.takeoverPrefix);
      if (!existing.has(cand)) name = cand;
    }
    sid = await commands.newSession(name, o.cwd, cmd);
    wid = (await commands.listWindows(sid))[0]?.id;
  }

  let up = false;
  let pane = null;
  for (let i = 0; i < pollTries && !up; i++) {
    await delay(pollMs);
    try {
      const p = (await commands.listPanes(wid))[0];
      if (p) { pane = p.id; if (!isShell(p.command)) up = true; }
    } catch { /* window/pane not ready yet */ }
  }

  let killed = false;
  if (kill && up) {
    const still = (await scanFn(scanOpts)).find((x) => x.pid === pid && x.sessionId === sessionId);
    if (still) { try { killProc(pid, 'SIGTERM'); killed = true; } catch { /* already exited */ } }
  }
  // claudeUp kept in the response for back-compat with the existing web client; agentUp is the neutral name.
  return { session: sid, name, window: wid, pane, agentUp: up, claudeUp: up, killed, agent: agent.id };
}

// Scan the host for orphan agent sessions across every registered driver. Best-effort: any failing
// sub-command degrades to fewer/no results rather than throwing. `projectsDir`/`sessionsDir` override a
// specific agent's session dir (each driver declares which option key it reads — used by tests and the
// server, which pin the dir off the resolved $HOME).
export async function scanOrphans({
  run = defaultRun, home = os.homedir(), busyMs = 8000, now = Date.now, agents = AGENTS, ...dirOverrides
} = {}) {
  const [psOut, tmuxOut] = await Promise.all([
    run('ps', ['-Ao', 'pid=,ppid=,stat=,etime=,tty=,args=']),
    run('tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_pid}']),
  ]);
  const orphans = findOrphans(parseAgentProcs(psOut, agents), parsePaneMembership(tmuxOut));
  const results = [];
  for (const o of orphans) {
    const agent = getAgent(o.agent);
    const cwd = await lsofCwd(run, o.pid);
    const dir = dirOverrides[agent.sessions.dirOptKey] || agent.sessions.dir(home);
    const meta = cwd ? await agent.sessions.resolve(dir, cwd, { busyMs, now }) : {};
    results.push({
      pid: o.pid,
      agent: agent.id,
      agentLabel: agent.label,
      cwd: cwd || '',
      cwdLabel: cwd ? path.basename(cwd) : '',
      sessionId: meta.sessionId || null,
      state: meta.state || 'unknown',
      snippet: meta.snippet || '',
      lastActivity: meta.lastActivity || 0,
      startedAt: o.etimeMs ? Math.round(now() - o.etimeMs) : 0,
    });
  }
  return results;
}
