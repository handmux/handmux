import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authOverrideNeedsConfirmation, installationAuthDefaults, tokenWarning } from '../src/cli/authDefaults.js';
import { resolveConfig, explainConfig } from '../src/cli/options.js';
import { configPath, statePath, supervisorConfigPath } from '../src/cli/state.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

describe('CLI authentication installation defaults', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(tmpdir(), 'handmux-auth-defaults-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const write = (file: string, value: unknown) => new PrivateStateStore(file).write(value);
  const generated = () => 'new-random-token';
  function defaults(flags = {}, env = {}) { return installationAuthDefaults(home, configPath(home), flags, env); }

  it('defaults a genuinely fresh start to trusted-device without creating a config', () => {
    const context = defaults();
    expect(context).toMatchObject({ isNew: true, authMode: 'trusted-device' });
    expect(resolveConfig({}, {}, {}, generated, context).authMode).toBe('trusted-device');
    expect(explainConfig({}, {}, null, {}, context).find((row) => row.key === 'authMode')?.display).toBe('trusted-device');
    expect(fs.existsSync(configPath(home))).toBe(false);
  });

  it('keeps an existing empty config in legacy token mode', () => {
    write(configPath(home), {});
    expect(defaults()).toMatchObject({ isNew: false, authMode: 'token' });
  });

  it('preserves a legacy configured token exactly', () => {
    const cfg = { token: 'short-legacy-token' };
    write(configPath(home), cfg);
    expect(resolveConfig({}, cfg, {}, generated, defaults())).toMatchObject({ authMode: 'token', token: cfg.token });
  });

  it.each([statePath, supervisorConfigPath])('preserves legacy runtime credentials without a config: %s', (file) => {
    write(file(home), { token: 'old-runtime-token' });
    expect(resolveConfig({}, {}, {}, generated, defaults())).toMatchObject({ authMode: 'token', token: 'old-runtime-token' });
  });

  it('keeps configless trusted-device restarts in trusted mode', () => {
    write(supervisorConfigPath(home), { authMode: 'trusted-device', token: 'unused-random-token' });
    expect(defaults()).toMatchObject({ isNew: false, authMode: 'trusted-device' });
  });

  it('a token alone cannot downgrade an existing trusted-device installation', () => {
    write(supervisorConfigPath(home), { authMode: 'trusted-device', token: 'unused-random-token' });
    const flags = { token: 'flag-token' };
    const env = { HANDMUX_TOKEN: 'environment-token' };
    expect(resolveConfig(flags, {}, {}, generated, defaults(flags)).authMode).toBe('trusted-device');
    expect(resolveConfig({}, {}, env, generated, defaults({}, env)).authMode).toBe('trusted-device');
  });

  it('preserves runtime token fallbacks even when the persisted legacy config does not pin one', () => {
    write(configPath(home), { tunnel: 'none' });
    write(supervisorConfigPath(home), { authMode: 'token', token: 'existing-auto-token' });
    expect(resolveConfig({}, { tunnel: 'none' }, {}, generated, defaults()).token).toBe('existing-auto-token');
  });

  it('does not mistake corrupt historical metadata for a new installation', () => {
    write(statePath(home), null);
    expect(defaults()).toMatchObject({ isNew: false, authMode: 'token' });
  });

  it('respects explicit token mode and old environment or flag tokens', () => {
    expect(resolveConfig({ authMode: 'token' }, {}, {}, generated, defaults()).authMode).toBe('token');
    const env = { HANDMUX_TOKEN: 'environment-token' };
    expect(resolveConfig({}, {}, env, generated, defaults({}, env))).toMatchObject({ authMode: 'token', token: env.HANDMUX_TOKEN });
    const flags = { token: 'flag-token' };
    expect(resolveConfig(flags, {}, {}, generated, defaults(flags))).toMatchObject({ authMode: 'token', token: flags.token });
  });

  it('lets explicit auth selection override legacy defaults without rotating its token', () => {
    write(statePath(home), { token: 'keep-me' });
    expect(resolveConfig({ authMode: 'trusted-device' }, {}, {}, generated, defaults())).toMatchObject({ authMode: 'trusted-device', token: 'keep-me' });
  });

  it('renders the warning yellow in terminals and readable in captured startup output', () => {
    expect(tokenWarning('Insecure', true)).toBe('\u001b[33mInsecure\u001b[39m');
    expect(tokenWarning('Insecure', false)).toBe('Insecure');
  });

  it('only requires consent for an override changing an existing mode, not configured autostart', () => {
    const baseline = { flags: {}, fileCfg: {}, env: {}, defaults: { isNew: false, authMode: 'token' as const } };
    expect(authOverrideNeedsConfirmation({ ...baseline, flags: { authMode: 'trusted-device' } })).toBe(true);
    expect(authOverrideNeedsConfirmation({ ...baseline, env: { HANDMUX_AUTH_MODE: 'trusted-device' } })).toBe(true);
    expect(authOverrideNeedsConfirmation({ ...baseline, flags: { authMode: 'token' } })).toBe(false);
    expect(authOverrideNeedsConfirmation({ ...baseline, fileCfg: { authMode: 'trusted-device' } })).toBe(false);
    expect(authOverrideNeedsConfirmation({ ...baseline, flags: { authMode: 'token' }, runningMode: 'trusted-device' })).toBe(true);
    expect(authOverrideNeedsConfirmation({ ...baseline, flags: { authMode: 'token' }, defaults: { isNew: true, authMode: 'trusted-device' } })).toBe(false);
  });

  it.each(['start', 'restart', 'service'])('rejects non-TTY %s mode switches before touching runtime state', (command) => {
    write(configPath(home), { authMode: 'token', token: 'keep-me' });
    write(statePath(home), { supervisorPid: process.pid, token: 'keep-me' });
    const before = fs.readFileSync(statePath(home), 'utf8');
    const args = [path.resolve('bin/handmux.js'), command, ...(command === 'service' ? ['install'] : []), '--auth-mode', 'trusted-device'];
    const result = spawnSync(process.execPath, args, {
      env: { ...process.env, HOME: home, HANDMUX_AUTH_MODE: '', HANDMUX_TOKEN: '', HANDMUX_LANG: 'en', LANG: 'en_US.UTF-8' },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No service was stopped or restarted');
    expect(fs.readFileSync(statePath(home), 'utf8')).toBe(before);
    expect(new PrivateStateStore(configPath(home)).readStrict()).toEqual({ authMode: 'token', token: 'keep-me' });
    expect(fs.existsSync(supervisorConfigPath(home))).toBe(false);
  });
});
