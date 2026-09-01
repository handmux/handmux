import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn as spawnChild } from 'node:child_process';

const PANE_RE = /^%\d+$/;

export interface ManagedChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: unknown) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
}

export interface ManagedSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | ['ignore', 'ignore', 'ignore'];
}

export type ManagedSpawn = (
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions,
) => ManagedChild;

interface WaitForSocketOptions {
  exists?: (socketPath: string) => boolean;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

interface RunManagedCodexOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: ManagedSpawn;
  mkdir?: (directory: string) => unknown;
  unlink?: (file: string) => unknown;
  waitOptions?: WaitForSocketOptions;
}

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export function codexAppSocketPath(pane: unknown, home: string = os.homedir()): string {
  if (typeof pane !== 'string' || !PANE_RE.test(pane)) throw new Error('managed Codex requires a tmux pane');
  return path.join(home, '.handmux', 'codex-app', `${pane.slice(1)}.sock`);
}

function waitForSocket(socketPath: string, child: ManagedChild, {
  exists = fs.existsSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 5_000,
  now = Date.now,
}: WaitForSocketOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let exited = false;
    let exitCode = null;
    child.once('exit', (code) => { exited = true; exitCode = code; });
    child.once('error', reject);
    (async () => {
      const started = now();
      while (!exists(socketPath)) {
        if (exited) throw new Error(`Codex App Server exited before startup (${exitCode ?? 'unknown'})`);
        if (now() - started >= timeoutMs) throw new Error('Codex App Server startup timed out');
        await wait(25);
      }
      resolve();
    })().catch(reject);
  });
}

function finish(child: ManagedChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

// One App Server belongs to one tmux pane. The TUI and Handmux connect to that pane-owned Unix socket,
// so thread identity, messages, approvals, settings, interrupts and inbox state share one runtime.
export async function runManagedCodexProcess(args: readonly string[] = [], {
  home = os.homedir(),
  env = process.env,
  spawn = spawnChild as unknown as ManagedSpawn,
  mkdir = (dir: string) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  unlink = (file: string) => { try { fs.unlinkSync(file); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; } },
  waitOptions,
}: RunManagedCodexOptions = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const pane = env.TMUX_PANE;
  const socketPath = codexAppSocketPath(pane, home);
  mkdir(path.dirname(socketPath));
  unlink(socketPath);

  const managedEnv = { ...env, HANDMUX_CODEX_MANAGED: '1' };
  const appServer = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
    env: managedEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let tui: ManagedChild | null = null;
  try {
    await waitForSocket(socketPath, appServer, waitOptions);
    tui = spawn('codex', ['--remote', `unix://${socketPath}`, ...args], {
      env: managedEnv,
      stdio: 'inherit',
    });
    return await finish(tui);
  } finally {
    if (tui && tui.exitCode == null && tui.signalCode == null) tui.kill('SIGTERM');
    if (appServer.exitCode == null && appServer.signalCode == null) appServer.kill('SIGTERM');
    unlink(socketPath);
  }
}

export async function runManagedCodex(
  args: readonly string[] = [],
  options: RunManagedCodexOptions = {},
): Promise<number> {
  const result = await runManagedCodexProcess(args, options);
  return typeof result.code === 'number' && Number.isInteger(result.code) ? result.code : 1;
}
