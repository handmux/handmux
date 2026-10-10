// Resolve the tunlite binary (bundled dependency first → PATH) and probe passwordless SSH. tunlite is an
// npm dependency of handmux, so the bundled node_modules/.bin/tunlite means users need no separate install.
// `run`/`exists` injectable so the pure resolution logic unit-tests without spawning.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const BUNDLED = (() => {
  try {
    // Resolve the package entry first: relative paths from src/cli point at the package root, but the
    // compiled module lives one level deeper under dist/src/cli and would otherwise miss node_modules.
    const entry = require.resolve('tunlite/bin/tunlite.js');
    return path.resolve(path.dirname(entry), '../../.bin/tunlite');
  } catch { return null; }
})();

interface CommandResult { status: number | null }
type RunCommand = (command: string, args: string[], options: object) => CommandResult;

export interface ResolveTunliteOptions {
  run?: RunCommand;
  exists?: (path: string) => boolean;
  bundled?: string | null;
}

export function resolveTunlite({
  run = spawnSync,
  exists = fs.existsSync,
  bundled = BUNDLED,
}: ResolveTunliteOptions = {}): string {
  const candidate = bundled && exists(bundled) ? bundled : 'tunlite';
  const r = run(candidate, ['--version'], { encoding: 'utf8' });
  if (r && r.status === 0) return candidate;
  throw new Error('tunlite not found — install it (npm i -g tunlite / npx tunlite install)');
}

// 0 = passwordless SSH ready; non-zero (tunlite exit 4 = needs-auth) means key setup required.
export interface CheckSshAuthOptions {
  run?: RunCommand;
  bin?: string;
}

export function checkSshAuth(
  sshHost: string,
  { run = spawnSync, bin = 'tunlite' }: CheckSshAuthOptions = {},
): number | null {
  return run(bin, ['check', sshHost], { stdio: 'ignore' }).status;
}
