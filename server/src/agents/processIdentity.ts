import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { normTty } from './scanUtils.js';
import type { RunCommand } from './scanUtils.js';

export interface ProcessPane {
  cmd?: string;
  tty?: string;
  [key: string]: unknown;
}
export interface ExecutableVerdict {
  ok: boolean;
  pid: string | null;
  signature: string;
  expiresAt: number;
}
export interface ResolveExecutableOptions {
  candidate(command: string): boolean;
  normalized: string;
  matches(executable: string, command: string): boolean;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
}
interface ForegroundProcess { tty: string; pid: string }

const SUCCESS_TTL_MS = 30_000;
const FAILURE_TTL_MS = 3_000;

// Real executable path of a pid. lsof resolves launch symlinks on macOS; /proc is the cheap Linux path.
// A transient lsof failure is inconclusive, not a negative identity verdict that should escape the call.
export async function executablePath(run: RunCommand, pid: string | number): Promise<string> {
  let out = '';
  try { out = await run('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']); } catch { /* try /proc */ }
  for (const line of String(out).split('\n')) if (line[0] === 'n') return line.slice(1).trim();
  try { return await fsp.readlink(`/proc/${pid}/exe`); } catch { return ''; }
}

function parseForegroundProcesses(out: unknown): ForegroundProcess[] {
  const rows: ForegroundProcess[] = [];
  for (const line of String(out).split('\n')) {
    const m = line.match(/^\s*(\S+)\s+(\d+)\s+(\S+)\s*$/);
    if (!m) continue;
    const [, rawTty, pid, stat] = m;
    if (!rawTty || !pid || !stat) continue;
    const tty = normTty(rawTty);
    if (tty && stat.includes('+')) rows.push({ tty, pid });
  }
  return rows;
}

// Normalize ambiguous tmux pane_current_command values only after tying the pane's TTY to a foreground
// process whose REAL executable proves the agent identity. Every call refreshes the cheap ps snapshot;
// the cache only skips lsof while the exact foreground pid set is unchanged and its short TTL is live.
// This makes TTY reuse/process replacement invalidate immediately, and failed probes retry quickly.
export async function resolveByExecutable<T extends ProcessPane>(
  panes: T[],
  run: RunCommand,
  verdicts: Map<string, ExecutableVerdict>,
  {
  candidate,
  normalized,
  matches,
  now = () => Date.now(),
  successTtlMs = SUCCESS_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
  }: ResolveExecutableOptions,
): Promise<T[]> {
  const candidates = panes.filter((p) => p && p.tty && candidate(p.cmd || ''));
  if (!candidates.length) return panes;

  const rows = parseForegroundProcesses(await run('ps', ['-Ao', 'tty=,pid=,stat=']));
  for (const pane of candidates) {
    const tty = normTty(pane.tty);
    const procs = rows.filter((r) => r.tty === tty);
    const signature = procs.map((r) => r.pid).sort().join(',');
    const key = `${normalized}|${tty}|${pane.cmd}`;
    const cached = verdicts.get(key);
    if (cached && cached.signature === signature && cached.expiresAt > now()) {
      if (cached.ok) pane.cmd = normalized;
      continue;
    }

    let ok = false;
    let matchedPid = null;
    for (const proc of procs) {
      const exe = await executablePath(run, proc.pid);
      if (matches(exe, pane.cmd || '')) { ok = true; matchedPid = proc.pid; break; }
    }
    verdicts.set(key, {
      ok,
      pid: matchedPid,
      signature,
      expiresAt: now() + (ok ? successTtlMs : failureTtlMs),
    });
    if (ok) pane.cmd = normalized;
  }
  return panes;
}

export const executableBasename = (file: unknown): string => path.basename(String(file || ''));
