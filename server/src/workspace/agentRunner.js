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

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function validateAgentRequest(request) {
  const valid = request?.cmd === 'claude'
    ? Array.isArray(request.args) && request.args.length === 2 && request.args[0] === '--resume' && UUID_RE.test(request.args[1])
    : request?.cmd === 'codex'
      && Array.isArray(request.args) && request.args.length === 2 && request.args[0] === 'resume' && UUID_RE.test(request.args[1]);
  if (!valid) throw new Error('unsafe agent request');
  return { cmd: request.cmd, args: [...request.args] };
}

function earlyFailure(request, error, code) {
  if (error?.code === 'ENOENT') return `${request.cmd} binary not found`;
  if (error) return `${request.cmd} failed to start: ${errorText(error)}`;
  return `${request.cmd} exited ${code ?? 'unknown'} before ready`;
}

export function launchAgentRequest(requestInput, {
  spawn = spawnChild,
  readinessMs = 500,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  const request = validateAgentRequest(requestInput);
  let child;
  let readyDone = false;
  let timer = null;
  let completionDone = false;
  let settleReady;
  let settleCompletion;
  const ready = new Promise((resolve) => { settleReady = resolve; });
  const completion = new Promise((resolve) => { settleCompletion = resolve; });
  const finishCompletion = (value) => {
    if (completionDone) return;
    completionDone = true;
    settleCompletion(value);
  };
  const failReady = (error, code) => {
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

export async function publishAgentReadiness(launched, writeStatus) {
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unlinkIfPresent(fs, file) {
  try { await fs.unlink(file); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function createAgentRunner({
  home = os.homedir(),
  fs = fsp,
  now = Date.now,
  wait = delay,
  timeoutMs = 3_000,
  pollMs = 25,
} = {}) {
  const dir = path.join(home, '.handmux', 'workspaces', 'agent-runs');
  const command = `${shellQuote(process.execPath)} ${shellQuote(RUNNER_FILE)}`;
  const files = (paneId) => {
    if (!PANE_RE.test(paneId)) throw new Error('invalid agent runner pane id');
    const base = paneId.slice(1);
    return { request: path.join(dir, `${base}.request.json`), status: path.join(dir, `${base}.status.json`) };
  };
  return {
    command,
    async prepare({ paneId, cmd, args }) {
      const request = validateAgentRequest({ cmd, args });
      const target = files(paneId);
      await ensurePrivateDir(dir, { fs });
      await unlinkIfPresent(fs, target.status);
      await writeJsonAtomic(target.request, { paneId, ...request }, { fs });
    },
    async waitReady(paneId) {
      const target = files(paneId);
      const started = now();
      while (now() - started <= timeoutMs) {
        try {
          const status = JSON.parse(await fs.readFile(target.status, 'utf8'));
          if (status?.status === 'ready' || status?.status === 'failed') return status;
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await wait(pollMs);
      }
      return { status: 'failed', error: 'agent readiness timed out' };
    },
    async cancel(paneId) {
      const target = files(paneId);
      await Promise.all([target.request, target.status].map((file) => unlinkIfPresent(fs, file)));
    },
  };
}

async function runPreparedAgent() {
  const paneId = process.env.TMUX_PANE;
  const target = (() => {
    if (!PANE_RE.test(paneId || '')) throw new Error('agent runner requires TMUX_PANE');
    const dir = path.join(os.homedir(), '.handmux', 'workspaces', 'agent-runs');
    const base = paneId.slice(1);
    return { request: path.join(dir, `${base}.request.json`), status: path.join(dir, `${base}.status.json`) };
  })();
  const input = JSON.parse(await fsp.readFile(target.request, 'utf8'));
  if (input.paneId !== paneId) throw new Error('agent runner pane mismatch');
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
