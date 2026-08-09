// Install/uninstall the handmux Claude statusLine — the capturer that snapshots the 5h/weekly rate-limit %
// (from Claude Code's statusLine stdin, the only documented local source) to ~/.handmux/claude-usage.json
// for the phone's Usage page. Opt-in, and NON-DESTRUCTIVE by design: Claude allows exactly one statusLine,
// so if the user already has their OWN we NEVER clobber it — we report 'foreign' and the CLI prints a
// one-line compose snippet instead. We only ever write settings.statusLine when it's absent or already ours.
//
// Iron rule (same as claudeHooks): only ever touch ~/.handmux/ and — after opt-in — ~/.claude/. Never
// create ~/.claude.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { writeJsonAtomic } from './hookScaffold.js';

const STATUS_MARK = 'handmux-statusline.cjs'; // identifies our statusLine command among the user's own
const SCRIPT = 'handmux-statusline.cjs';

type JsonRecord = Record<string, unknown>;
export type StatusLineState = 'no-claude' | 'ours' | 'foreign' | 'absent';

interface InstallStatusLineOptions {
  srcDir?: string;
  usageFile?: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function claudeDir(home: string = homedir()): string { return path.join(home, '.claude'); }
function settingsPath(home: string = homedir()): string { return path.join(claudeDir(home), 'settings.json'); }

function readSettings(home: string): JsonRecord {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

function isOurs(statusLine: unknown): boolean {
  return isRecord(statusLine)
    && typeof statusLine.command === 'string'
    && statusLine.command.includes(STATUS_MARK);
}

// 'no-claude' → ~/.claude absent. 'ours' → our statusLine is installed. 'foreign' → the user has their own
// statusLine (we must not touch it). 'absent' → Claude Code is here but no statusLine configured.
export function statusLineStatus(home: string = homedir()): StatusLineState {
  if (!fs.existsSync(claudeDir(home))) return 'no-claude';
  const sl = readSettings(home).statusLine;
  if (isOurs(sl)) return 'ours';
  if (isRecord(sl) && (sl.command || sl.type)) return 'foreign';
  return 'absent';
}

// The exact command a user with an EXISTING statusline appends to capture without changing their display:
// pipe their statusline's stdin through our capturer in TEE mode first. Returned so the CLI can print it.
export function composeHint(home: string = homedir(), { usageFile }: { usageFile?: string } = {}): string {
  const dest = path.join(claudeDir(home), 'hooks', SCRIPT);
  return `HANDMUX_STATUS_TEE=1 node ${dest} ${usageFile} | <your existing statusline>`;
}

// Install (opt-in): copy the capturer to ~/.claude/hooks/ and point settings.statusLine at it — but ONLY
// when it's safe (absent or already ours). A 'foreign' statusLine is left untouched. Returns { status }.
//   srcDir    = bundled hooks dir (server/hooks)
//   usageFile = ~/.handmux/claude-usage.json (the snapshot the server reads)
export function installStatusLine(
  home: string = homedir(),
  { srcDir, usageFile }: InstallStatusLineOptions = {},
): { status: 'no-claude' | 'foreign' | 'installed'; script?: string } {
  if (!fs.existsSync(claudeDir(home))) return { status: 'no-claude' };
  const status = statusLineStatus(home);
  if (!srcDir || !usageFile) throw new Error('statusLine srcDir and usageFile are required');
  // Always deploy the capturer script (it's ours, inert until invoked) so the compose one-liner works even
  // in the foreign case. Only the settings.statusLine write is gated on not clobbering the user's own.
  const hooksDir = path.join(claudeDir(home), 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const dest = path.join(hooksDir, SCRIPT);
  fs.copyFileSync(path.join(srcDir, SCRIPT), dest);
  if (status === 'foreign') return { status: 'foreign', script: dest }; // never touch their statusLine
  const settings = readSettings(home);
  settings.statusLine = { type: 'command', command: `node ${dest} ${usageFile}` };
  writeJsonAtomic(settingsPath(home), settings);
  return { status: 'installed' };
}

// Refresh the on-disk capturer script to the BUNDLED version without touching settings.statusLine — so an
// npm upgrade actually reaches a user who already opted in. Critically settings-safe: a user who composed us
// into their OWN statusline (the TEE form) still reads as 'ours' (the command contains our mark), and we must
// NOT rewrite their command to the bare form (that would drop their downstream renderer). So this only ever
// copies the script. No-op (returns false) when we're not installed. Idempotent; safe to call every start.
export function refreshStatusLineScript(
  home: string = homedir(),
  { srcDir }: Pick<InstallStatusLineOptions, 'srcDir'> = {},
): boolean {
  if (statusLineStatus(home) !== 'ours') return false;
  if (!srcDir) return false;
  try {
    const dest = path.join(claudeDir(home), 'hooks', SCRIPT);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcDir, SCRIPT), dest);
    return true;
  } catch { return false; }
}

// Uninstall: drop settings.statusLine only if it's ours, and remove the copied script. Leaves a foreign
// statusLine and everything else intact.
export function uninstallStatusLine(home: string = homedir()): { status: 'absent' } {
  const settings = readSettings(home);
  if (isOurs(settings.statusLine)) {
    delete settings.statusLine;
    if (fs.existsSync(settingsPath(home))) writeJsonAtomic(settingsPath(home), settings);
  }
  try { fs.unlinkSync(path.join(claudeDir(home), 'hooks', SCRIPT)); } catch { /* already gone */ }
  return { status: 'absent' };
}
