#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..');
const root = path.resolve(server, '..');
const out = path.join(server, 'dist');

rmSync(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [path.join(server, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', path.join(server, 'tsconfig.build.json')],
  { cwd: server, stdio: 'inherit' },
);

// Keep the public launcher path stable while the implementation itself migrates from JS to TS.
renameSync(path.join(out, 'bin', 'handmux-main.js'), path.join(out, 'bin', 'handmux.js'));

// Runtime code keeps the same relative layout inside dist: bin/, src/, hooks/, public/ and package.json.
// This lets migration happen file-by-file without making asset lookup depend on whether a module is JS or TS.
cpSync(path.join(server, 'hooks'), path.join(out, 'hooks'), { recursive: true });

const publicSource = [path.join(server, 'public'), path.join(root, 'web', 'dist')]
  .find((candidate) => existsSync(candidate));
if (publicSource) cpSync(publicSource, path.join(out, 'public'), { recursive: true });

// The compiled CLI reads its adjacent package metadata for --version and update checks. Keep a generated
// copy in dist so those lookups remain deterministic in source builds and in the published tarball.
const packageJson = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
