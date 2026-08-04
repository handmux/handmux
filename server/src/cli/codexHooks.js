// Install/uninstall the handmux Codex lifecycle hooks — the Codex analogue of claudeHooks.js. Codex 0.142+
// ships a Claude-parity hook system: the SAME event names, the SAME stdin JSON payload fields (session_id,
// cwd, hook_event_name, prompt, tool_input, last_assistant_message, stop_hook_active…), and the SAME
// {matcher, command} registration shape. So Codex reuses handmux's Claude hook scripts verbatim — the only
// thing that differs is WHERE they're registered (Codex's config.toml) and that we pass agent='codex' so
// the server tags the state entry (classify + liveness dispatch through the codex driver).
//
// Wiring: we append a MARKED region of inline `[[hooks.EVENT]]` tables to ~/.codex/config.toml. That inline
// form is the mechanism verified to parse (vs. a standalone hooks.json whose auto-discovery is unconfirmed).
// Multiple `[[hooks.X]]` array-of-tables entries merge, so our blocks coexist with the user's own hooks —
// no single-slot clobber risk (unlike the old `notify` program), hence no 'conflict' state.
//
// Presence is gated on the `codex` BINARY on PATH (see codexOnPath), NOT on ~/.codex existing — that dir
// name isn't unique to Codex CLI. Because the binary (not the dir) gates us, we MAY create ~/.codex.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { writeFileAtomic, deployHookScripts, removeHookScripts } from './hookScaffold.js';

// The events we register → the verb passed to handmux-notify.sh (classified by the shared Claude classifier,
// since Codex's payloads match). SessionStart is the authoritative pane→transcript binding, including after
// `/clear`; exclude `compact` because compaction stays in the same chat and must not neutralize a working turn.
// PostToolUse fires on every tool call, but its handmux-write.cjs handler for agent=codex is un-stick-ONLY.
const CODEX_HOOK_EVENTS = [
  { event: 'SessionStart', src: 'start', matcher: '^(startup|resume|clear)$' },
  { event: 'SessionEnd', src: 'end' },
  { event: 'UserPromptSubmit', src: 'prompt' },
  { event: 'Stop', src: 'stop' },
  { event: 'PermissionRequest', src: 'permreq' },
  { event: 'PostToolUse', src: 'resume' },
];

const BEGIN = '# >>> handmux codex-hooks >>>';
const END = '# <<< handmux codex-hooks <<<';

// True if an executable `codex` is resolvable on PATH. Windows adds the PATHEXT suffixes.
function codexOnPath(env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, `codex${ext}`), fs.constants.X_OK); return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

function codexDir(home = homedir()) { return path.join(home, '.codex'); }
function configPath(home = homedir()) { return path.join(codexDir(home), 'config.toml'); }
function hooksDir(home = homedir()) { return path.join(codexDir(home), 'hooks'); }

// Build the marked config.toml region: one `[[hooks.EVENT]]` + `[[hooks.EVENT.hooks]]` per event, each
// running the shared notify script with the event's verb and agent='codex'. The command path is single-
// quoted inside a TOML basic string (JSON.stringify) so a $HOME with spaces stays safe.
export function codexHooksBlock(home = homedir()) {
  const notify = path.join(hooksDir(home), 'handmux-notify.sh');
  const lines = [BEGIN, '# handmux inbox hooks for Codex — delete this whole region to disable.'];
  for (const e of CODEX_HOOK_EVENTS) {
    const cmd = `'${notify}' ${e.src} codex`;
    lines.push(`[[hooks.${e.event}]]`);
    if (e.matcher) lines.push(`matcher = ${JSON.stringify(e.matcher)}`);
    lines.push(`[[hooks.${e.event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(cmd)}`, '');
  }
  lines.push(END, '');
  return lines.join('\n');
}

// Pure: splice our marked region into config.toml text — replace an existing region in place (idempotent
// refresh), else append after the user's content. Returns the new text.
export function mergeCodexHooks(toml, block) {
  const text = toml || '';
  const b = text.indexOf(BEGIN);
  if (b >= 0) {
    const e = text.indexOf(END, b);
    if (e >= 0) return text.slice(0, b) + block.replace(/\n$/, '') + text.slice(e + END.length);
  }
  const prefix = text && !text.endsWith('\n') ? text + '\n' : text;
  return `${prefix}${prefix ? '\n' : ''}${block}`;
}

// Pure: remove our marked region (leaving the user's own hooks/config untouched).
export function stripCodexHooks(toml) {
  const text = toml || '';
  const b = text.indexOf(BEGIN);
  if (b < 0) return text;
  const e = text.indexOf(END, b);
  if (e < 0) return text;
  return (text.slice(0, b) + text.slice(e + END.length)).replace(/\n{3,}/g, '\n\n');
}

function readConf(home) {
  try { return fs.readFileSync(configPath(home), 'utf8'); } catch { return ''; }
}

// 'no-codex' → Codex CLI not on PATH (don't prompt). 'installed' → our region present. 'absent' → Codex
// installed, hooks not wired.
export function codexHooksStatus(home = homedir()) {
  if (!codexOnPath()) return 'no-codex';
  return readConf(home).includes(BEGIN) ? 'installed' : 'absent';
}

// Install (opt-in): copy the shared hook scripts into ~/.codex/hooks/, point their env at the shared state
// file, and splice our hook region into config.toml (creating ~/.codex if needed — safe, Codex is on PATH).
// Returns { status }: 'no-codex' (nothing to do) | 'installed'.
export function installCodexHooks(home = homedir(), { srcDir, stateFile } = {}) {
  if (!codexOnPath()) return { status: 'no-codex' };
  deployHookScripts(hooksDir(home), srcDir, stateFile);
  writeFileAtomic(configPath(home), mergeCodexHooks(readConf(home), codexHooksBlock(home)));
  return { status: 'installed' };
}

// Refresh an already opted-in install on server restart. Rebuild ONLY our marked region so newly-added
// lifecycle events (notably SessionStart for `/clear`) reach existing users without uninstall/reinstall;
// all user TOML outside the marker remains byte-for-byte untouched. Never enables hooks for an absent user.
export function syncCodexHooks(home = homedir(), { srcDir, stateFile } = {}) {
  // The marked config is the durable opt-in signal. Refresh it even when a service manager's PATH cannot
  // resolve the user's Codex binary; never turn a hook off merely because Node installations switched.
  const before = readConf(home);
  if (!before.includes(BEGIN)) return { status: codexHooksStatus(home), changed: false };
  deployHookScripts(hooksDir(home), srcDir, stateFile);
  const after = mergeCodexHooks(before, codexHooksBlock(home));
  const changed = after !== before;
  if (changed) writeFileAtomic(configPath(home), after);
  return { status: 'installed', changed };
}

// Uninstall: strip our config.toml region and remove the copied scripts/env. Best-effort.
export function uninstallCodexHooks(home = homedir()) {
  if (fs.existsSync(configPath(home))) writeFileAtomic(configPath(home), stripCodexHooks(readConf(home)));
  removeHookScripts(hooksDir(home));
  return { status: 'absent' };
}
