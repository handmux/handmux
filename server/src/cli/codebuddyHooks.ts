// Install/uninstall the CodeBuddy Code lifecycle hooks that feed the handmux inbox. Structurally this is
// claudeHooks.ts again — CodeBuddy's hooks follow the Claude Code settings schema — but it is a separate
// module on purpose: it writes another tool's config in another tool's directory, so it owns its own marker,
// its own settings file and its own script set. One installer must never edit two products' configs.
//
// Iron rule: only ever touch ~/.handmux/ and — after explicit opt-in — ~/.codebuddy/. If ~/.codebuddy is
// absent (no CodeBuddy), skip and report 'no-codebuddy'; never create it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  CODEBUDDY_HOOK_SET,
  deployHookScripts,
  removeHookScripts,
  shellWord,
  writeJsonAtomic,
} from './hookScaffold.js';

export type CodeBuddyHookStatus = 'no-codebuddy' | 'installed' | 'absent';
export type CodeBuddyHookHealth = CodeBuddyHookStatus | 'stale';
interface HookEvent {
  event: string;
  src: string;
  // Only the interaction tools should wake this one: every other Read/Bash/Edit must NOT, or the hook fires
  // on every tool call in a turn.
  matcher?: string;
  // Version-gated extension events: written only for a CodeBuddy new enough to EMIT them, and pruned when the
  // gate fails, so a downgrade can never leave an event name the CLI does not recognise.
  minVersion?: string;
  pairWith?: string;
}

export interface CodeBuddyVersion { major: number; minor: number; patch: number }
type CodeBuddyVersionExec = (
  command: string, args: readonly string[], options: { encoding: 'utf8'; timeout: number },
) => { status: number | null; stdout?: string | null };
export interface CodeBuddyHookInstallOptions {
  srcDir?: string;
  // Injected in tests; production detects it from `codebuddy --version`.
  codebuddyVersion?: CodeBuddyVersion | null;
  stateFile?: string;
}
type Settings = Record<string, unknown>;
type Hooks = Record<string, unknown>;

const NOTIFY_SCRIPT = CODEBUDDY_HOOK_SET.notify;
const ENV_FILE = `${NOTIFY_SCRIPT.replace(/\.sh$/, '')}.env`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const settingsOf = (value: unknown): Settings => isRecord(value) ? { ...value } : {};
const readSettings = (home: string): Settings => {
  try { return settingsOf(JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')) as unknown); }
  catch { return {}; }
};

// The five events the inbox reads on CodeBuddy (verified against 2.155.0). src is the argument passed to
// handmux-codebuddy-notify.sh. No matcher: none of these are tool-scoped, so no per-tool-call hot path is
// added — the hook only ever fires at a session/turn boundary.
//   SessionStart binds the pane→session mapping the instant a session begins. It is also the only payload
//   carrying CodeBuddy's transcript_path, so without it the conversation page has no session to open.
// Keep this table in sync with ../../hooks/handmux-codebuddy-notify.sh.
export const HOOK_EVENTS: readonly HookEvent[] = [
  { event: 'Stop', src: 'stop' },
  { event: 'Notification', src: 'notify' },
  { event: 'UserPromptSubmit', src: 'prompt' },
  { event: 'SessionStart', src: 'start' },
  { event: 'SessionEnd', src: 'end' },
  // The pair that owns "需要你": PermissionRequest lights it the moment the dialog appears, and PostToolUse on
  // the two interaction tools clears it the moment the user answers — the same events Claude installs. Without
  // them the state stays lit after the user replies, until the turn happens to end.
  { event: 'PostToolUse', src: 'resume', matcher: 'AskUserQuestion|ExitPlanMode' },
  { event: 'PermissionRequest', src: 'permreq' },
];

// Version-gated events, mirroring Claude's: written only for a CLI new enough to emit them, pruned otherwise
// (fail-closed when the version cannot be read). Each closes a state we would otherwise light and never turn
// off:
//   PreCompact  → 压缩中 while compaction runs.
//   PostCompact → clears it the instant compaction finishes.
//   StopFailure → a turn that died on an API error (rate limit / overload / …) fires NO Stop, so without this
//                 the pane sticks at 进行中 forever; maps to an 'error' state.
// `pairWith` welds the invariant "never light a state you cannot turn off": PreCompact installs only together
// with its clearer PostCompact. minVersion is the version these were verified to exist in (2.155.0); lower it
// only after test-firing an older build.
const COMPACT_MIN = '2.155.0';
export const HOOK_EVENTS_EXT: readonly HookEvent[] = [
  { event: 'PostCompact', src: 'compact', minVersion: COMPACT_MIN },
  { event: 'PreCompact', src: 'compacting', minVersion: COMPACT_MIN, pairWith: 'PostCompact' },
  { event: 'StopFailure', src: 'stopfail', minVersion: COMPACT_MIN },
];

const defaultVersionExec: CodeBuddyVersionExec = (command, args, options) => {
  const r = spawnSync(command, [...args], options);
  return { status: r.status, stdout: r.stdout };
};

// Parse `codebuddy --version` output ("2.155.0") → { major, minor, patch } | null.
export function parseCodeBuddyVersion(out: unknown): CodeBuddyVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(out || ''));
  return m ? { major: Number(m[1] ?? 0), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) } : null;
}

