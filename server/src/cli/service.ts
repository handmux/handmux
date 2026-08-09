// Boot/login autostart. The OS keeps the handmux SUPERVISOR (`__supervise`) alive; the supervisor
// keeps server + tunnel alive — same model as a foreground run, just parented by launchd/systemd.
// The service definition receives only a private supervisor-config path. Secrets stay out of argv, plist,
// and unit text. Text generators are pure (unit-tested); the launchctl/systemctl calls inject `exec`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pocketHome, logPath } from './state.js';
import { ensurePrivateDirectorySync } from '../privateStateStore.js';

export const LABEL = 'com.handmux.agent';
export const UNIT = 'handmux.service';

export interface ServiceExecResult {
  status: number | null;
  stderr?: string | Buffer | null;
}

export interface ServiceExecOptions {
  encoding?: 'utf8';
  stdio?: 'ignore';
}

export type ServiceExec = (
  command: string,
  args: readonly string[],
  options: ServiceExecOptions,
) => ServiceExecResult;

interface ServiceLogger { log?(message: string): void }
interface ServiceOptions {
  home: string;
  platform?: string;
  exec?: ServiceExec;
  log?: ServiceLogger;
}

const defaultExec: ServiceExec = (command, args, options) => {
  const result = options.encoding
    ? spawnSync(command, [...args], { encoding: options.encoding })
    : spawnSync(command, [...args], { stdio: options.stdio });
  return { status: result.status, stderr: result.stderr };
};
const failureDetail = (result: ServiceExecResult): string => String(result.stderr || result.status);

export function plistPath(home: string): string { return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`); }
export function unitPath(home: string): string { return path.join(home, '.config', 'systemd', 'user', UNIT); }

export function isServiceInstalled(home: string, platform: string = process.platform): boolean {
  if (platform === 'darwin') return fs.existsSync(plistPath(home));
  if (platform === 'linux') return fs.existsSync(unitPath(home));
  return false;
}

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// launchd LaunchAgent. args = full argv for the process (node, script, __supervise, --payload-file, path).
export function plistFor({ args, log, label = LABEL }: { args: readonly string[]; log: string; label?: string }): string {
  const items = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

// systemd --user unit. ExecStart needs a single command line; args are space-joined (our args have no
// spaces except an absolute path with none in practice — quote the script path defensively).
export function unitFor({ args }: { args: readonly string[] }): string {
  const cmd = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return `[Unit]
Description=handmux — drive your tmux from your phone
After=network-online.target

[Service]
ExecStart=${cmd}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function installService(
  args: readonly string[],
  { home, platform = process.platform, exec = defaultExec, log = console }: ServiceOptions,
): string {
  ensurePrivateDirectorySync(pocketHome(home));
  const runtimeLog = logPath(home);
  const descriptor = fs.openSync(runtimeLog, 'a', 0o600);
  fs.closeSync(descriptor);
  fs.chmodSync(runtimeLog, 0o600);
  if (platform === 'darwin') {
    const p = plistPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, plistFor({ args, log: runtimeLog }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    exec('launchctl', ['unload', p], { stdio: 'ignore' }); // best-effort: clear any prior load
    const r = exec('launchctl', ['load', '-w', p], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchctl load failed: ${failureDetail(r)}`);
    log.log?.(`installed launchd agent: ${p}`);
    return p;
  }
  if (platform === 'linux') {
    const p = unitPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, unitFor({ args }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    exec('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const enabled = exec('systemctl', ['--user', 'enable', UNIT], { encoding: 'utf8' });
    if (enabled.status !== 0) throw new Error(`systemctl enable failed: ${failureDetail(enabled)}`);
    // `enable --now` does not restart an already-active unit. Always restart after rewriting ExecStart so
    // an npm/brew upgrade (new CLI/Node path) and a changed baked config take effect immediately.
    const restarted = exec('systemctl', ['--user', 'restart', UNIT], { encoding: 'utf8' });
    if (restarted.status !== 0) throw new Error(`systemctl restart failed: ${failureDetail(restarted)}`);
    log.log?.(`installed systemd --user unit: ${p}`);
    log.log?.('(for autostart before login: loginctl enable-linger "$USER")');
    return p;
  }
  throw new Error(`autostart not supported on ${platform} yet`);
}

// Stop the currently-loaded service without removing/disable-ing its login registration. This is what the
// ordinary `handmux stop` command needs: stay stopped for this login session, then start normally again at
// the next login/boot. In particular, do NOT SIGTERM the supervisor directly while KeepAlive/Restart=always
// is active — the service manager would immediately resurrect it and race a second manual supervisor.
export function stopService({ home, platform = process.platform, exec = defaultExec }: ServiceOptions): boolean {
  if (platform === 'darwin') {
    const r = exec('launchctl', ['unload', plistPath(home)], { encoding: 'utf8' });
    // unload returns non-zero when it was already unloaded; `stop` stays idempotent.
    return r.status === 0;
  }
  if (platform === 'linux') {
    const r = exec('systemctl', ['--user', 'stop', UNIT], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`systemctl stop failed: ${failureDetail(r)}`);
    return true;
  }
  throw new Error(`autostart not supported on ${platform} yet`);
}

export function uninstallService(
  { home, platform = process.platform, exec = defaultExec, log = console }: ServiceOptions,
): void {
  if (platform === 'darwin') {
    const p = plistPath(home);
    exec('launchctl', ['unload', '-w', p], { stdio: 'ignore' });
    try { fs.unlinkSync(p); } catch { /* already gone */ }
    log.log?.(`removed launchd agent: ${p}`);
    return;
  }
  if (platform === 'linux') {
    exec('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' });
    try { fs.unlinkSync(unitPath(home)); } catch { /* already gone */ }
    exec('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    log.log?.(`removed systemd --user unit: ${unitPath(home)}`);
    return;
  }
  throw new Error(`autostart not supported on ${platform} yet`);
}
