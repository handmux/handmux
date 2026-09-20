// Shared IO scaffolding for the Agent hook installers and statusLine capturer.
import fs from 'node:fs';
import path from 'node:path';

// One deployable Hook set: the entry script handed to the Agent's settings (`notify` also stems the env file
// and acts as the settings marker), the env variable that script reads for its durable event spool, and any
// scripts a previous layout left behind. Claude and CodeBuddy each own one set; nothing else may be inferred
// from the script name, so a new Agent is a new entry here rather than a new copy of the deploy logic.
export interface HookScriptSet {
  notify: string;
  eventsVar: string;
  legacy?: readonly string[];
}

// The writer is shared by every Agent: the spool/state protocol is the Agent-independent half.
const WRITER_SCRIPT = 'handmux-write.cjs';

export const CLAUDE_HOOK_SET: HookScriptSet = {
  notify: 'handmux-notify.sh',
  eventsVar: 'HANDMUX_CLAUDE_EVENTS',
  legacy: ['handmux-codex-usage.cjs'],
};
export const CODEBUDDY_HOOK_SET: HookScriptSet = {
  notify: 'handmux-codebuddy-notify.sh',
  eventsVar: 'HANDMUX_CODEBUDDY_EVENTS',
};

// `handmux-notify.sh` → `handmux-notify.env`, alongside the script so `<dir>/<name>.env` is what sh sources.
const hookEnvName = (hookSet: HookScriptSet): string => `${hookSet.notify.replace(/\.sh$/, '')}.env`;

// Env files are sourced by /bin/sh; settings commands use the same shell word syntax.
export const shellWord = (value: string): string => /^[a-zA-Z0-9_./-]+$/.test(value)
  ? value : `'${value.replace(/'/g, `'"'"'`)}'`;

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

// Deploy an Agent's notify/write scripts into `hooksDir` and point their env at the shared state file.
export function deployHookScripts(
  hooksDir: string,
  srcDir: string,
  stateFile: string,
  hookSet: HookScriptSet = CLAUDE_HOOK_SET,
): void {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of [hookSet.notify, WRITER_SCRIPT]) {
    fs.copyFileSync(path.join(srcDir, f), path.join(hooksDir, f));
  }
  for (const f of hookSet.legacy ?? []) {
    try { fs.unlinkSync(path.join(hooksDir, f)); } catch { /* absent */ }
  }
  fs.chmodSync(path.join(hooksDir, hookSet.notify), 0o755);
  fs.writeFileSync(path.join(hooksDir, hookEnvName(hookSet)), [
    `HANDMUX_STATE=${shellWord(stateFile)}`,
    `${hookSet.eventsVar}=${shellWord(`${stateFile}.events`)}`,
    '',
  ].join('\n'), { mode: 0o600 });
}

// Remove the deployed scripts + env (uninstall). Best-effort: a missing file is fine.
export function removeHookScripts(hooksDir: string, hookSet: HookScriptSet = CLAUDE_HOOK_SET): void {
  const files = [hookSet.notify, WRITER_SCRIPT, hookEnvName(hookSet), ...(hookSet.legacy ?? [])];
  for (const f of files) {
    try { fs.unlinkSync(path.join(hooksDir, f)); } catch { /* already gone */ }
  }
}