// v >= min ("X.Y.Z"); an unknown version is always below → the gate fails closed.
export function codeBuddyVersionAtLeast(v: CodeBuddyVersion | null | undefined, minStr: string): boolean {
  if (!v) return false;
  const [a = 0, b = 0, c = 0] = String(minStr).split('.').map(Number);
  if (v.major !== a) return v.major > a;
  if (v.minor !== b) return v.minor > b;
  return v.patch >= c;
}

// Detect the installed CodeBuddy version, or null when it cannot be run/parsed (→ ext events are skipped).
export function detectCodeBuddyVersion(exec: CodeBuddyVersionExec = defaultVersionExec): CodeBuddyVersion | null {
  try {
    for (const command of ['codebuddy', 'cbc']) {
      const r = exec(command, ['--version'], { encoding: 'utf8', timeout: 4000 });
      if (r && r.status === 0 && r.stdout) {
        const parsed = parseCodeBuddyVersion(r.stdout);
        if (parsed) return parsed;
      }
    }
    return null;
  } catch { return null; }
}

// Identifies OUR hooks among the user's own. Distinct from Claude's marker, so neither installer can mistake
// the other's entries for its own even if a config directory is ever shared.
const HOOK_MARK = NOTIFY_SCRIPT;

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

function alreadyHas(hooks: Hooks, event: string): boolean {
  const groups = hooks[event];
  return Array.isArray(groups) && groups.some((group) => (
    isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isOurHook)
  ));
}

function ownedHookCount(hooks: Hooks, event: string): number {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((count, group) => (
    count + (isRecord(group) && Array.isArray(group.hooks)
      ? group.hooks.filter(isOurHook).length : 0)
  ), 0);
}

function hasExpectedHook(hooks: Hooks, event: HookEvent, dest: string): boolean {
  const groups = hooks[event.event];
  const command = `${shellWord(dest)} ${event.src}`;
  return Array.isArray(groups) && groups.some((group) => (
    isRecord(group)
    && group.matcher === (event.matcher ?? '')
    && Array.isArray(group.hooks)
    && group.hooks.some((hook) => (
      isRecord(hook)
      && hook.type === 'command'
      && hook.command === command
      && hook.async === true
      && hook.timeout === 5
    ))
  ));
}

// Merge one event's hook group into `hooks` (mutates), idempotently: first remove Handmux-owned entries for
// this event, then append the canonical destination. This repairs wrappers left by moved package installs
// without touching any user/third-party hook that does not carry our marker.
function addHook(hooks: Hooks, e: HookEvent, dest: string): void {
  if (ownedHookCount(hooks, e.event) === 1 && hasExpectedHook(hooks, e, dest)) return;
  dropOurHook(hooks, e.event);
  const existing = hooks[e.event];
  const groups: unknown[] = hooks[e.event] = Array.isArray(existing) ? [...existing] : [];
  groups.push({
    matcher: e.matcher ?? '',
    hooks: [{ type: 'command', command: `${shellWord(dest)} ${e.src}`, async: true, timeout: 5 }],
  });
}

