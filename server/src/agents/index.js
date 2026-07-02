// The agent registry: the one place that lists which coding agents handmux drives. Adding a third agent is a
// new driver module (see claude.js / codex.js) plus one line here — the inbox pipeline (claudeEvents.js),
// the orphan/takeover engine (orphans.js), and the hook installers all consume drivers through this list,
// so none of them hard-codes an agent name.
import { claude } from './claude.js';
import { codex } from './codex.js';

// Order matters for proc matching (parseAgentProcs takes the first match) — keep the patterns disjoint so
// order is irrelevant in practice, but list the flagship first.
export const AGENTS = [claude, codex];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

// Resolve a driver by id. State-file entries written before agents existed carry no `agent` field, and the
// only writer then was Claude — so an unknown/missing id defaults to Claude (back-compat, never undefined).
export function getAgent(id) { return BY_ID.get(id) || claude; }

// The driver whose foreground process this tmux #{pane_current_command} is, or null. Used by the inbox to
// decide a recorded pane is still running its agent (vs. the agent having exited to a shell).
export function agentForProc(cmd) { return AGENTS.find((a) => a.procName === cmd) || null; }
