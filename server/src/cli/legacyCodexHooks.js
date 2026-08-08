// Cleanup for Handmux versions that used to install Codex lifecycle hooks. Current Codex integration is
// App Server-only; this module can only remove Handmux's exact marked region and files, never install or
// synchronize hooks and never touch user-owned Codex configuration outside the marker.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { writeFileAtomic } from './hookScaffold.js';

const BEGIN = '# >>> handmux codex-hooks >>>';
const END = '# <<< handmux codex-hooks <<<';
const LEGACY_FILES = [
  'handmux-notify.sh',
  'handmux-write.cjs',
  'handmux-codex-usage.cjs',
  'handmux-notify.env',
];

export function stripLegacyCodexHooks(toml) {
  const text = toml || '';
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, '\n\n');
}

export function removeLegacyCodexHooks(home = homedir()) {
  const codexDir = path.join(home, '.codex');
  const configuredPath = path.join(codexDir, 'config.toml');
  let changed = false;
  try {
    const configFile = fs.lstatSync(configuredPath).isSymbolicLink()
      ? fs.realpathSync(configuredPath) : configuredPath;
    const mode = fs.statSync(configFile).mode & 0o777;
    const before = fs.readFileSync(configFile, 'utf8');
    const after = stripLegacyCodexHooks(before);
    if (after !== before) {
      writeFileAtomic(configFile, after);
      fs.chmodSync(configFile, mode);
      changed = true;
    }
  } catch { /* no readable config */ }

  const hooksDir = path.join(codexDir, 'hooks');
  for (const name of LEGACY_FILES) {
    try { fs.unlinkSync(path.join(hooksDir, name)); changed = true; } catch { /* absent or user-inaccessible */ }
  }
  return { changed };
}
