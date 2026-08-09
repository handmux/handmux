#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..');
const expectedVersion = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8')).version;
const scratch = mkdtempSync(path.join(tmpdir(), 'handmux-pack-smoke-'));

try {
  execFileSync('npm', ['pack', '--pack-destination', scratch], { cwd: server, stdio: 'inherit' });
  const archive = readdirSync(scratch).find((name) => name.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack did not produce a tarball');

  const installDir = path.join(scratch, 'install');
  mkdirSync(installDir);
  writeFileSync(path.join(installDir, 'package.json'), '{"private":true}\n');
  execFileSync('npm', ['install', path.join(scratch, archive), '--ignore-scripts'], {
    cwd: installDir,
    stdio: 'inherit',
  });

  const installed = path.join(installDir, 'node_modules', 'handmux');
  for (const required of [
    'bin/handmux.js',
    'dist/bin/handmux.js',
    'dist/src/server.js',
    'dist/public/index.html',
    'dist/hooks/handmux-write.cjs',
  ]) {
    if (!existsSync(path.join(installed, required))) throw new Error(`packed file missing: ${required}`);
  }
  if (existsSync(path.join(installed, 'src'))) throw new Error('raw Server source leaked into the package');

  const bin = path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'handmux.cmd' : 'handmux');
  const actualVersion = execFileSync(bin, ['--version'], { cwd: installDir, encoding: 'utf8' }).trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`packed CLI version mismatch: expected ${expectedVersion}, received ${actualVersion}`);
  }
  console.log(`[pack-smoke] handmux@${actualVersion} install and CLI startup passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
