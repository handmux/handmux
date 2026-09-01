import { spawn as spawnChild } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
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
export interface PreparedAgentRequest extends AgentRequest {
  paneId: string;
  pathEnv: string;
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
type ExecutableAvailable = (command: AgentRequest['cmd']) => boolean | Promise<boolean>;
interface LaunchAgentOptions {
  spawn?: typeof spawnChild;
  readinessMs?: number;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
  env?: NodeJS.ProcessEnv;
}

const MAX_PATH_LENGTH = 32_768;
const MAX_PATH_ENTRIES = 256;
const MAX_PATH_ENTRY_LENGTH = 4_096;

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

function validatePathSnapshot(value: unknown, platform: NodeJS.Platform): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value)) {
    throw new Error('unsafe agent PATH snapshot');
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const entries = value.split(platform === 'win32' ? ';' : ':');
  if (!entries.length || entries.length > MAX_PATH_ENTRIES) throw new Error('unsafe agent PATH snapshot');
  for (const entry of entries) {
    if (!entry || entry.length > MAX_PATH_ENTRY_LENGTH || !pathApi.isAbsolute(entry)) {
      throw new Error('unsafe agent PATH snapshot');
    }
  }
  return value;
}

export function validatePreparedAgentRequest(
  input: unknown,
  platform: NodeJS.Platform = process.platform,
): PreparedAgentRequest {
  const record = recordOf(input);
  const request = validateAgentRequest(input);
  const paneId = record?.paneId;
  if (typeof paneId !== 'string' || !PANE_RE.test(paneId)) throw new Error('unsafe prepared agent request');
  return { ...request, paneId, pathEnv: validatePathSnapshot(record?.pathEnv, platform) };
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
  env,
}: LaunchAgentOptions = {}): LaunchedAgent {
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
    child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...(env ? { env } : {}),
    });
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

export function launchPreparedAgentRequest(
  requestInput: unknown,
  {
    env = process.env,
    platform = process.platform,
    ...options
  }: LaunchAgentOptions & { platform?: NodeJS.Platform } = {},
): LaunchedAgent {
  const request = validatePreparedAgentRequest(requestInput, platform);
  return launchAgentRequest(request, { ...options, env: { ...env, PATH: request.pathEnv } });
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

async function executableOnPath(
  command: AgentRequest['cmd'],
  {
    fs = fsp,
    env = process.env,
    platform = process.platform,
  }: { fs?: typeof fsp; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, platform === 'win32' ? `${command}${extension}` : command);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        await fs.access(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return true;
      } catch { /* keep searching while an install may be replacing the executable */ }
    }
  }
  return false;
}

export async function waitForAgentExecutable(
  command: AgentRequest['cmd'],
  {
    available = executableOnPath,
    now = Date.now,
    wait = delay,
    timeoutMs = 8_000,
    pollMs = 100,
  }: {
    available?: ExecutableAvailable;
    now?: () => number;
    wait?: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<AgentReadiness> {
  if (command !== 'claude' && command !== 'codex') throw new Error('unsafe agent executable');
  const started = now();
  while (true) {
    if (await available(command)) return { status: 'ready' };
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) {
      return { status: 'failed', error: `${command} executable unavailable after startup wait` };
    }
    await wait(Math.min(pollMs, remaining));
  }
}

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
  executableAvailable,
  executableWaitMs = 8_000,
  executablePollMs = 100,
  pathEnv = process.env.PATH,
  platform = process.platform,
}: {
  home?: string;
  fs?: typeof fsp;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
  executableAvailable?: ExecutableAvailable;
  executableWaitMs?: number;
  executablePollMs?: number;
  pathEnv?: string;
  platform?: NodeJS.Platform;
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
    waitForExecutable(cmd: AgentRequest['cmd']): Promise<AgentReadiness> {
      let safePath: string;
      try {
        safePath = validatePathSnapshot(pathEnv, platform);
      } catch (error) {
        return Promise.resolve({ status: 'failed', error: errorText(error) });
      }
      return waitForAgentExecutable(cmd, {
        available: executableAvailable ?? ((command) => executableOnPath(command, {
          fs,
          env: { PATH: safePath, PATHEXT: process.env.PATHEXT },
          platform,
        })),
        now,
        wait,
        timeoutMs: executableWaitMs,
        pollMs: executablePollMs,
      });
    },
    async prepare({ paneId, cmd, args }: { paneId: string; cmd: unknown; args: unknown }) {
      const request = validateAgentRequest({ cmd, args });
      const safePath = validatePathSnapshot(pathEnv, platform);
      const target = files(paneId);
      await ensurePrivateDir(dir, { fs });
      await unlinkIfPresent(fs, target.status);
      await writeJsonAtomic(target.request, { paneId, ...request, pathEnv: safePath }, { fs });
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
  const request = validatePreparedAgentRequest(input);
  if (request.paneId !== paneId) throw new Error('agent runner pane mismatch');
  const launched = launchPreparedAgentRequest(request);
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
