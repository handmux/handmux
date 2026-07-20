#!/usr/bin/env node
// handmux CLI — install once (`npm i -g handmux`), then drive it with start/stop/restart/status.
//
// The whole config story is two doors:
//   handmux start   — just run it. No config needed: defaults to `none` (LAN-only), auto-generates a
//                     token, prints the (token-free) URL + a QR of it, and the token on its own line. Flags
//                     let you try variations for one run (e.g. --tunnel cloudflare).
//   handmux setup   — the one place to configure persistently. Interactive; writes ~/.handmux/config.json
//                     (name, tunnel, push, voice). Re-run it to change anything.
// `start` reads that file; with no file it uses defaults. Precedence: flag > file > env (HANDMUX_*) >
// default — a flag overrides one value for one run and never persists. Advanced: `--config PATH` (a different file, for
// dev / multiple configs), `handmux config` (show what's in effect and where each value came from).
//
// Tunnels: `none` (LAN only, nothing exposed) · `cloudflare` (instant random https URL) ·
// `cloudflare-named` (stable URL on your own Cloudflare domain) · `ssh` (reverse-forward to your own
// server via `tunlite run`). `handmux setup` wires any of these up interactively.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { parseArgs, resolveConfig, explainConfig } from '../src/cli/options.js';
import { renderCompactQr } from '../src/cli/qr.js';
import { supervise, bareUrl, publicUrlWithToken } from '../src/cli/supervisor.js';
import { resolveCloudflared } from '../src/cli/cloudflared.js';
import { resolveTunlite, checkSshAuth } from '../src/cli/tunlite.js';
import { resolveNatapp, resolveCpolar } from '../src/cli/tunnelClients.js';
import { installService, uninstallService, isServiceInstalled, stopService } from '../src/cli/service.js';
import { checkTmux, MIN_TMUX, tmuxInstallHint } from '../src/cli/tmuxVersion.js';
import { readState, clearState, isAlive, acquireLifecycleLock, pocketHome, logPath, configPath, claudeStatePath } from '../src/cli/state.js';
import { scanSupervisorPids, terminateSupervisorPids } from '../src/cli/supervisorProcesses.js';
import { runSetup } from '../src/cli/setupWizard.js';
import { commitShortcuts, reportShortcutCommit, runShortcutEditor } from '../src/cli/shortcutEditor.js';
import { hooksStatus, installHooks, uninstallHooks } from '../src/cli/claudeHooks.js';
import { codexHooksStatus, installCodexHooks, uninstallCodexHooks } from '../src/cli/codexHooks.js';
import { statusLineStatus, installStatusLine, uninstallStatusLine, composeHint, refreshStatusLineScript } from '../src/cli/statusLine.js';
import { claudeUsagePath } from '../src/usage.js';
import { probe } from '../src/cli/probe.js';
import { notifyUpdate, runUpdateCheck, isBrewInstall, PKG_NAME } from '../src/cli/updateCheck.js';
import { t, initLocale, setLocale } from '../src/cli/i18n/index.js';
import { runPush } from '../src/cli/pushCmd.js';

const HOME = homedir();
const SELF = fileURLToPath(import.meta.url);
// Symlink-resolved entry path — a brew (tap) install is symlinked from the prefix's bin into the Cellar,
// so isBrewInstall() needs the real target, not the symlink, to spot the `/Cellar/` segment.
const SELF_REAL = (() => { try { return fs.realpathSync(SELF); } catch { return SELF; } })();
const HOOKS_SRC = path.resolve(path.dirname(SELF), '../hooks'); // server/hooks (bundled scripts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { command, flags } = parseArgs(process.argv.slice(2));

