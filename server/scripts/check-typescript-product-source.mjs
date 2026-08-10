#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(server, '..');
const productRoots = [path.join(server, 'src'), path.join(root, 'web', 'src')];
const javascriptExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function javascriptFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...javascriptFiles(target));
    else if (entry.isFile() && javascriptExtensions.has(path.extname(entry.name))) found.push(target);
  }
  return found;
}

const forbidden = productRoots.flatMap(javascriptFiles);
const legacyCli = path.join(server, 'bin', 'handmux-main.js');
if (fs.existsSync(legacyCli)) forbidden.push(legacyCli);

if (forbidden.length) {
  console.error('JavaScript product source is not allowed; migrate these files to TypeScript:');
  for (const file of forbidden.sort()) console.error(`- ${path.relative(root, file)}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(server, 'bin', 'handmux-main.ts'))) {
  console.error('Server CLI TypeScript entrypoint is missing: server/bin/handmux-main.ts');
  process.exit(1);
}

console.log('TypeScript product-source gate passed');
