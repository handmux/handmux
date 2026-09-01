import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpHome } from './tmphome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../bin/handmux.js');

function executable(home: string, name: string, source: string): string {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return bin;
}

function run(home: string, args: string[], options: { cwd?: string; path?: string } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: home,
      LANG: 'en_US.UTF-8',
      PATH: options.path ?? `${path.join(home, 'bin')}:${process.env.PATH}`,
      RAW_MARKER: 'kept',
    },
    encoding: 'utf8',
    timeout: 8_000,
  });
}

function codexExecutable(home: string): void {
  executable(home, 'codex', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  const socket = args.find((arg) => arg.startsWith('unix://')).slice('unix://'.length);
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.writeFileSync(socket, 'ready');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (process.env.CODEX_TEST_MODE === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (process.env.CODEX_TEST_MODE === 'exit') {
  process.exit(Number(process.env.CODEX_TEST_EXIT));
} else {
  const input = process.env.CODEX_TEST_MODE === 'stdio' ? fs.readFileSync(0, 'utf8') : null;
  process.stdout.write(JSON.stringify({
    argv: args.slice(2), cwd: process.cwd(), marker: process.env.RAW_MARKER, input,
  }));
  if (process.env.CODEX_TEST_MODE === 'stdio') process.stderr.write('codex-stderr');
}
`);
}

function runCodex(
  home: string,
  args: string[] = [],
  options: { cwd?: string; mode?: string; exit?: number; input?: string } = {},
) {
  return spawnSync(process.execPath, [CLI, 'codex', ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: home,
      LANG: 'en_US.UTF-8',
      PATH: `${path.join(home, 'bin')}:${process.env.PATH}`,
      TMUX_PANE: '%71',
      RAW_MARKER: 'codex-kept',
      CODEX_TEST_MODE: options.mode,
      CODEX_TEST_EXIT: options.exit === undefined ? undefined : String(options.exit),
    },
    input: options.input,
    encoding: 'utf8',
    timeout: 8_000,
  });
}

describe('raw Agent launcher fast path', () => {
  it('passes Pi argv/cwd/env through exactly, including Handmux-looking flags and --', () => {
    const home = tmpHome('hm-pi-launch-');
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd);
    executable(home, 'pi', `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.RAW_MARKER }));
`);
    // A normal Handmux command would fail while peeking this malformed config. The raw launcher never reads it.
    fs.mkdirSync(path.join(home, '.handmux'));
    fs.writeFileSync(path.join(home, '.handmux/config.json'), '{broken');
    const args = ['install', '--config', 'one', '--lang', 'zh', '-x', '-x', '--', '--config', 'two'];

    const result = run(home, ['pi', ...args], { cwd });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ argv: args, cwd: fs.realpathSync(cwd), marker: 'kept' });
  });

  it('preserves child exit codes and stays silent when the Agent is silent', () => {
    const home = tmpHome('hm-pi-launch-');
    executable(home, 'pi', 'process.exit(23);');
    const result = run(home, ['pi']);
    expect(result.status).toBe(23);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('preserves terminating signal semantics', () => {
    const home = tmpHome('hm-pi-launch-');
    executable(home, 'pi', "process.kill(process.pid, 'SIGTERM');");
    const result = run(home, ['pi']);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('reports a missing Pi executable actionably with shell-compatible 127', () => {
    const home = tmpHome('hm-pi-launch-');
    const emptyPath = path.join(home, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const result = run(home, ['pi', 'install'], { path: emptyPath });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('pi executable not found');
  });

  it('routes Codex before Handmux parsing and passes every raw argument to its TUI', () => {
    const home = tmpHome('hm-codex-launch-');
    codexExecutable(home);
    fs.mkdirSync(path.join(home, '.handmux'));
    fs.writeFileSync(path.join(home, '.handmux/config.json'), '{broken');
    const raw = ['--config', 'agent.json', '--lang', 'xx', '--', '--config', 'again'];
    const result = runCodex(home, raw);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ argv: raw, marker: 'codex-kept' });
  });

  it('preserves Codex cwd/env/stdin/stdout/stderr across the managed launcher', () => {
    const home = tmpHome('hm-codex-stdio-');
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd);
    codexExecutable(home);
    const result = runCodex(home, ['--model', 'test'], {
      cwd, mode: 'stdio', input: 'from-stdin',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['--model', 'test'], cwd: fs.realpathSync(cwd), marker: 'codex-kept', input: 'from-stdin',
    });
    expect(result.stderr).toBe('codex-stderr');
  });

  it('preserves Codex non-zero exits and terminating signals', () => {
    const exitHome = tmpHome('hm-codex-exit-');
    codexExecutable(exitHome);
    expect(runCodex(exitHome, [], { mode: 'exit', exit: 29 }).status).toBe(29);

    const signalHome = tmpHome('hm-codex-signal-');
    codexExecutable(signalHome);
    const signaled = runCodex(signalHome, [], { mode: 'signal' });
    expect(signaled.status).toBeNull();
    expect(signaled.signal).toBe('SIGTERM');
  });
});