// Resolve the CLI language ONCE, up front, so every command (help, errors, access block) prints in it.
// Priority: --lang > config `lang` > shell locale (LANG/LC_*) > English. The config peek is lenient — a
// missing/broken file just means "no language hint here"; the real validation happens per-command later.
function peekConfigLang() {
  try {
    const p = flags.config ? path.resolve(flags.config) : configPath(HOME);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}
initLocale(flags, peekConfigLang(), process.env);

// There is ONE config file location: ~/.handmux/config.json (written by `handmux setup`). `--config PATH`
// points elsewhere — that's the only escape, and it covers dev/multi-config without any cwd magic (a
// stray ./config.json never gets picked up silently). No file merging or inheritance: at most one file is
// read. Flags (applied later in resolveConfig) override individual settings from it for that one run and
// never persist. Returns { path, cfg } — path is the file used (or null), for the startup print so it's
// never ambiguous what a run loaded.
function resolveFileConfig() {
  let p = null;
  if (flags.config) {                                              // explicit: must exist
    p = path.resolve(flags.config);
    if (!fs.existsSync(p)) { console.error(t('err.configNotFound', { path: p })); process.exit(2); }
  } else {
    const homeP = configPath(HOME);
    if (fs.existsSync(homeP)) p = homeP;
  }
  if (!p) return { path: null, cfg: {} };
  try { return { path: p, cfg: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { console.error(t('err.badConfig', { path: p, msg: e.message })); process.exit(2); }
}

// Human-readable summary of which config file a run loaded.
function describeConfig(p) {
  return p || t('config.none');
}

// Which user-visible settings THIS run would use differ from what's already running (from state.json)?
// Kept to the two people actually re-run `start` to change — the tunnel and the port; each row is ready to
// drop straight into the `start.running.changedRow` message ({key, from, to}). Only compares fields the
// running state actually recorded, so an older state.json can't manufacture phantom diffs.
function configChanges(cfg, st) {
  const out = [];
  for (const key of ['tunnel', 'port']) {
    const running = st[key];
    if (running != null && String(cfg[key]) !== String(running)) out.push({ key, from: running, to: cfg[key] });
  }
  return out;
}

// 一次性 [Y/n] 提问(默认 Yes)。非 TTY 直接返回 false,绝不卡住。
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await new Promise((res) => rl.question(`${question} [Y/n] `, res))).trim().toLowerCase();
    return a === '' || a === 'y' || a === 'yes';
  } finally { rl.close(); }
}

// ssh 隧道预检:解析 tunlite → 免密就绪?有 TTY 就内嵌 setup-key(输一次密码)再复检,无 TTY 快速失败。
async function preflightSsh(cfg) {
  cfg.tunliteBin = resolveTunlite();                 // 抛出 → 调用方打印并退出
  if (checkSshAuth(cfg.sshHost, { bin: cfg.tunliteBin }) === 0) return;
  if (process.stdin.isTTY && await confirm(t('ssh.confirmSetup', { host: cfg.sshHost }))) {
    spawnSync(cfg.tunliteBin, ['setup-key', cfg.sshHost], { stdio: 'inherit' });
    if (checkSshAuth(cfg.sshHost, { bin: cfg.tunliteBin }) === 0) return;
  }
  throw new Error(t('ssh.notSetup', { bin: cfg.tunliteBin, host: cfg.sshHost }));
}

// natapp/cpolar preflight: resolve the client binary (cpolar auto-downloads; natapp must be pre-installed),
// and for cpolar seed the authtoken into its own config so the detached `cpolar http` authenticates. Throws
// a friendly message the caller prints.
async function preflightNgrok(cfg) {
  if (cfg.tunnel === 'natapp') {
    cfg.natappBin = resolveNatapp(HOME);
  } else {
    cfg.cpolarBin = await resolveCpolar(HOME);
    if (spawnSync(cfg.cpolarBin, ['authtoken', cfg.authtoken], { stdio: 'ignore' }).status !== 0) {
      throw new Error(t('client.cpolarAuthFail'));
    }
  }
}

