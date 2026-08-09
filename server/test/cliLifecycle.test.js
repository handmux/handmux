import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from './tmphome.js';
import { writeState } from '../src/cli/state.js';
import { writeCache } from '../src/cli/updateCheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../bin/handmux.js');
const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

function status(home, psOut = '') {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakePs = path.join(bin, 'ps');
  fs.writeFileSync(fakePs, '#!/usr/bin/env node\nprocess.stdout.write(process.env.HANDMUX_TEST_PS || "");\n', { mode: 0o755 });
  return spawnSync(process.execPath, [CLI, 'status'], {
    env: {
      ...process.env,
      HOME: home,
      LANG: 'en_US.UTF-8',
      PATH: `${bin}:${process.env.PATH}`,
      HANDMUX_TEST_PS: psOut,
    },
    encoding: 'utf8',
    timeout: 3000,
  });
}

describe('CLI lifecycle', () => {
  it('status shows the installed version and exits when stopped', () => {
    const r = status(tmpHome('hm-cli-'));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`handmux ${VERSION} stopped`);
  });

  it('repairs legacy config permissions while reading the CLI language hint', () => {
    const home = tmpHome('hm-cli-');
    const directory = path.join(home, '.handmux');
    const file = path.join(directory, 'config.json');
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.chmodSync(directory, 0o755);
    fs.writeFileSync(file, '{"lang":"en"}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const r = status(home);

    expect(r.status).toBe(0);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('status distinguishes the running version after an upgrade and exits', () => {
    const home = tmpHome('hm-cli-');
    writeState({
      supervisorPid: process.pid,
      version: '0.1.0',
      tunnel: 'none',
      publicUrl: null,
      lanUrl: null,
      localUrl: 'http://localhost:19999',
      token: 'test-token',
    }, home);
    // Keep status on its cache-only hot path, without spawning the detached update worker in this test.
    writeCache(home, { checkedAt: Date.now(), latest: VERSION, whatsNew: null });

    const r = status(home, `${process.pid} S /usr/bin/node /x/handmux.js __supervise --payload test`);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('handmux 0.1.0 running');
    expect(r.stdout).toContain(`installed version ${VERSION} (takes effect after restart)`);
  });

  it('status reports duplicate supervisor pids and exits non-zero', () => {
    const home = tmpHome('hm-cli-');
    writeState({
      supervisorPid: process.pid,
      version: VERSION,
      tunnel: 'none',
      publicUrl: null,
      lanUrl: null,
      localUrl: 'http://localhost:19999',
      token: 'test-token',
    }, home);
    writeCache(home, { checkedAt: Date.now(), latest: VERSION, whatsNew: null });
    const ps = [
      `${process.pid} S /usr/bin/node /x/handmux.js __supervise --payload current`,
      '999999 S /usr/bin/node /old/handmux.js __supervise --payload stale',
    ].join('\n');

    const r = status(home, ps);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`multiple handmux supervisors detected (pids: ${process.pid}, 999999)`);
    expect(r.stderr).toContain('run `handmux stop` to reap every copy');
  });

  it('status reports a supervisor that exists without live state', () => {
    const home = tmpHome('hm-cli-');
    const r = status(home, '888888 S /usr/bin/node /old/handmux.js __supervise --payload stale');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('state is stale, but supervisor processes still exist (pids: 888888)');
  });
});
