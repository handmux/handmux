import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supervisorConfigPath } from '../src/cli/state.js';
import {
  parseSupervisorConfig, readSupervisorLaunchConfig, supervisorLaunchArgs,
} from '../src/cli/supervisorLaunch.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-supervisor-launch-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('supervisor launch contract', () => {
  it('places secrets only in the private config file and passes its path in argv', () => {
    const config = { token: 'secret-token', vapid: { private: 'secret-vapid' } };
    const args = supervisorLaunchArgs(config, {
      home, entry: '/opt/handmux/bin/handmux.js', executable: '/usr/bin/node',
    });

    expect(args).toEqual([
      '/usr/bin/node', '/opt/handmux/bin/handmux.js', '__supervise',
      '--payload-file', supervisorConfigPath(home),
    ]);
    expect(args.join(' ')).not.toContain('secret-token');
    expect(args.join(' ')).not.toContain('secret-vapid');
    expect(readSupervisorLaunchConfig({ payloadFile: supervisorConfigPath(home) }, home)).toEqual(config);
    expect(fs.statSync(supervisorConfigPath(home)).mode & 0o777).toBe(0o600);
  });

  it('rejects another config path and accepts one legacy payload for upgrade compatibility', () => {
    expect(() => readSupervisorLaunchConfig({ payloadFile: path.join(home, 'other.json') }, home))
      .toThrow(/invalid supervisor config path/);
    const payload = Buffer.from(JSON.stringify({ token: 'legacy' })).toString('base64');
    expect(readSupervisorLaunchConfig({ legacyPayload: payload }, home)).toEqual({ token: 'legacy' });
  });

  it('validates persisted data before it reaches the supervisor', () => {
    expect(parseSupervisorConfig({
      tunnel: 'none', port: 19999, host: '0.0.0.0', token: 'secret',
      shortcuts: { command: [], chat: [] },
    })).toMatchObject({
      tunnel: 'none', port: 19999, host: '0.0.0.0', token: 'secret',
      shortcuts: { command: [], chat: [] },
    });
    expect(() => parseSupervisorConfig({
      tunnel: 'none', port: '19999', host: '0.0.0.0', token: 'secret',
    })).toThrow(/port must be an integer/);
    expect(() => parseSupervisorConfig({
      tunnel: 'bogus', port: 19999, host: '0.0.0.0', token: 'secret',
    })).toThrow(/unknown tunnel/);
  });
});