async function main() {
  switch (command) {
    case 'start': return withLifecycleLock(start);
    case 'open': return openCmd();
    case 'stop': return withLifecycleLock(stopAndWait);
    case 'restart': return withLifecycleLock(async () => { if (!await stopAndWait()) return; return start(); });
    case 'status': await status(); process.exit(process.exitCode || 0);
    case 'logs': return logs();
    case 'push': process.exitCode = await pushCmd(); return;
    case 'config': return configCmd();
    case 'setup': return setupCmd();
    case 'shortcuts': return shortcutsCmd();
    case 'hooks': return hooksCmd();
    case 'service': return withLifecycleLock(serviceCmd);
    case 'update': case 'upgrade': return updateCmd();
    case '__supervise': return runSupervise();
    case '__update-check': return runUpdateCheck(HOME);
    case 'version': case '--version': case '-v': return version();
    default: return help();
  }
}

async function withLifecycleLock(fn) {
  let release;
  try { release = acquireLifecycleLock(HOME); }
  catch (e) {
    console.error(e.ownerPid
      ? t('lifecycle.busy', { pid: e.ownerPid })
      : t('err.generic', { msg: e.message }));
    process.exitCode = 1;
    return;
  }
  try { return await fn(); }
  finally { release(); }
}

// `handmux --version` / `-v` — print the package version (read from this package's package.json, so it
// stays in lockstep with what npm installed; no hardcoded string to forget to bump).
function version() {
  console.log(currentVersion());
}

function currentVersion() { return requireOpt('../package.json').version; }

// `handmux update` (alias `upgrade`) — run the plain global install for the user. We don't self-patch or
// restart a running instance; on success we refresh the update cache so the "upgrade available" notice
// clears, and remind them to `handmux restart` to actually run the new code.
function updateCmd() {
  if (isBrewInstall(SELF_REAL)) { console.log(t('update.brew')); return; }
  console.log(t('update.running'));
  const r = spawnSync('npm', ['install', '-g', `${PKG_NAME}@latest`], { stdio: 'inherit' });
  if (r.status === 0) {
    runUpdateCheck(HOME);
    console.log(t('update.done'));
    console.log(t('update.restartHint'));
  } else {
    console.log(t('update.failed', { pkg: PKG_NAME }));
    process.exitCode = 1;
  }
}

// Best-effort upgrade notice from the cached "latest version" (never blocks; refreshes in the background).
function maybeNotifyUpdate() {
  notifyUpdate(HOME, { version: requireOpt('../package.json').version, selfPath: SELF_REAL });
}

