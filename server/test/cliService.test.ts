import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  plistFor, unitFor, plistPath, unitPath, installService, uninstallService,
  isServiceInstalled, stopService, LABEL, UNIT,
} from '../src/cli/service.js';
import type { ServiceExec } from '../src/cli/service.js';

const ARGS = ['/usr/bin/node', '/abs/bin/handmux.js', '__supervise', '--payload-file', '/home/u/.handmux/supervisor-config.json'];

describe('service text generators', () => {
  it('plist lists every arg and sets RunAtLoad/KeepAlive', () => {
    const p = plistFor({ args: ARGS, log: '/home/u/.handmux/handmux.log' });
    for (const a of ARGS) expect(p).toContain(`<string>${a}</string>`);
    expect(p).toContain('<key>RunAtLoad</key><true/>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('/home/u/.handmux/handmux.log');
  });
  it('plist escapes XML metacharacters', () => {
    expect(plistFor({ args: ['a&b', 'c<d'], log: 'x' })).toContain('<string>a&amp;b</string>');
  });
  it('systemd unit has ExecStart with the joined command and Restart=always', () => {
    const u = unitFor({ args: ARGS });
    expect(u).toContain('ExecStart=/usr/bin/node /abs/bin/handmux.js __supervise --payload-file /home/u/.handmux/supervisor-config.json');
    expect(u).toContain('Restart=always');
    expect(u).toContain('WantedBy=default.target');
  });
});

describe('install/uninstall (mocked exec, temp home)', () => {
  let home: string;
  let calls: string[][];
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-svc-')); calls = []; });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const exec: ServiceExec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stderr: '' };
  };

  it('darwin writes the plist and runs launchctl load', () => {
    installService(ARGS, { home, platform: 'darwin', exec, log: { log() {} } });
    expect(fs.existsSync(plistPath(home))).toBe(true);
    expect(fs.statSync(plistPath(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, '.handmux', 'handmux.log')).mode & 0o777).toBe(0o600);
    expect(calls.some(([c, a]) => c === 'launchctl' && a === 'load')).toBe(true);
  });
  it('linux writes the unit and enables it', () => {
    installService(ARGS, { home, platform: 'linux', exec, log: { log() {} } });
    expect(fs.existsSync(unitPath(home))).toBe(true);
    expect(fs.statSync(unitPath(home)).mode & 0o777).toBe(0o600);
    expect(calls.some((c) => c.join(' ') === `systemctl --user enable ${UNIT}`)).toBe(true);
    expect(calls.some((c) => c.join(' ') === `systemctl --user restart ${UNIT}`)).toBe(true);
  });
  it('linux reinstall replaces an upgrade-stale executable path and restarts the one unit', () => {
    installService(ARGS, { home, platform: 'linux', exec, log: { log() {} } });
    const upgraded = ['/new/node', '/new/handmux.js', '__supervise', '--payload-file', '/home/u/.handmux/supervisor-config.json'];
    installService(upgraded, { home, platform: 'linux', exec, log: { log() {} } });
    const unit = fs.readFileSync(unitPath(home), 'utf8');
    expect(unit).toContain('ExecStart=/new/node /new/handmux.js __supervise --payload-file /home/u/.handmux/supervisor-config.json');
    expect(unit).not.toContain('/abs/bin/handmux.js');
    expect(calls.filter((c) => c.join(' ') === `systemctl --user restart ${UNIT}`)).toHaveLength(2);
  });
  it('unsupported platform throws', () => {
    expect(() => installService(ARGS, { home, platform: 'sunos', exec })).toThrow(/not supported/);
  });
  it('darwin uninstall unloads and removes the plist', () => {
    installService(ARGS, { home, platform: 'darwin', exec, log: { log() {} } });
    uninstallService({ home, platform: 'darwin', exec, log: { log() {} } });
    expect(fs.existsSync(plistPath(home))).toBe(false);
    expect(calls.some(([c, a]) => c === 'launchctl' && a === 'unload')).toBe(true);
  });
  it('detects a registered service by its platform file', () => {
    expect(isServiceInstalled(home, 'linux')).toBe(false);
    installService(ARGS, { home, platform: 'linux', exec, log: { log() {} } });
    expect(isServiceInstalled(home, 'linux')).toBe(true);
    expect(isServiceInstalled(home, 'darwin')).toBe(false);
  });
  it('linux stop leaves the enabled unit file in place', () => {
    installService(ARGS, { home, platform: 'linux', exec, log: { log() {} } });
    stopService({ home, platform: 'linux', exec });
    expect(calls.some((c) => c.join(' ') === `systemctl --user stop ${UNIT}`)).toBe(true);
    expect(fs.existsSync(unitPath(home))).toBe(true);
  });
  it('darwin stop unloads without deleting or disabling the plist', () => {
    installService(ARGS, { home, platform: 'darwin', exec, log: { log() {} } });
    stopService({ home, platform: 'darwin', exec });
    expect(calls.some((c) => c.join(' ') === `launchctl unload ${plistPath(home)}`)).toBe(true);
    expect(fs.existsSync(plistPath(home))).toBe(true);
  });
});
