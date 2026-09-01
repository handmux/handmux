// The single built-in Agent registry. Runtime consumes the root AgentAdapter contract; legacy
// orphan/transcript code sees a filtered projection of the same objects until those services migrate.
import { claude } from './claude.js';
import { codex } from './codex.js';
import { piAgentAdapter } from './pi.js';
import { validateAgentAdapters } from '../agent-runtime/adapter.js';
import type { AgentAdapter } from '../agent-runtime/adapter.js';

export interface AgentDriver extends AgentAdapter {
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

export const BUILTIN_AGENT_ADAPTERS: readonly AgentAdapter[] = [claude, codex, piAgentAdapter];

export const BUILTIN_AGENT_ADAPTER_VALIDATION = validateAgentAdapters(BUILTIN_AGENT_ADAPTERS);

function isLegacyDriver(adapter: AgentAdapter): adapter is AgentDriver {
  const candidate = adapter as Partial<AgentDriver>;
  return typeof candidate.procName === 'string'
    && Array.isArray(candidate.procNames)
    && candidate.procMatch instanceof RegExp
    && typeof candidate.takeoverPrefix === 'string'
    && candidate.transcript !== undefined
    && candidate.sessions !== undefined;
}

// Compatibility projection only: it retains object identity and never becomes a second registry. Pi is
// intentionally absent until the old orphan/session pipeline can represent a process-only adapter.
export const AGENTS: readonly AgentDriver[] = BUILTIN_AGENT_ADAPTER_VALIDATION.available
  .filter(isLegacyDriver);

const BY_ID = new Map<string, AgentDriver>(AGENTS.map((agent) => [agent.id, agent]));
const ADAPTER_BY_ID = new Map(BUILTIN_AGENT_ADAPTER_VALIDATION.available
  .map((adapter) => [adapter.id, adapter] as const));

export function getAgentAdapter(id: unknown): AgentAdapter | null {
  return typeof id === 'string' ? ADAPTER_BY_ID.get(id) ?? null : null;
}

// Resolve only an explicitly registered legacy driver. Historical format defaults belong at the reader
// boundary that owns that format; treating an explicit unknown id as Claude would create false identity.
export function getAgent(id: unknown): AgentDriver | null {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null;
}

// The driver whose foreground process this tmux #{pane_current_command} is, or null. Used by the inbox to
// decide a recorded pane is still running its agent (vs. the agent having exited to a shell). Matches the
// canonical procName only — never the ambiguous extras in procNames (e.g. Codex's 'node'); native-install
// Claude binaries (comm = version string) are normalized to 'claude' at ingest (resolveVersionedComms).
export function agentForProc(cmd: unknown): AgentDriver | null {
  return AGENTS.find((agent) => agent.procName === cmd) || null;
}