async function start() {
  const { path: cfgPath, cfg: fileCfg } = resolveFileConfig();
  console.log(t('config.loaded', { path: describeConfig(cfgPath) }));
  let cfg;
  try { cfg = resolveConfig(flags, fileCfg); }
  catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(2); }

  // tmux is the whole point — absent is fatal; an untested-old version only warns (rendering may drift).
  const tmux = checkTmux();
  if (!tmux.present) {
    console.error(t('tmux.notFound'));
    console.error(t('tmux.explain1'));
    console.error(t('tmux.explain2'));
    console.error('');
    console.error(t('tmux.install', { hint: tmuxInstallHint() }));
    console.error(t('tmux.thenStart'));
    process.exit(1);
  }
  if (!tmux.ok) console.warn(t('tmux.tooOld', { raw: tmux.raw, min: MIN_TMUX }));

  // state.json cannot represent two supervisors. Refuse to add another when the real process table says
  // the state is missing/stale or a historical duplicate already exists; `handmux stop` is the repair path.
  const supervisors = scanSupervisorPids();
  if (!supervisors.ok) {
    console.error(t('lifecycle.scanFailed'));
    process.exitCode = 1;
    return;
  }

  // Already running? `start` never disrupts a live instance on its own. If this run's config matches
  // what's running, just reassure + reprint the address. If it DIFFERS (e.g. you changed the tunnel and
  // re-ran `start` expecting it to apply), spell out the difference and — interactively — offer to restart
  // into it; otherwise point at `handmux restart`. The principle stays intact: we only restart on an
  // explicit yes.
  const existing = readState(HOME);
  const statePid = existing && isAlive(existing.supervisorPid) ? existing.supervisorPid : null;
  if (supervisors.pids.length > 1 || (supervisors.pids.length === 1 && supervisors.pids[0] !== statePid)) {
    console.error(t('start.instancesFound', { pids: supervisors.pids.join(', ') }));
    console.error(t('start.instancesHint'));
    process.exitCode = 1;
    return;
  }
  if (existing && isAlive(existing.supervisorPid)) {
    const changed = configChanges(cfg, existing);
    if (!changed.length) {
      console.log(t('start.running.same'));
      await printAccess(existing);
      return;
    }
    console.log(t('start.running.changedHead', { tunnel: existing.tunnel }));
    for (const c of changed) console.log(t('start.running.changedRow', c));
    if (process.stdin.isTTY && await confirm(t('start.running.switchQ'))) {
      if (!await stopAndWait()) return;
      return start();
    }
    console.log(t('start.running.hint'));
    await printAccess(existing);
    return;
  }

  // Make a one-run tunnel override visible (printed only now that we're actually starting, so it can't be
  // mistaken for a switch when the instance was already running): a --tunnel flag shadowing the file.
  if (flags.tunnel && fileCfg.tunnel && flags.tunnel !== fileCfg.tunnel) {
    console.log(t('start.overrides', { flag: flags.tunnel, file: fileCfg.tunnel }));
  }

  // cloudflare needs a cloudflared binary; resolve (and auto-download) it up front so the failure is a
  // clear message here rather than a silent child that never prints a URL.
  if (cfg.tunnel === 'cloudflare') {
    try { cfg.cloudflaredBin = await resolveCloudflared(HOME); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  }
  if (cfg.tunnel === 'cloudflare-named') {
    try { cfg.cloudflaredBin = await resolveCloudflared(HOME); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
    if (!fs.existsSync(path.join(HOME, '.cloudflared', 'config.yml'))) {
      console.error(t('err.namedNotProvisioned')); process.exit(1);
    }
  }
  if (cfg.tunnel === 'ssh') {
    try { await preflightSsh(cfg); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  }
  if (cfg.tunnel === 'natapp' || cfg.tunnel === 'cpolar') {
    try { await preflightNgrok(cfg); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  }

  if (cfg.foreground) {
    supervise(cfg, { home: HOME });
    console.log(t('start.foreground', { tunnel: cfg.tunnel, port: cfg.port }));
    await waitAndPrint(false);
    return;
  }
  // Once autostart is registered, the service manager must remain the sole owner of the supervisor.
  // Rewriting + restarting the entry also refreshes baked config and upgrade-sensitive executable paths.
  if (isServiceInstalled(HOME)) {
    try { installService(supervisorArgs(cfg), { home: HOME, log: { log() {} } }); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
    console.log(t('start.starting', { tunnel: cfg.tunnel, port: cfg.port }));
    await waitAndPrint(true);
    return;
  }

  fs.mkdirSync(pocketHome(HOME), { recursive: true });
  const out = fs.openSync(logPath(HOME), 'a');
  const [supervisorBin, ...supervisorArgv] = supervisorArgs(cfg);
  const child = spawn(supervisorBin, supervisorArgv,
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log(t('start.starting', { tunnel: cfg.tunnel, port: cfg.port }));
  await waitAndPrint(true);
}

// Best-effort SIGTERM to the supervisor's recorded children. The supervisor reaps its own children on a
// graceful SIGTERM (supervisor.js shutdown), but if it was SIGKILL'd or crashed, its server/tunnel children
// are orphaned with no reaper — the classic "stray cloudflared after stop". Only called on the dead-
// supervisor branch, so these pids have no live parent to clean them up.
function reapOrphans(st) {
  for (const pid of [st.serverPid, st.tunnelPid]) {
    if (isAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* raced away */ } }
  }
}

// A lifecycle command must not start the replacement while the previous supervisor can still own the
// port/tunnel. Stop every real supervisor, not only the one last writer recorded in state.json, then rescan
// until none remain. This both repairs historical duplicates and prevents restart from racing a straggler.
async function stopAndWait() {
  const st = readState(HOME);
  const initial = scanSupervisorPids();
  if (!initial.ok) {
    console.error(t('lifecycle.scanFailed'));
    process.exitCode = 1;
    return false;
  }
  const managed = isServiceInstalled(HOME);
  if (managed) {
    try { stopService({ home: HOME }); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exitCode = 1; return false; }
  }
  const seen = new Set(initial.pids);
  if (st && isAlive(st.supervisorPid)) seen.add(st.supervisorPid);
  if (!seen.size) {
    if (st) reapOrphans(st);
    clearState(HOME);
    console.log(managed ? t('stop.stoppedManaged') : t('stop.notRunning'));
    return true;
  }
  const result = await terminateSupervisorPids([...seen]);
  if (!result.ok) {
    console.error(t(result.reason === 'scan' ? 'lifecycle.scanFailed' : 'stop.timeout', {
      pids: result.remaining.join(', '),
    }));
    process.exitCode = 1;
    return false;
  }
  clearState(HOME);
  console.log(t(result.pids.length > 1 ? 'stop.stoppedMany' : 'stop.stopped', {
    pid: result.pids[0], pids: result.pids.join(', '),
  }));
  return true;
}

async function status() {
  const st = readState(HOME);
  const installed = currentVersion();
  const supervisors = scanSupervisorPids();
  if (!supervisors.ok) console.warn(t('status.scanFailed'));
  const stateAlive = !!(st && isAlive(st.supervisorPid));
  if (supervisors.ok && supervisors.pids.length && !stateAlive) {
    console.log(t('status.untracked', { version: installed, pids: supervisors.pids.join(', ') }));
    console.log(t('status.cleanupHint'));
    process.exitCode = 1;
    return;
  }
  if (!stateAlive) { console.log(t('status.stopped', { version: installed })); return; }
  const running = st.version || installed;
  console.log(t('status.running', { version: running }));
  if (running !== installed) console.log(t('status.installed', { version: installed }));
  if (supervisors.ok && (supervisors.pids.length > 1
      || (supervisors.pids.length > 0 && !supervisors.pids.includes(st.supervisorPid)))) {
    const all = [...new Set([st.supervisorPid, ...supervisors.pids])].sort((a, b) => a - b);
    console.warn(t('status.duplicates', { pids: all.join(', ') }));
    console.warn(t('status.cleanupHint'));
    process.exitCode = 1;
  }
  await printAccess(st);
}

function runSupervise() {
  const cfg = JSON.parse(Buffer.from(flags.payload, 'base64').toString('utf8'));
  supervise(cfg, { home: HOME });
}

// `handmux push <title> <body> [--session X]... [--device K]... [--tag T] [--url U]` — see src/cli/pushCmd.js.
function pushCmd() {
  return runPush({ argv: process.argv.slice(2), home: HOME });
}

function logs() {
  const p = logPath(HOME);
  if (!fs.existsSync(p)) { console.log(t('logs.none')); return; }
  const lines = String(flags.lines || 200);
  const args = flags.follow ? ['-n', lines, '-f', p] : ['-n', lines, p];
  spawn('tail', args, { stdio: 'inherit' });
}

// `handmux service install|uninstall` — the autostart subsystem, mirroring `handmux hooks …`: subsystem
// name first, then the action. `install` bakes the resolved config into an OS autostart entry (launchd /
// systemd --user) that runs the supervisor at login; `uninstall` removes it. The action is argv[3].
async function serviceCmd() {
  const sub = process.argv[3];
  if (sub === 'install') return serviceInstall();
  if (sub === 'uninstall') {
    try { uninstallService({ home: HOME }); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
    return;
  }
  console.error(t('service.usage'));
  process.exit(2);
}

async function serviceInstall() {
  const { path: cfgPath, cfg: fileCfg } = resolveFileConfig();
  console.log(t('config.loaded', { path: describeConfig(cfgPath) }));
  let cfg;
  try { cfg = resolveConfig(flags, fileCfg); }
  catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(2); }
  if (cfg.tunnel === 'cloudflare' || cfg.tunnel === 'cloudflare-named') {
    try { cfg.cloudflaredBin = await resolveCloudflared(HOME); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  }
  if (cfg.tunnel === 'ssh') {
    // 开机自启无 TTY:要求事先已配好免密,否则快速失败。
    cfg.tunliteBin = resolveTunlite();
    if (checkSshAuth(cfg.sshHost, { bin: cfg.tunliteBin }) !== 0) {
      console.error(t('err.generic', { msg: t('ssh.notSetup', { bin: cfg.tunliteBin, host: cfg.sshHost }) })); process.exit(1);
    }
  }
  if (cfg.tunnel === 'natapp' || cfg.tunnel === 'cpolar') {
    try { await preflightNgrok(cfg); }
    catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  }
  // Converge a pre-existing manual run (and any old broken managed/manual pair) before loading the service.
  // Otherwise the very first `service install` can itself create two supervisors fighting over one port.
  const existing = readState(HOME);
  const supervisors = scanSupervisorPids();
  if (!supervisors.ok) {
    console.error(t('lifecycle.scanFailed'));
    process.exitCode = 1;
    return;
  }
  if (isServiceInstalled(HOME) || supervisors.pids.length || (existing && isAlive(existing.supervisorPid))) {
    if (!await stopAndWait()) return;
  }
  const args = supervisorArgs(cfg);
  try { installService(args, { home: HOME }); }
  catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(1); }
  console.log(t('service.installed'));
}

function supervisorArgs(cfg) {
  const payload = Buffer.from(JSON.stringify(cfg)).toString('base64');
  return [process.execPath, SELF, '__supervise', '--payload', payload];
}

async function setupCmd() {
  const target = flags.config ? path.resolve(flags.config) : configPath(HOME);
  // Is an instance already up? Then the run-action reads "Save & restart" and applying means a real restart
  // (a running supervisor won't pick up the new config on its own). Captured before the interactive setup so
  // the label and the action agree; stop() below is a safe no-op if it died meanwhile.
  const st = readState(HOME);
  const running = !!(st && isAlive(st.supervisorPid));
  const res = await runSetup({ home: HOME, target, running });
  if (!res) { process.exit(2); }
  const { cfg, start: doStart } = res;   // hub's "save & start/restart" carries the intent — no separate confirm
  // Offer to enable the inbox hooks when an agent is present but not yet wired (Claude 'absent', or Codex
  // 'absent'). installAgentHooks() then wires every present agent (idempotent for any already installed).
  const offerHooks = hooksStatus(HOME) === 'absent' || codexHooksStatus(HOME) === 'absent';
  if (offerHooks && await confirm(t('hooks.confirmEnable'))) {
    installAgentHooks();
  }
  await maybeOfferStatusLine();
  if (doStart) {
    return withLifecycleLock(async () => {
      Object.assign(flags, cfg);
      if (running && !await stopAndWait()) return; // restart into the new config
      return start();
    });
  }
  console.log(t(running ? 'setup.laterRestart' : 'setup.later'));
}

async function shortcutsCmd() {
  const target = flags.config ? path.resolve(flags.config) : configPath(HOME);
  let res;
  try {
    res = await runShortcutEditor({
      target,
      commit: (file, shortcuts) => commitShortcuts({ home: HOME, target: file, shortcuts }),
    });
  } catch (error) {
    console.error(error.ownerPid
      ? t('lifecycle.busy', { pid: error.ownerPid })
      : t('err.badConfig', { path: target, msg: error.message }));
    process.exitCode = 2;
    return;
  }
  if (!res) return;
  if (res.error) { process.exitCode = 2; return; }
  process.exitCode = reportShortcutCommit(res) || process.exitCode;
}

// Offer to enable the Claude statusLine usage capturer — it feeds the phone Usage page's 5h/weekly bars
// (Claude Code's statusLine stdin is the only documented local source of those %). Opt-in and NON-
// DESTRUCTIVE: auto-installs only when there's no statusLine yet; if the user already has one we print a
// one-line compose snippet and change nothing. Codex needs no capturer — its rollout already carries the
// quota. No-op when Claude Code isn't installed or ours is already in place.
async function maybeOfferStatusLine() {
  const st = statusLineStatus(HOME);
  if (st === 'no-claude') return;
  // Already ours (plain OR composed into the user's own statusline): don't re-prompt, but silently REFRESH
  // the capturer script to the bundled version so an npm upgrade reaches the on-disk copy. Settings-safe —
  // refreshStatusLineScript never rewrites settings.statusLine, so a composed downstream renderer is kept.
  if (st === 'ours') { refreshStatusLineScript(HOME, { srcDir: HOOKS_SRC }); return; }
  if (st === 'foreign') {
    // Deploy the capturer script (doesn't touch their statusLine) so the compose one-liner is runnable.
    installStatusLine(HOME, { srcDir: HOOKS_SRC, usageFile: claudeUsagePath(HOME) });
    console.log(t('statusline.foreignHint'));
    console.log('  ' + composeHint(HOME, { usageFile: claudeUsagePath(HOME) }));
    return;
  }
  if (await confirm(t('statusline.confirmEnable'))) {
    installStatusLine(HOME, { srcDir: HOOKS_SRC, usageFile: claudeUsagePath(HOME) });
    console.log(t('statusline.installed'));
    console.log(t('statusline.reload'));
  }
}

// Install the inbox hooks for every coding agent present on this host (Claude Code, Codex — the state file
// is shared, entries are agent-tagged). Each is opt-in by the mere presence of its config dir. Prints a
// per-agent line and returns how many were wired, so callers can gate the "reload" hint. Codex's single
// `notify` slot may already hold the user's OWN program — we never clobber it, we warn.
function installAgentHooks() {
  let installed = 0;
  if (hooksStatus(HOME) !== 'no-claude') {
    installHooks(HOME, { srcDir: HOOKS_SRC, stateFile: claudeStatePath(HOME) });
    console.log(t('hooks.installedClaude'));
    installed++;
  }
  if (codexHooksStatus(HOME) !== 'no-codex') {
    installCodexHooks(HOME, { srcDir: HOOKS_SRC, stateFile: claudeStatePath(HOME) });
    console.log(t('hooks.installedCodex'));
    installed++;
  }
  return installed;
}

// `handmux hooks install|uninstall` — opt-in wiring of the coding-agent lifecycle hooks that drive the
// inbox/push. Never creates ~/.claude or ~/.codex; if neither agent is present we say so and exit 0.
async function hooksCmd() {
  const sub = process.argv[3];
  if (sub === 'install') {
    if (hooksStatus(HOME) === 'no-claude' && codexHooksStatus(HOME) === 'no-codex') {
      console.log(t('hooks.noAgents'));
      return;
    }
    if (installAgentHooks() > 0) console.log(t('hooks.installedHint'));
    await maybeOfferStatusLine();
    return;
  }
  if (sub === 'uninstall') {
    uninstallHooks(HOME);
    uninstallCodexHooks(HOME);
    uninstallStatusLine(HOME);
    console.log(t('hooks.removed'));
    return;
  }
  console.error(t('hooks.usage'));
  process.exit(2);
}

// `handmux config` — read-only: print the config that WOULD be used, with each value's origin (flag /
// the config file path / env / default). This is the answer to "what's actually in effect and where did
// it come from", so flag-vs-file is never a mystery. Secrets are masked.
function configCmd() {
  const { path: cfgPath, cfg: fileCfg } = resolveFileConfig();
  let rows;
  try { rows = explainConfig(flags, fileCfg, cfgPath); }
  catch (e) { console.error(t('err.generic', { msg: e.message })); process.exit(2); }
  console.log(t('configcmd.file', { path: cfgPath || t('configcmd.fileNone') }));
  console.log('');
  const w = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    console.log(`  ${r.key.padEnd(w)}  ${r.display}  ${r.origin === 'default' ? '' : `· ${r.origin}`}`.trimEnd());
  }
  console.log('');
  console.log(t('configcmd.legend'));
}

// Poll state.json until the public URL (or an error) shows up, then print access info. cloudflare needs
// a few seconds to hand back its hostname; none is instant.
async function waitAndPrint(exitWhenDone) {
  const deadline = Date.now() + 25000;
  let st;
  for (;;) {
    st = readState(HOME);
    if (st && ((st.publicUrl && st.ready) || st.error)) break;
    if (Date.now() > deadline) break;
    await sleep(300);
  }
  await printAccess(st);
  if (st?.error) process.exitCode = 1;
  if (exitWhenDone) process.exit(process.exitCode || 0);
}

async function printAccess(st) {
  if (!st) { console.log(t('access.noState')); return; }
  if (st.error) { console.error(t('access.error', { msg: st.error })); return; }
  const scan = bareUrl(st.publicUrl);
  console.log('');
  console.log(t('access.tunnel', { tunnel: st.tunnel, pid: st.supervisorPid }));
  console.log(t('access.open', { url: scan || t('access.pending') }));
  if (st.tunnel === 'none' && st.lanUrl) console.log(t('access.lan', { url: bareUrl(st.lanUrl) }));
  console.log(t('access.local', { url: bareUrl(st.localUrl) }));
  console.log(t('access.token', { token: st.token }));
  // The QR carries the token so a phone scan signs in one-tap; the PRINTED links above stay token-free
  // (safe to screenshot/share — paste the token shown above to sign in there).
  await maybeQr(st.publicUrl ? publicUrlWithToken(st.publicUrl, st.token) : scan, st);
  if (st.publicUrl && st.tunnel !== 'none') {
    const ok = await probe(st.publicUrl);
    if (ok) console.log(t('access.reachable'));
    else console.log(t('access.unreachable', { url: st.publicUrl }));
  }
  console.log('');
  console.log(t('access.hint'));
  console.log('');
  maybeNotifyUpdate();
}

// Best-effort QR (optional dependency). We borrow qrcode-terminal's QR *model* (vendored, dependency-free)
// to get the module matrix, then render it ourselves with vertical half-blocks (see qr.js) so it comes out
// square on a 2:1 terminal cell. If qrcode-terminal isn't installed we just skip it — the URL above is
// always printed.
const requireOpt = createRequire(import.meta.url);
async function maybeQr(url, st) {
  if (!url) return;
  try {
    const QRCode = requireOpt('qrcode-terminal/vendor/QRCode');
    const ECL = requireOpt('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, ECL.L);
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const matrix = Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
    process.stdout.write(renderCompactQr(matrix) + '\n');
  } catch { /* no qrcode-terminal — URL alone is fine */ }
}

// `open` is deliberately DECOUPLED from the server lifecycle: it never starts/stops anything. It's the
// desk-side quick attach — `handmux open foo` attaches session foo (creating it if missing), including
// sessions that were created from the phone. Inside tmux it refuses (don't nest tmux in tmux).
function openCmd() {
  const name = process.argv[3];
  if (!name || name.startsWith('-')) { console.error(t('open.usage')); process.exit(2); }
  if (process.env.TMUX) { console.error(t('open.insideTmux')); process.exit(1); }
  const tmux = checkTmux();
  if (!tmux.present) {
    console.error(t('tmux.notFound'));
    console.error(t('tmux.install', { hint: tmuxInstallHint() }));
    process.exit(1);
  }
  const r = spawnSync('tmux', ['new-session', '-A', '-s', name], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function help() {
  if (process.argv[3] === 'flags') { console.log(t('help.flags')); return; }
  console.log(t('help.body'));
}

main();
