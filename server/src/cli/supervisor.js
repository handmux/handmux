// The single long-running supervisor. It owns the node server (and, for a process-backed tunnel like
// cloudflare, the tunnel) as CHILD processes, restarts them with a small backoff on exit, and records
// the live public URL into state.json. There is only ever one daemon here — cloudflared (and, later,
// `tunlite run`) are just its children, exactly like the server is.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getDriver } from './drivers.js';
import { writeState, clearState, claudeStatePath, pushStorePath, previewStorePath, notificationsDirPath } from './state.js';
import {
  initialSupervisorComponentState, reduceSupervisorComponent,
} from './supervisorState.js';
import { probeServerReadiness } from './supervisorHealth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../server.js');
const require = createRequire(import.meta.url);
const VERSION = require('../../package.json').version;

// First non-internal IPv4 — the address a phone on the same wifi uses when there's no tunnel.
export function lanUrl(port, ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return `http://${ni.address}:${port}`;
    }
  }
  return null;
}

// The token rides in the query string so the first navigation (or a QR scan) authenticates in one shot.
export function publicUrlWithToken(base, token) {
  if (!base) return base;
  return `${base.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`;
}

// Bare address with no token in it — printed/QR-encoded so a link can be shared or screenshotted without
// leaking the secret; the token is shown separately for the user to paste in.
export function bareUrl(base) {
  if (!base) return base;
  return `${base.replace(/\/$/, '')}/`;
}

export function browserPublicOriginEnv(cfg) {
  return {
    ...(cfg.previewDomain ? { HANDMUX_PREVIEW_DOMAIN: cfg.previewDomain } : {}),
    ...(cfg.publicUrl ? { HANDMUX_PUBLIC_URL: cfg.publicUrl } : {}),
  };
}

