// Install/uninstall the Claude Code lifecycle hooks that feed the handmux inbox. This ports the idempotent
// merge from scripts/install-hooks.sh into testable JS so the OSS CLI (and the phone, via the server) can
// turn the inbox on — opt-in, since writing ~/.claude/settings.json edits another tool's config.
//
// Iron rule: only ever touch ~/.handmux/ and — after explicit opt-in — ~/.claude/. If ~/.claude is absent
// (no Claude Code), skip and report 'no-claude'; never create it.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeJsonAtomic, deployHookScripts, removeHookScripts } from './hookScaffold.js';

export interface ClaudeVersion { major: number; minor: number; patch: number }
export type ClaudeHookStatus = 'no-claude' | 'installed' | 'absent';
interface HookEvent {
  event: string;
  src: string;
  matcher?: string;
  minVersion?: string;
  pairWith?: string;
}
interface HookInstallOptions {
  srcDir?: string;
  stateFile?: string;
  claudeVersion?: ClaudeVersion | null;
}
interface VersionRunResult { status: number | null; stdout?: unknown }
export type ClaudeVersionExec = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number },
) => VersionRunResult | null | undefined;
type Settings = Record<string, unknown>;
type Hooks = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const settingsOf = (value: unknown): Settings => isRecord(value) ? { ...value } : {};
const readSettings = (home: string): Settings => {
  try { return settingsOf(JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')) as unknown); }
  catch { return {}; }
};
const defaultVersionExec: ClaudeVersionExec = (command, args, options) => {
  const result = spawnSync(command, [...args], options);
  return { status: result.status, stdout: result.stdout };
};

// The seven events the inbox reads. src is the arg passed to handmux-notify.sh; only PostToolUse is scoped to
// a matcher (the two "需要你" interaction tools) — every other Read/Bash/Edit must NOT wake the hook, or
// many concurrent Claude panes would each spawn the hook on every tool call. Keep this table in sync with
// the hook scripts in ../../hooks.
//   SessionStart binds the pane→session mapping the instant a session begins — critically after /clear, which
// starts a NEW transcript file. Without it, /clear's SessionEnd(old) drops the pane and nothing rebinds it
// until the next prompt, so the 对话 lens goes blank / falls back to the ambiguous cwd→newest-jsonl guess.
// Fires only at session boundaries (startup/clear/resume), never per tool call, so it adds no hot-path load;
// classified neutral (no push, no roster entry — see agents/claude.js). Base, not version-gated: SessionStart
// is a long-standing lifecycle hook every supported Claude recognises.
export const HOOK_EVENTS: readonly HookEvent[] = [
  { event: 'Stop', src: 'stop' },
  { event: 'Notification', src: 'notify' },
  { event: 'UserPromptSubmit', src: 'prompt' },
  { event: 'SessionStart', src: 'start' },
  { event: 'SessionEnd', src: 'end' },
  { event: 'PostToolUse', src: 'resume', matcher: 'AskUserQuestion|ExitPlanMode' },
  { event: 'PermissionRequest', src: 'permreq' },
];

// Version-gated events, only registered on a Claude Code new enough to EMIT them. Older Claude does not
// recognise these event names — and the docs give NO guarantee it ignores unknown ones (it "likely" does,
// but might reject the settings file) — so we NEVER write an event a version can't handle. Each carries a
// minVersion; below it (or when the version can't be detected) the event isn't written at all → pure
// downgrade, never an error. The pane instead self-heals via the existing idle_prompt(~60s) fallback.
//   PreCompact  → 压缩中 shown while compaction runs (honest progress for a slow op).
//   PostCompact → clears the 压缩中/进行中 state the instant compaction finishes.
//   StopFailure → a turn that died on an API error (rate limit / overload / …) fires NO Stop, so without
//                 this the pane sticks at 进行中 forever; maps to an 'error' state.
// `pairWith` welds an invariant (learned the hard way — never light a state you can't turn off): PreCompact
// is installed ONLY when its clearer PostCompact is also installed. minVersion is set conservatively to the
// version we've actually verified emits these (2.1.207); lower it only after test-firing an older build.
const COMPACT_MIN = '2.1.207';
export const HOOK_EVENTS_EXT: readonly HookEvent[] = [
  { event: 'PostCompact', src: 'compact', minVersion: COMPACT_MIN },
  { event: 'PreCompact', src: 'compacting', minVersion: COMPACT_MIN, pairWith: 'PostCompact' },
  { event: 'StopFailure', src: 'stopfail', minVersion: COMPACT_MIN },
];

const HOOK_MARK = 'handmux-notify.sh'; // identifies our hooks among the user's own

// Parse `claude --version` output ("2.1.207 (Claude Code)") → { major, minor, patch } | null.
export function parseClaudeVersion(out: unknown): ClaudeVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(out || ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

// v >= min ("X.Y.Z"), full major.minor.patch compare. A null/undefined version is always below → fail-closed.
export function claudeVersionAtLeast(v: ClaudeVersion | null | undefined, minStr: string): boolean {
  if (!v) return false;
  const [a, b, c] = String(minStr).split('.').map(Number);
  if (v.major !== a) return v.major > a;
  if (v.minor !== b) return v.minor > b;
  return v.patch >= c;
}

// Detect the installed Claude Code version, or null if `claude` can't be run/parsed (→ ext hooks skipped).
export function detectClaudeVersion(exec: ClaudeVersionExec = defaultVersionExec): ClaudeVersion | null {
  try {
    const r = exec('claude', ['--version'], { encoding: 'utf8', timeout: 4000 });
    if (!r || r.status !== 0 || !r.stdout) return null;
    return parseClaudeVersion(r.stdout);
  } catch { return null; }
}

// Drop OUR hook from settings.hooks[event] (used to prune an ext event that no longer passes the version
// gate — e.g. Claude was downgraded after a newer install). Mutates the passed hooks object.
const isOurHook = (value: unknown): boolean => {
  const hook = isRecord(value) ? value : null;
  return typeof hook?.command === 'string' && hook.command.includes(HOOK_MARK);
};
const cleanGroup = (value: unknown): unknown => {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  return { ...value, hooks: value.hooks.filter((hook) => !isOurHook(hook)) };
};
const nonEmptyGroup = (value: unknown): boolean => (
  !isRecord(value) || !Array.isArray(value.hooks) || value.hooks.length > 0
);

function dropOurHook(hooks: Hooks, event: string): void {
  if (!Array.isArray(hooks[event])) return;
  const kept = hooks[event].map(cleanGroup).filter(nonEmptyGroup);
  if (kept.length) hooks[event] = kept; else delete hooks[event];
}

// True if `settings.hooks[event]` already has one of our hooks (command references the dest script).
function alreadyHas(hooks: Hooks, event: string): boolean {
  const groups = hooks[event];
  return Array.isArray(groups) && groups.some((group) => (
    isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isOurHook)
  ));
}

// Merge one event's hook group into `hooks` (mutates), idempotently — a no-op if one of ours is already
// registered for that event, so it's safe to call on every install/sync. Shared by mergeHooks and syncHooks.
function addHook(hooks: Hooks, e: HookEvent, dest: string): void {
  if (alreadyHas(hooks, e.event)) return;
  const existing = hooks[e.event];
  const groups: unknown[] = hooks[e.event] = Array.isArray(existing) ? [...existing] : [];
  groups.push({ matcher: e.matcher || '', hooks: [{ type: 'command', command: `${dest} ${e.src}`, async: true, timeout: 5 }] });
}

// Pure: return a NEW settings object with our six hooks merged into settings.hooks, idempotently, leaving
// the user's own hooks and other keys untouched. `dest` is the absolute path to the copied notify script.
export function mergeHooks(settings: unknown, dest: string, claudeVersion: ClaudeVersion | null = null): Settings {
  const s = settingsOf(settings);
  const hooks: Hooks = isRecord(s.hooks) ? { ...s.hooks } : {};
  for (const e of HOOK_EVENTS) addHook(hooks, e, dest);
  // Version-gated ext events: install only when the detected Claude is new enough AND (for a paired event)
  // its clearer is also being installed. Anything that fails the gate is actively PRUNED, so a Claude
  // downgrade after a newer install can't leave an unrecognised event name lingering in settings.json.
  const enabled = new Set();
  for (const e of HOOK_EVENTS_EXT) {
    const ok = !!e.minVersion && claudeVersionAtLeast(claudeVersion, e.minVersion) && (!e.pairWith || enabled.has(e.pairWith));
    if (ok) { enabled.add(e.event); addHook(hooks, e, dest); } else dropOurHook(hooks, e.event);
  }
  s.hooks = hooks;
  return s;
}

// Pure: return a NEW settings object with all of OUR hooks removed (uninstall). An event group that ends up
// empty is dropped; the user's own hooks and other keys are untouched.
export function stripHooks(settings: unknown): Settings {
  const s = settingsOf(settings);
  if (!isRecord(s.hooks)) return s;
  const hooks: Hooks = {};
  for (const [event, groups] of Object.entries(s.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups.map(cleanGroup).filter(nonEmptyGroup);
    if (kept.length) hooks[event] = kept;
  }
  s.hooks = hooks;
  return s;
}

// Path helpers (also used by the IO shell in the next task).
function claudeDir(home: string = homedir()): string { return path.join(home, '.claude'); }
function settingsPath(home: string = homedir()): string { return path.join(claudeDir(home), 'settings.json'); }

// 'no-claude' → ~/.claude absent (don't prompt to enable). 'installed' → our hooks present. 'absent' →
// Claude Code is here but our hooks aren't (offer to enable).
export function hooksStatus(home: string = homedir()): ClaudeHookStatus {
  if (!fs.existsSync(claudeDir(home))) return 'no-claude';
  const settings = readSettings(home);
  const hooks: Hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return Object.keys(hooks).some((ev) => alreadyHas(hooks, ev)) ? 'installed' : 'absent';
}

// Install (opt-in): copy the bundled hook scripts to ~/.claude/hooks/, write the env pointing at the state
// file, and merge our six hooks into settings.json. Returns { status }. NEVER creates ~/.claude — if it's
// absent the user doesn't run Claude Code, so we report 'no-claude' and do nothing.
//   srcDir   = the bundled hooks dir (server/hooks)
//   stateFile = the unified ~/.handmux/claude-state.json path the hook writes and the server reads
export function installHooks(
  home: string = homedir(),
  { srcDir, stateFile, claudeVersion }: HookInstallOptions = {},
): { status: 'no-claude' | 'installed' } {
  if (!fs.existsSync(claudeDir(home))) return { status: 'no-claude' };
  if (!srcDir || !stateFile) throw new Error('hook srcDir and stateFile are required');
  const hooksDir = path.join(claudeDir(home), 'hooks');
  deployHookScripts(hooksDir, srcDir, stateFile);

  const dest = path.join(hooksDir, 'handmux-notify.sh');
  const settings = readSettings(home);
  // Gate the version-specific events (compact pair, StopFailure) on the installed Claude. Detect when the
  // caller didn't inject a version; a null result (no `claude` / unparseable) is fail-closed = base 6 only.
  const version = claudeVersion !== undefined ? claudeVersion : detectClaudeVersion();
  writeJsonAtomic(settingsPath(home), mergeHooks(settings, dest, version));
  return { status: 'installed' };
}

// Keep an ALREADY-installed user's hooks in step with this handmux version on every server start, so a plain
// `./deploy.sh` (restart) rolls out newly-added lifecycle events (e.g. SessionStart) and refreshed hook
// scripts — no phone re-enable needed. Two moves: (1) re-deploy the bundled hook scripts (idempotent — picks
// up a fixed handmux-write.cjs), and (2) add any of our BASE events a prior install predates.
//
// Strictly opt-in-preserving: a NO-OP unless our hooks are already present ('installed'). It never enables
// hooks for a user who hasn't opted in ('absent') and never creates ~/.claude ('no-claude'). BASE events
// only — it deliberately does NOT touch the version-gated ext events (compact pair / StopFailure): reconciling
// those needs the Claude version (a null read would PRUNE the ext hooks a user already has), and detecting it
// means spawning `claude --version` on the hot startup path. So sync stays pure-fs and non-pruning; ext-event
// rollout stays with the explicit installHooks (phone re-enable) path. settings.json is rewritten only when
// the merge actually changes it, so a steady state writes nothing.
export function syncHooks(
  home: string = homedir(),
  { srcDir, stateFile }: HookInstallOptions = {},
): { status: ClaudeHookStatus; changed: boolean } {
  const status = hooksStatus(home);
  if (status !== 'installed') return { status, changed: false };
  if (!srcDir || !stateFile) throw new Error('hook srcDir and stateFile are required');
  const hooksDir = path.join(claudeDir(home), 'hooks');
  deployHookScripts(hooksDir, srcDir, stateFile); // refresh the deployed scripts (idempotent)
  const dest = path.join(hooksDir, 'handmux-notify.sh');
  const settings = readSettings(home);
  const hooks: Hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const before = JSON.stringify(hooks);
  for (const e of HOOK_EVENTS) addHook(hooks, e, dest); // add only MISSING base events; never add/prune ext
  const changed = JSON.stringify(hooks) !== before;
  if (changed) writeJsonAtomic(settingsPath(home), { ...settings, hooks });
  return { status: 'installed', changed };
}

// Uninstall: strip our hooks from settings.json and remove the copied scripts/env. Best-effort on the file
// deletes (a missing file is fine). Leaves ~/.claude and the user's own hooks intact.
export function uninstallHooks(home: string = homedir()): { status: 'absent' } {
  const settings = readSettings(home);
  if (fs.existsSync(settingsPath(home))) writeJsonAtomic(settingsPath(home), stripHooks(settings));
  removeHookScripts(path.join(claudeDir(home), 'hooks'));
  return { status: 'absent' };
}
