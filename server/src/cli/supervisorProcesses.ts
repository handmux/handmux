// Process-table backstop for the single-instance invariant. state.json is deliberately only one record,
// so an older restart race can leave a live supervisor that is no longer referenced there. Scan the real
// argv instead: every packaged/manual/service supervisor has this stable signature across install paths.
import { spawnSync } from 'node:child_process';

export function parseSupervisorPids(psOut: unknown): number[] {
  const pids: number[] = [];
  for (const line of String(psOut).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    const pidText = m?.[1];
    const state = m?.[2];
    const args = m?.[3];
    if (!pidText || !state || !args || state[0] === 'Z') continue;
    // Anchor the executable as Node and handmux.js as its direct script argument. A shell command or test
    // runner can contain the same words in its own command text; it is not a supervisor and must not match.
    if (/^(?:\S*\/)?node(?:js)?\s+(?:"[^"]*(?:handmux\.js|\/handmux)"|'[^']*(?:handmux\.js|\/handmux)'|\S*(?:handmux\.js|\/handmux))\s+__supervise\s+--payload(?:-file)?(?:\s|$)/.test(args)) {
      pids.push(Number(pidText));
    }
  }
  return [...new Set(pids)].sort((a, b) => a - b);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type SupervisorScanResult =
  | { ok: true; pids: number[] }
  | { ok: false; pids: [] };

export type SupervisorTerminationResult =
  | { ok: true; pids: number[]; remaining: [] }
  | { ok: false; reason: 'scan' | 'timeout'; pids: number[]; remaining: number[] };

interface TerminateSupervisorOptions {
  scan?: () => SupervisorScanResult;
  kill?: (pid: number) => void;
  waitFn?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

// Terminate an initial snapshot and keep rescanning: a duplicate that was not in state.json, or one that
// appears during cleanup, is folded into `seen` and signalled too. Pure dependencies make the race/timeout
// behavior unit-testable without touching real processes.
export async function terminateSupervisorPids(initialPids: readonly number[], {
  scan = scanSupervisorPids,
  kill = (pid) => process.kill(pid, 'SIGTERM'),
  waitFn = wait,
  now = Date.now,
  timeoutMs = 4500,
}: TerminateSupervisorOptions = {}): Promise<SupervisorTerminationResult> {
  const seen = new Set(initialPids);
  const signal = (pid: number): void => { try { kill(pid); } catch { /* raced away / not ours */ } };
  for (const pid of seen) signal(pid);
  const deadline = now() + timeoutMs;
  for (;;) {
    const current = scan();
    if (!current.ok) return { ok: false, reason: 'scan', pids: [...seen], remaining: [] };
    if (!current.pids.length) return { ok: true, pids: [...seen].sort((a, b) => a - b), remaining: [] };
    for (const pid of current.pids) { seen.add(pid); signal(pid); }
    if (now() >= deadline) {
      return { ok: false, reason: 'timeout', pids: [...seen].sort((a, b) => a - b), remaining: current.pids };
    }
    await waitFn(100);
  }
}

interface ProcessTableResult {
  status: number | null;
  stdout: unknown;
}

interface ScanSupervisorOptions {
  run?: (command: string, args: readonly string[], options: { encoding: 'utf8' }) => ProcessTableResult | null | undefined;
}

export function scanSupervisorPids({ run = spawnSync }: ScanSupervisorOptions = {}): SupervisorScanResult {
  try {
    // `-x` includes this user's detached/no-TTY daemons without crossing into other users' processes.
    const r = run('ps', ['-x', '-o', 'pid=,stat=,args='], { encoding: 'utf8' });
    if (!r || r.status !== 0) return { ok: false, pids: [] };
    return { ok: true, pids: parseSupervisorPids(r.stdout) };
  } catch {
    return { ok: false, pids: [] };
  }
}
