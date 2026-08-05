import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn as spawnChild } from 'node:child_process';

const PANE_RE = /^%\d+$/;

export function codexAppSocketPath(pane, home = os.homedir()) {
  if (!PANE_RE.test(pane || '')) throw new Error('managed Codex requires a tmux pane');
  return path.join(home, '.handmux', 'codex-app', `${pane.slice(1)}.sock`);
}

function waitForSocket(socketPath, child, {
  exists = fs.existsSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 5_000,
  now = Date.now,
} = {}) {
  return new Promise((resolve, reject) => {
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

function finish(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

// One App Server belongs to one tmux pane. That ownership is intentional: the server inherits TMUX_PANE,
// so Codex hooks keep their exact pane→thread binding, while the TUI and Handmux connect to the same Unix
// socket and therefore observe one authoritative runtime (messages, approvals, settings, and interrupts).
export async function runManagedCodex(args = [], {
  home = os.homedir(),
  env = process.env,
  spawn = spawnChild,
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  unlink = (file) => { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } },
  waitOptions,
} = {}) {
  const pane = env.TMUX_PANE;
  const socketPath = codexAppSocketPath(pane, home);
  mkdir(path.dirname(socketPath));
  unlink(socketPath);

  const managedEnv = { ...env, HANDMUX_CODEX_MANAGED: '1' };
  const appServer = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
    env: managedEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let tui = null;
  try {
    await waitForSocket(socketPath, appServer, waitOptions);
    tui = spawn('codex', ['--remote', `unix://${socketPath}`, ...args], {
      env: managedEnv,
      stdio: 'inherit',
    });
    const result = await finish(tui);
    return Number.isInteger(result.code) ? result.code : 1;
  } finally {
    if (tui && tui.exitCode == null && tui.signalCode == null) tui.kill('SIGTERM');
    if (appServer.exitCode == null && appServer.signalCode == null) appServer.kill('SIGTERM');
    unlink(socketPath);
  }
}
