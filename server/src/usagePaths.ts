import path from 'node:path';
import { homedir } from 'node:os';
import { pocketHome } from './cli/state.js';

export function claudeUsagePath(home: string = homedir()): string {
  return path.join(pocketHome(home), 'claude-usage.json');
}

export function claudeContextDir(home: string = homedir()): string {
  return path.join(pocketHome(home), 'context');
}

export function codexUsagePath(home: string = homedir()): string {
  return path.join(pocketHome(home), 'codex-usage.json');
}

export function codexSessionsDir(home: string = homedir()): string {
  return path.join(home, '.codex', 'sessions');
}
