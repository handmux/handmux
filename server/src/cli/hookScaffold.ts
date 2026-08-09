// Shared IO scaffolding for the Claude Code hook installer and statusLine capturer.
import fs from 'node:fs';
import path from 'node:path';

export const HOOK_SCRIPTS = ['handmux-notify.sh', 'handmux-write.cjs'] as const;
const LEGACY_HOOK_SCRIPTS = ['handmux-codex-usage.cjs'];

// Atomic write (tmp + rename) so a crash can't leave a half-written config file. Text in, text out — callers
// pass raw TOML for config.toml, or use writeJsonAtomic for pretty-printed settings.json.
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
export const writeJsonAtomic = (file: string, value: unknown): void => (
  writeFileAtomic(file, JSON.stringify(value, null, 2))
);

// Deploy the Claude notify/write scripts into `hooksDir` and point their env at the shared state file.
export function deployHookScripts(hooksDir: string, srcDir: string, stateFile: string): void {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of HOOK_SCRIPTS) fs.copyFileSync(path.join(srcDir, f), path.join(hooksDir, f));
  for (const f of LEGACY_HOOK_SCRIPTS) {
    try { fs.unlinkSync(path.join(hooksDir, f)); } catch { /* absent */ }
  }
  fs.chmodSync(path.join(hooksDir, 'handmux-notify.sh'), 0o755);
  fs.writeFileSync(path.join(hooksDir, 'handmux-notify.env'), `HANDMUX_STATE=${stateFile}\n`, { mode: 0o600 });
}

// Remove the deployed scripts + env (uninstall). Best-effort: a missing file is fine.
export function removeHookScripts(hooksDir: string): void {
  for (const f of [...HOOK_SCRIPTS, ...LEGACY_HOOK_SCRIPTS, 'handmux-notify.env']) {
    try { fs.unlinkSync(path.join(hooksDir, f)); } catch { /* already gone */ }
  }
}
