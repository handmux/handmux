import { spawn as spawnChild } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, writeJsonAtomic } from './atomicJson.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANE_RE = /^%\d+$/;
const RUNNER_FILE = fileURLToPath(import.meta.url);
const HANDMUX_BIN = fileURLToPath(new URL('../../bin/handmux.js', import.meta.url));

export interface AgentRequest {
  cmd: 'claude' | 'codex';
  args: [string, string];
}
export type AgentReadiness = { status: 'ready' } | { status: 'failed'; error: string };
export interface AgentCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}
export interface LaunchedAgent {
  child: ReturnType<typeof spawnChild> | null;
  ready: Promise<AgentReadiness>;
  completion: Promise<AgentCompletion>;
  terminate(): Promise<AgentCompletion>;
}
interface ErrorCode { code?: unknown }
type TimerHandle = unknown;
type SetTimer = (callback: () => void, delay: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as ErrorCode).code : undefined;
}

export function validateAgentRequest(input: unknown): AgentRequest {
  const request = recordOf(input);
  const args = request?.args;
  const cmd = request?.cmd;
  const valid = cmd === 'claude'
    ? Array.isArray(args) && args.length === 2 && args[0] === '--resume' && typeof args[1] === 'string' && UUID_RE.test(args[1])
    : cmd === 'codex'
      && Array.isArray(args) && args.length === 2 && args[0] === 'resume' && typeof args[1] === 'string' && UUID_RE.test(args[1]);
  if (!valid) throw new Error('unsafe agent request');
  const validArgs = args as [string, string];
  return { cmd: cmd as AgentRequest['cmd'], args: [validArgs[0], validArgs[1]] };
}

function earlyFailure(request: AgentRequest, error: unknown, code?: number | null): string {
  if (errorCode(error) === 'ENOENT') return `${request.cmd} binary not found`;
  if (error) return `${request.cmd} failed to start: ${errorText(error)}`;
  return `${request.cmd} exited ${code ?? 'unknown'} before ready`;
}

export function launchAgentRequest(requestInput: unknown, {
  spawn = spawnChild,
  readinessMs = 500,
  setTimeout = globalThis.setTimeout as SetTimer,
  clearTimeout = globalThis.clearTimeout as ClearTimer,
}: {
  spawn?: typeof spawnChild;
  readinessMs?: number;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
} = {}): LaunchedAgent {
  const request = validateAgentRequest(requestInput);
  let child: ReturnType<typeof spawnChild>;
  let readyDone = false;
  let timer: TimerHandle | null = null;
  let completionDone = false;
  let settleReady!: (value: AgentReadiness) => void;
  let settleCompletion!: (value: AgentCompletion) => void;
  const ready = new Promise<AgentReadiness>((resolve) => { settleReady = resolve; });
  const completion = new Promise<AgentCompletion>((resolve) => { settleCompletion = resolve; });
  const finishCompletion = (value: AgentCompletion): void => {
    if (completionDone) return;
    completionDone = true;
    settleCompletion(value);
  };
  const failReady = (error: unknown, code?: number | null): void => {
    if (readyDone) return;
    readyDone = true;
    if (timer) clearTimeout(timer);
    settleReady({ status: 'failed', error: earlyFailure(request, error, code) });
  };
  try {
    const command = request.cmd === 'codex' ? process.execPath : request.cmd;
    const args = request.cmd === 'codex' ? [HANDMUX_BIN, 'codex', ...request.args] : request.args;
    child = spawn(command, args, { stdio: 'inherit', shell: false });
  } catch (error) {
    failReady(error);
    finishCompletion({ code: null, signal: null, error: errorText(error) });
    return { child: null, ready, completion, terminate: async () => completion };
  }
  child.once('spawn', () => {
    timer = setTimeout(() => {
      if (readyDone) return;
      readyDone = true;
      settleReady({ status: 'ready' });
    }, readinessMs);
  });
  child.once('error', (error) => {
    failReady(error);
    finishCompletion({ code: null, signal: null, error: errorText(error) });
  });
  child.once('exit', (code, signal) => {
    failReady(null, code);
    finishCompletion({ code, signal });
  });
  return {
    child,
    ready,
    completion,
    async terminate() {
      if (!completionDone) child.kill('SIGTERM');
      return completion;
    },
  };
}

