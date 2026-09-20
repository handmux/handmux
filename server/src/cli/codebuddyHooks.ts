// Install/uninstall the CodeBuddy Code lifecycle hooks that feed the handmux inbox. Structurally this is
// claudeHooks.ts again — CodeBuddy's hooks follow the Claude Code settings schema — but it is a separate
// module on purpose: it writes another tool's config in another tool's directory, so it owns its own marker,
// its own settings file and its own script set. One installer must never edit two products' configs.
//
// Iron rule: only ever touch ~/.handmux/ and — after explicit opt-in — ~/.codebuddy/. If ~/.codebuddy is
// absent (no CodeBuddy), skip and report 'no-codebuddy'; never create it.
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
}
export interface CodeBuddyHookInstallOptions {
  srcDir?: string;
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
];

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
    && group.matcher === ''
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
    matcher: '',
    hooks: [{ type: 'command', command: `${shellWord(dest)} ${e.src}`, async: true, timeout: 5 }],
  });
}

// Pure: return a NEW settings object with our five hooks merged into settings.hooks, idempotently, leaving
// the user's own hooks and other keys untouched. `dest` is the absolute path to the copied notify script.
export function mergeHooks(settings: unknown, dest: string): Settings {
  const s = settingsOf(settings);
  const hooks: Hooks = isRecord(s.hooks) ? { ...s.hooks } : {};
  for (const e of HOOK_EVENTS) addHook(hooks, e, dest);
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
// file, and merge our five hooks into settings.json. NEVER creates ~/.codebuddy — if it's absent the user
// doesn't run CodeBuddy, so we report 'no-codebuddy' and do nothing.
//   srcDir    = the bundled hooks dir (server/hooks)
//   stateFile = the unified ~/.handmux/codebuddy-state.json path the hook writes and the server reads
export function installHooks(
  home: string = homedir(),
  { srcDir, stateFile }: CodeBuddyHookInstallOptions = {},
): { status: 'no-codebuddy' | 'installed' } {
  if (!fs.existsSync(codebuddyDir(home))) return { status: 'no-codebuddy' };
  if (!srcDir || !stateFile) throw new Error('hook srcDir and stateFile are required');
  deployHookScripts(path.join(codebuddyDir(home), 'hooks'), srcDir, stateFile, CODEBUDDY_HOOK_SET);
  const settings = readSettings(home);
  writeJsonAtomic(settingsPath(home), mergeHooks(settings, notifyDest(home)));
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
