// The agent registry: the one place that lists which coding agents handmux drives. Adding a third agent is a
// new driver module (see claude.js / codex.js) plus one line here — the inbox pipeline and orphan/takeover
// engine consume drivers through this list, so process and session behavior stays centralized.
import { claude } from './claude.js';
import { codex } from './codex.js';

export interface AgentDriver {
  id: string;
  label: string;
  procName: string;
  procNames: string[];
  procMatch: RegExp;
  takeoverPrefix: string;
  classify?: (source: unknown, body?: unknown) => unknown;
  transcript: {
    createParser(): { messages: unknown[]; push(lines: readonly unknown[]): unknown[] };
    parse(lines: readonly unknown[]): unknown[];
  };
  sessions: {
    isId(value: unknown): boolean;
    dirOptKey: string;
    dir(home?: string): string;
    resolve(dir: string, cwd: string, options?: Record<string, unknown>): Promise<{
      sessionId?: string;
      state?: 'busy' | 'idle';
      snippet?: string;
      lastActivity?: number;
      file?: string;
    }>;
    resumeArgs(id: string): string[];
    resumeCmd(id: string): string;
    managedResumeCmd?(id: string): string;
  };
}

// Order matters for proc matching (parseAgentProcs takes the first match) — keep the patterns disjoint so
// order is irrelevant in practice, but list the flagship first.
export const AGENTS: readonly AgentDriver[] = [claude, codex];

const BY_ID = new Map<string, AgentDriver>(AGENTS.map((agent) => [agent.id, agent]));

// Resolve a driver by id. State-file entries written before agents existed carry no `agent` field, and the
// only writer then was Claude — so an unknown/missing id defaults to Claude (back-compat, never undefined).
export function getAgent(id: unknown): AgentDriver {
  return typeof id === 'string' ? BY_ID.get(id) || claude : claude;
}

// The driver whose foreground process this tmux #{pane_current_command} is, or null. Used by the inbox to
// decide a recorded pane is still running its agent (vs. the agent having exited to a shell). Matches the
// canonical procName only — never the ambiguous extras in procNames (e.g. Codex's 'node'); native-install
// Claude binaries (comm = version string) are normalized to 'claude' at ingest (resolveVersionedComms).
export function agentForProc(cmd: unknown): AgentDriver | null {
  return AGENTS.find((agent) => agent.procName === cmd) || null;
}
