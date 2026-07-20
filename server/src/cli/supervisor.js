// The single long-running supervisor. It owns the node server (and, for a process-backed tunnel like
// cloudflare, the tunnel) as CHILD processes, restarts them with a small backoff on exit, and records
// the live public URL into state.json. There is only ever one daemon here — cloudflared (and, later,
// `tunlite run`) are just its children, exactly like the server is.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getDriver } from './drivers.js';
import { writeState, clearState, claudeStatePath, pushStorePath, previewStorePath, notificationsDirPath } from './state.js';

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

export function supervise(cfg, { home, log = console } = {}) {
  const driver = getDriver(cfg.tunnel);
  const children = {};
  let stopping = false;
  let urlBuf = '';
  let backoff = 500;

  const state = {
    supervisorPid: process.pid,
    version: VERSION,
    startedAt: Date.now(),
    tunnel: cfg.tunnel,
    port: cfg.port,
    host: cfg.host,
    token: cfg.token,
    previewDomain: cfg.previewDomain || null,
    localUrl: `http://localhost:${cfg.port}`,
    lanUrl: lanUrl(cfg.port),
    publicUrl: null,
    ready: false,
    error: null,
  };
  const persist = () => writeState(state, home);
  persist();

  // The server socket comes up a beat after spawn; don't report "ready" (and don't let the CLI print an
  // access URL) until a TCP connect to it actually succeeds, or callers race an unbound port.
  const waitListening = () => {
    if (stopping || state.ready) return;
    const s = net.connect({ port: cfg.port, host: '127.0.0.1' });
    const retry = () => { s.destroy(); if (!stopping) setTimeout(waitListening, 200); };
    s.setTimeout(500, retry);
    s.once('error', retry);
    s.once('connect', () => { s.destroy(); state.ready = true; persist(); });
  };

  const startServer = () => {
    // The server reads only process.env (no .env files) — the CLI resolved the one config file and we
    // hand the server everything it needs here. This is the single injection point: config.json fields →
    // the env names the server already reads (HANDMUX_* / VAPID_* / XFYUN_*).
    const env = {
      ...process.env,
      NODE_ENV: 'handmux',
      HANDMUX_PORT: String(cfg.port),
      HANDMUX_HOST: cfg.host,
      HANDMUX_TOKEN: cfg.token,
      CLAUDE_STATE_FILE: claudeStatePath(home),
      PUSH_STORE: pushStorePath(home),
      PREVIEW_STORE: previewStorePath(home),
      NOTIF_DIR: notificationsDirPath(home),
    };
    if (cfg.previewDomain) env.HANDMUX_PREVIEW_DOMAIN = cfg.previewDomain;
    if (cfg.name) env.HANDMUX_APP_NAME = cfg.name;
    if (cfg.staticDir) env.HANDMUX_STATIC_DIR = cfg.staticDir;
    if (cfg.uploadExts) env.HANDMUX_UPLOAD_EXTS = cfg.uploadExts;
    if (cfg.previewTtl) env.HANDMUX_PREVIEW_TTL = String(cfg.previewTtl);
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
    const c = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    children.server = c;
    state.serverPid = c.pid; persist();
    c.on('exit', () => { if (!stopping) backoffRestart('server', startServer); });
  };

  const startTunnel = () => {
    if (!driver.needsProcess) { // 'none' — reachable directly on LAN/localhost (or a tunnel you run yourself)
      state.publicUrl = cfg.publicUrl || state.lanUrl || state.localUrl; persist(); return;
    }
    const spec = driver.proc(cfg);
    const c = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.tunnel = c;
    state.tunnelPid = c.pid; persist();
    const onData = (b) => {
      const s = b.toString();
      process.stdout.write(s);
      if (state.publicUrl) return;
      urlBuf = (urlBuf + s).slice(-4000);
      const url = driver.matchUrl(urlBuf, cfg);
      if (url) { state.publicUrl = url; state.error = null; backoff = 500; persist(); }
    };
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    c.on('error', (e) => {
      state.error = e.code === 'ENOENT'
        ? (driver.notFoundHint || `${spec.cmd} not found`)
        : String(e);
      persist();
    });
    c.on('exit', () => { if (!stopping) { state.publicUrl = null; persist(); backoffRestart('tunnel', startTunnel); } });
  };

  const backoffRestart = (what, fn) => {
    const d = Math.min(backoff, 15000);
    backoff = Math.min(backoff * 2, 15000);
    log.warn?.(`[handmux] ${what} exited; restarting in ${d}ms`);
    setTimeout(() => { if (!stopping) fn(); }, d);
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
    const alive = () => kids.filter((c) => { try { process.kill(c.pid, 0); return true; } catch { return false; } });
    let waited = 0;
    const tick = () => {
      const left = alive();
      if (left.length === 0 || waited >= 3000) {
        for (const c of left) { try { c.kill('SIGKILL'); } catch { /* already dead */ } }
        process.exit(0);
      }
      waited += 150;
      setTimeout(tick, 150);
    };
    tick();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  startServer();
  startTunnel();
  waitListening();
  return { state };
}
