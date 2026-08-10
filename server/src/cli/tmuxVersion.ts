// handmux's terminal rendering depends on `capture-pane -e -N` semantics, and those have drifted
// across tmux versions before (e.g. how -N pads trailing whitespace). So we check the host's tmux at
// start: absent → hard error; below the version we've validated → warn (don't block). exec injectable.
import { spawnSync } from 'node:child_process';

// Lowest tmux handmux has been validated against. Bump as the CI matrix (see release plan) widens.
export const MIN_TMUX = '3.0';

export interface TmuxVersion {
  major: number;
  minor: number;
  suffix: string;
  raw: string;
}

interface CommandResult {
  status: number | null;
  stdout?: string | Buffer | null;
}
type ExecCommand = (command: string, args: string[], options: object) => CommandResult;

// "tmux 3.6a" / "tmux 3.4" / "tmux next-3.5" / "tmux openbsd-7.4" → {major,minor,suffix,raw}.
export function parseTmuxVersion(out: unknown): TmuxVersion | null {
  const m = /tmux\s+(?:next-|openbsd-)?(\d+)\.(\d+)([a-z]?)/i.exec(String(out || ''));
  if (!m) return null;
  const major = Number(m[1] ?? 0);
  const minor = Number(m[2] ?? 0);
  const suffix = m[3] || '';
  return { major, minor, suffix, raw: `${major}.${minor}${suffix}` };
}

// v >= min, comparing major.minor only (patch letters don't change the capture behaviour we rely on).
export function versionAtLeast(v: TmuxVersion | null | undefined, minStr = MIN_TMUX): boolean {
  if (!v) return false;
  const [maj = 0, min = 0] = minStr.split('.').map(Number);
  return v.major > maj || (v.major === maj && v.minor >= min);
}

export type TmuxCheck = { present: false } | {
  present: true;
  version: TmuxVersion | null;
  ok: boolean;
  raw: string;
};

export function checkTmux(exec: ExecCommand = spawnSync): TmuxCheck {
  const r = exec('tmux', ['-V'], { encoding: 'utf8' });
  if (!r || r.status !== 0 || !r.stdout) return { present: false };
  const version = parseTmuxVersion(r.stdout);
  return { present: true, version, ok: versionAtLeast(version), raw: version ? version.raw : String(r.stdout).trim() };
}

// In install-command order: probe for the package manager that's actually on this Linux box.
const LINUX_PKG_MANAGERS: ReadonlyArray<readonly [string, string]> = [
  ['apt-get', 'sudo apt install tmux'],
  ['dnf', 'sudo dnf install tmux'],
  ['pacman', 'sudo pacman -S tmux'],
  ['zypper', 'sudo zypper install tmux'],
  ['apk', 'sudo apk add tmux'],
  ['yum', 'sudo yum install tmux'],
];

// The exact "install tmux" command for THIS host, so a tmux-less newcomer gets a copy-paste line instead
// of a dead end. macOS → Homebrew; Linux → whichever package manager is present; Windows → tmux is a
// Unix tool, so point at WSL. exec/platform injectable for tests.
export function tmuxInstallHint(exec: ExecCommand = spawnSync, platform: string = process.platform): string {
  if (platform === 'darwin') return 'brew install tmux';
  if (platform === 'win32') return 'tmux is a Unix tool — install WSL (`wsl --install`), then inside it: sudo apt install tmux';
  const has = (bin: string): boolean => exec('which', [bin], { encoding: 'utf8' }).status === 0;
  for (const [bin, cmd] of LINUX_PKG_MANAGERS) if (has(bin)) return cmd;
  return 'install tmux with your package manager (e.g. `sudo apt install tmux`)';
}