export function supervise(cfg, {
  home,
  log = console,
  spawnChild = spawn,
  probeServerReady = () => probeServerReadiness(cfg.port),
  setTimer = setTimeout,
  now = Date.now,
  processRef = process,
} = {}) {
  const driver = getDriver(cfg.tunnel);
  const children = {};
  let stopping = false;
  let urlBuf = '';
  const components = {
    server: initialSupervisorComponentState('server'),
    tunnel: initialSupervisorComponentState('tunnel'),
  };

  const state = {
    supervisorPid: processRef.pid,
    version: VERSION,
    startedAt: now(),
    tunnel: cfg.tunnel,
    port: cfg.port,
    host: cfg.host,
    token: cfg.token,
    localUrl: `http://localhost:${cfg.port}`,
    lanUrl: lanUrl(cfg.port),
    publicUrl: null,
    ready: false,
    serverPid: null,
    tunnelPid: null,
    components,
    error: null,
  };
  const persist = () => {
    // Keep the legacy top-level fields during migration, but derive them from the explicit component
    // machines so `ready` can never outlive the Server process that earned it.
    state.serverPid = components.server.pid;
    state.tunnelPid = components.tunnel.pid;
    state.ready = components.server.phase === 'ready';
    writeState(state, home);
  };
  const transition = (name, event) => {
    components[name] = reduceSupervisorComponent(components[name], event);
    persist();
  };
  persist();

  // Readiness belongs to the Server generation that answered the structured health probe. A bare TCP
  // listener could be an old process or a half-initialized API with Workspace/Browser already degraded.
  const waitReady = (serverChild) => {
    if (stopping || children.server !== serverChild || components.server.phase === 'ready') return;
    const retry = () => {
      if (!stopping && children.server === serverChild) {
        setTimer(() => waitReady(serverChild), 200);
      }
    };
    Promise.resolve(probeServerReady()).then((ready) => {
      if (!ready) { retry(); return; }
      if (!stopping && children.server === serverChild) {
        transition('server', { type: 'ready', at: now() });
      }
    }, retry);
  };

  const startServer = () => {
    // The server reads only process.env (no .env files) — the CLI resolved the one config file and we
    // hand the server everything it needs here. This is the single injection point: config.json fields →
    // the env names the server already reads (HANDMUX_* / VAPID_* / XFYUN_*).
    const env = {
      ...processRef.env,
      NODE_ENV: 'handmux',
      HANDMUX_PORT: String(cfg.port),
      HANDMUX_HOST: cfg.host,
      HANDMUX_TOKEN: cfg.token,
      CLAUDE_STATE_FILE: claudeStatePath(home),
      PUSH_STORE: pushStorePath(home),
      PREVIEW_STORE: previewStorePath(home),
      NOTIF_DIR: notificationsDirPath(home),
      ...browserPublicOriginEnv(cfg),
    };
    if (cfg.name) env.HANDMUX_APP_NAME = cfg.name;
    if (cfg.staticDir) env.HANDMUX_STATIC_DIR = cfg.staticDir;
    if (cfg.uploadExts) env.HANDMUX_UPLOAD_EXTS = cfg.uploadExts;
    env.HANDMUX_SHORTCUTS = JSON.stringify(cfg.shortcuts);
    if (cfg.vapid) {
      if (cfg.vapid.public) env.VAPID_PUBLIC = cfg.vapid.public;
      if (cfg.vapid.private) env.VAPID_PRIVATE = cfg.vapid.private;
      if (cfg.vapid.subject) env.VAPID_SUBJECT = cfg.vapid.subject;
    }
    if (cfg.xfyun) {
      if (cfg.xfyun.appId) env.XFYUN_APPID = cfg.xfyun.appId;
      if (cfg.xfyun.apiKey) env.XFYUN_APIKEY = cfg.xfyun.apiKey;
      if (cfg.xfyun.apiSecret) env.XFYUN_APISECRET = cfg.xfyun.apiSecret;
    }
    const c = spawnChild(processRef.execPath, [SERVER], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    children.server = c;
    transition('server', { type: 'spawned', pid: c.pid ?? null, at: now() });
    waitReady(c);
    let finalized = false;
    const finalize = (error = null) => {
      if (finalized || children.server !== c) return;
      finalized = true;
      delete children.server;
      if (stopping) {
        components.server = reduceSupervisorComponent(components.server, { type: 'stopped', at: now() });
        return;
      }
      transition('server', { type: 'exited', at: now(), error });
      backoffRestart('server', startServer);
    };
    c.once('error', (error) => finalize(String(error)));
    c.once('exit', (code, signal) => finalize(code || signal ? `exit ${code ?? signal}` : null));
  };

  const startTunnel = () => {
    if (!driver.needsProcess) { // 'none' — reachable directly on LAN/localhost (or a tunnel you run yourself)
      state.publicUrl = cfg.publicUrl || state.lanUrl || state.localUrl;
      transition('tunnel', { type: 'spawned', pid: null, at: now() });
      transition('tunnel', { type: 'ready', at: now() });
      return;
    }
    urlBuf = '';
    const spec = driver.proc(cfg);
    const c = spawnChild(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.tunnel = c;
    transition('tunnel', { type: 'spawned', pid: c.pid ?? null, at: now() });
    const onData = (b) => {
      const s = b.toString();
      processRef.stdout.write(s);
      if (state.publicUrl) return;
      urlBuf = (urlBuf + s).slice(-4000);
      const url = driver.matchUrl(urlBuf, cfg);
      if (url) {
        state.publicUrl = url;
        state.error = null;
        transition('tunnel', { type: 'ready', at: now() });
      }
    };
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    let finalized = false;
    const finalize = (error = null) => {
      if (finalized || children.tunnel !== c) return;
      finalized = true;
      delete children.tunnel;
      state.publicUrl = null;
      if (stopping) {
        components.tunnel = reduceSupervisorComponent(components.tunnel, { type: 'stopped', at: now() });
        return;
      }
      transition('tunnel', { type: 'exited', at: now(), error });
      backoffRestart('tunnel', startTunnel);
    };
    c.once('error', (e) => {
      const message = e.code === 'ENOENT'
        ? (driver.notFoundHint || `${spec.cmd} not found`)
        : String(e);
      state.error = message;
      finalize(message);
    });
    c.once('exit', (code, signal) => finalize(code || signal ? `exit ${code ?? signal}` : null));
  };

  const backoffRestart = (what, fn) => {
    const d = Math.max(0, (components[what].restartAt ?? now()) - now());
    log.warn?.(`[handmux] ${what} exited; restarting in ${d}ms`);
    setTimer(() => { if (!stopping) fn(); }, d);
  };

  const shutdown = () => {
    stopping = true;
    const kids = Object.values(children).filter(Boolean);
    for (const c of kids) { try { c.kill('SIGTERM'); } catch { /* already dead */ } }
    clearState(home);
    // Don't exit on a fixed timer — that orphans any child still shutting down (a SIGKILL'd or crashed
    // supervisor was how a stray cloudflared kept running after `stop`). Poll until the children are gone,
    // then SIGKILL any straggler so we NEVER leak a tunnel process. With --grace-period 0s, cloudflared
    // exits near-instantly; the 3s ceiling is just a backstop.
    const alive = () => kids.filter((c) => { try { processRef.kill(c.pid, 0); return true; } catch { return false; } });
    let waited = 0;
    const tick = () => {
      const left = alive();
      if (left.length === 0 || waited >= 3000) {
        for (const c of left) { try { c.kill('SIGKILL'); } catch { /* already dead */ } }
        processRef.exit(0);
      }
      waited += 150;
      setTimer(tick, 150);
    };
    tick();
  };
  processRef.on('SIGTERM', shutdown);
  processRef.on('SIGINT', shutdown);

  startServer();
  startTunnel();
  return { state };
}
