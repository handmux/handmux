import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installationAuthDefaults, tokenWarning } from '../src/cli/authDefaults.js';
import { resolveConfig, explainConfig } from '../src/cli/options.js';
import { configPath, statePath, supervisorConfigPath } from '../src/cli/state.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

describe('CLI authentication defaults', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(tmpdir(), 'handmux-auth-defaults-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const write = (file: string, value: unknown) => new PrivateStateStore(file).write(value);
  const generated = () => 'new-random-token';
  function defaults(flags = {}, env = {}) { return installationAuthDefaults(home, configPath(home), flags, env); }

  it('identifies a fresh installation without selecting an authentication mode', () => {
    const context = defaults();
    expect(context).toEqual({ isNew: true });
    expect(resolveConfig({}, {}, {}, generated, context).token).toBe('new-random-token');
    expect(explainConfig({}, {}, null, {}, context).find((row) => row.key === 'authMode')).toBeUndefined();
    expect(fs.existsSync(configPath(home))).toBe(false);
  });

  it('preserves a configured token exactly', () => {
    const cfg = { token: 'configured-token' };
    write(configPath(home), cfg);
    expect(resolveConfig({}, cfg, {}, generated, defaults())).toMatchObject({ token: cfg.token });
  });

  it.each([statePath, supervisorConfigPath])('reuses the runtime token when setup has not pinned one: %s', (file) => {
    write(file(home), { token: 'runtime-token' });
    expect(resolveConfig({}, {}, {}, generated, defaults())).toMatchObject({ token: 'runtime-token' });
  });

  it('uses explicit flag and environment tokens', () => {
    expect(resolveConfig({ token: 'flag-token' }, {}, {}, generated, defaults({ token: 'flag-token' })).token).toBe('flag-token');
    expect(resolveConfig({}, {}, { HANDMUX_TOKEN: 'environment-token' }, generated, defaults({}, { HANDMUX_TOKEN: 'environment-token' })).token).toBe('environment-token');
  });

  it('renders startup warnings with or without terminal colour', () => {
    expect(tokenWarning('Insecure', true)).toBe('\u001b[33mInsecure\u001b[39m');
    expect(tokenWarning('Insecure', false)).toBe('Insecure');
  });
});