export async function publishAgentReadiness(
  launched: LaunchedAgent,
  writeStatus: (status: AgentReadiness) => unknown | Promise<unknown>,
): Promise<AgentReadiness> {
  const ready = await launched.ready;
  try {
    await writeStatus(ready);
  } catch (error) {
    let cleanupError;
    try { await launched.terminate(); } catch (failure) { cleanupError = failure; }
    if (cleanupError) throw new Error(`${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`);
    throw error;
  }
  return ready;
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function unlinkIfPresent(fs: typeof fsp, file: string): Promise<void> {
  try { await fs.unlink(file); } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function createAgentRunner({
  home = os.homedir(),
  fs = fsp,
  now = Date.now,
  wait = delay,
  timeoutMs = 3_000,
  pollMs = 25,
}: {
  home?: string;
  fs?: typeof fsp;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
} = {}) {
  const dir = path.join(home, '.handmux', 'workspaces', 'agent-runs');
  const command = `${shellQuote(process.execPath)} ${shellQuote(RUNNER_FILE)}`;
  const files = (paneId: string): { request: string; status: string } => {
    if (!PANE_RE.test(paneId)) throw new Error('invalid agent runner pane id');
    const base = paneId.slice(1);
    return { request: path.join(dir, `${base}.request.json`), status: path.join(dir, `${base}.status.json`) };
  };
  return {
    command,
    async prepare({ paneId, cmd, args }: { paneId: string; cmd: unknown; args: unknown }) {
      const request = validateAgentRequest({ cmd, args });
      const target = files(paneId);
      await ensurePrivateDir(dir, { fs });
      await unlinkIfPresent(fs, target.status);
      await writeJsonAtomic(target.request, { paneId, ...request }, { fs });
    },
    async waitReady(paneId: string): Promise<AgentReadiness> {
      const target = files(paneId);
      const started = now();
      while (now() - started <= timeoutMs) {
        try {
          const status = recordOf(JSON.parse(await fs.readFile(target.status, 'utf8')) as unknown);
          if (status?.status === 'ready') return { status: 'ready' };
          if (status?.status === 'failed' && typeof status.error === 'string') return { status: 'failed', error: status.error };
        } catch (error) {
          if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await wait(pollMs);
      }
      return { status: 'failed', error: 'agent readiness timed out' };
    },
    async cancel(paneId: string): Promise<void> {
      const target = files(paneId);
      await Promise.all([target.request, target.status].map((file) => unlinkIfPresent(fs, file)));
    },
  };
}

async function runPreparedAgent(): Promise<void> {
  const paneId = process.env.TMUX_PANE;
  const target = (() => {
    if (typeof paneId !== 'string' || !PANE_RE.test(paneId)) throw new Error('agent runner requires TMUX_PANE');
    const dir = path.join(os.homedir(), '.handmux', 'workspaces', 'agent-runs');
    const base = paneId.slice(1);
    return { request: path.join(dir, `${base}.request.json`), status: path.join(dir, `${base}.status.json`) };
  })();
  const input = JSON.parse(await fsp.readFile(target.request, 'utf8')) as unknown;
  if (recordOf(input)?.paneId !== paneId) throw new Error('agent runner pane mismatch');
  const launched = launchAgentRequest(input);
  try {
    const ready = await publishAgentReadiness(launched, (status) => writeJsonAtomic(target.status, status));
    if (ready.status === 'ready') await launched.completion;
    if (ready.status !== 'ready') throw new Error(ready.error);
  } finally {
    await unlinkIfPresent(fsp, target.request);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER_FILE) {
  runPreparedAgent().catch((error) => {
    process.stderr.write(`handmux agent resume: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