// Pure: return a NEW settings object with our hooks merged into settings.hooks, idempotently, leaving
// the user's own hooks and other keys untouched. `dest` is the absolute path to the copied notify script.
export function mergeHooks(settings: unknown, dest: string, codebuddyVersion: CodeBuddyVersion | null = null): Settings {
  const s = settingsOf(settings);
  const hooks: Hooks = isRecord(s.hooks) ? { ...s.hooks } : {};
  for (const e of HOOK_EVENTS) addHook(hooks, e, dest);
  // Extension events: only for a CLI that emits them, and only with their clearer installed too.
  const enabled = new Set<string>();
  for (const e of HOOK_EVENTS_EXT) {
    const ok = !!e.minVersion
      && codeBuddyVersionAtLeast(codebuddyVersion, e.minVersion)
      && (!e.pairWith || enabled.has(e.pairWith));
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

function codebuddyDir(home: string = homedir()): string { return path.join(home, '.codebuddy'); }
function settingsPath(home: string = homedir()): string {
  return path.join(codebuddyDir(home), 'settings.json');
}
function notifyDest(home: string = homedir()): string {
  return path.join(codebuddyDir(home), 'hooks', NOTIFY_SCRIPT);
}

// 'no-codebuddy' → ~/.codebuddy absent (don't prompt to enable). 'installed' → our hooks present. 'absent' →
// CodeBuddy is here but our hooks aren't (offer to enable).
export function hooksStatus(home: string = homedir()): CodeBuddyHookStatus {
  if (!fs.existsSync(codebuddyDir(home))) return 'no-codebuddy';
  const settings = readSettings(home);
  const hooks: Hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return Object.keys(hooks).some((ev) => alreadyHas(hooks, ev)) ? 'installed' : 'absent';
}

function regularFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Stronger diagnostic used by `handmux agent`: any partial/old registration is repairable, not ready. Every
// registered event and every deployed runtime file is required.
export function hooksHealthStatus(home: string = homedir()): CodeBuddyHookHealth {
  const status = hooksStatus(home);
  if (status !== 'installed') return status;
  const hooksDir = path.join(codebuddyDir(home), 'hooks');
  const dest = notifyDest(home);
  const settings = readSettings(home);
  const hooks: Hooks = isRecord(settings.hooks) ? settings.hooks : {};
  if (!HOOK_EVENTS.every((event) => (
    ownedHookCount(hooks, event.event) === 1 && hasExpectedHook(hooks, event, dest)
  ))) return 'stale';
  if (![dest, path.join(hooksDir, 'handmux-write.cjs'), path.join(hooksDir, ENV_FILE)].every(regularFile)) {
    return 'stale';
  }
  return 'installed';
}

// Install (opt-in): copy the bundled hook scripts to ~/.codebuddy/hooks/, write the env pointing at the state
// file, and merge our hooks into settings.json. NEVER creates ~/.codebuddy — if it's absent the user
// doesn't run CodeBuddy, so we report 'no-codebuddy' and do nothing.
//   srcDir    = the bundled hooks dir (server/hooks)
//   stateFile = the unified ~/.handmux/codebuddy-state.json path the hook writes and the server reads
export function installHooks(
  home: string = homedir(),
  { srcDir, stateFile, codebuddyVersion }: CodeBuddyHookInstallOptions = {},
): { status: 'no-codebuddy' | 'installed' } {
  if (!fs.existsSync(codebuddyDir(home))) return { status: 'no-codebuddy' };
  if (!srcDir || !stateFile) throw new Error('hook srcDir and stateFile are required');
  deployHookScripts(path.join(codebuddyDir(home), 'hooks'), srcDir, stateFile, CODEBUDDY_HOOK_SET);
  const settings = readSettings(home);
  const version = codebuddyVersion !== undefined ? codebuddyVersion : detectCodeBuddyVersion();
  writeJsonAtomic(settingsPath(home), mergeHooks(settings, notifyDest(home), version));
  return { status: 'installed' };
}

// Keep an ALREADY-installed user's hooks in step with this handmux version on every server start, so a plain
// `./deploy.sh` (restart) rolls out newly-added lifecycle events and refreshed hook scripts — no phone
// re-enable needed. Strictly opt-in-preserving: a NO-OP unless our hooks are already present ('installed').
// It never enables hooks for a user who hasn't opted in ('absent') and never creates ~/.codebuddy
// ('no-codebuddy'). settings.json is rewritten only when the merge actually changes it, so a steady state
// writes nothing.
export function syncHooks(
  home: string = homedir(),
  { srcDir, stateFile }: CodeBuddyHookInstallOptions = {},
): { status: CodeBuddyHookStatus; changed: boolean } {
  const status = hooksStatus(home);
  if (status !== 'installed') return { status, changed: false };
  if (!srcDir || !stateFile) throw new Error('hook srcDir and stateFile are required');
  deployHookScripts(path.join(codebuddyDir(home), 'hooks'), srcDir, stateFile, CODEBUDDY_HOOK_SET);
  const dest = notifyDest(home);
  const settings = readSettings(home);
  const hooks: Hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const before = JSON.stringify(hooks);
  for (const e of HOOK_EVENTS) addHook(hooks, e, dest); // add only MISSING events
  const changed = JSON.stringify(hooks) !== before;
  if (changed) writeJsonAtomic(settingsPath(home), { ...settings, hooks });
  return { status: 'installed', changed };
}

// Uninstall: strip our hooks from settings.json and remove the copied scripts/env. Best-effort on the file
// deletes (a missing file is fine). Leaves ~/.codebuddy and the user's own hooks intact.
export function uninstallHooks(home: string = homedir()): { status: 'absent' } {
  const settings = readSettings(home);
  if (fs.existsSync(settingsPath(home))) writeJsonAtomic(settingsPath(home), stripHooks(settings));
  removeHookScripts(path.join(codebuddyDir(home), 'hooks'), CODEBUDDY_HOOK_SET);
  return { status: 'absent' };
}
