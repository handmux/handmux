// The Claude Code Inbox Connector. All pipeline mechanics live in the generic Hook Bridge Connector
// (connectors/hookBridge.ts); this module is the Claude PROFILE — the product facts only Claude can answer:
// which records carry its marking, how a pane proves it is still running Claude, how a `src`+payload maps
// to an Inbox state, and the out-of-band native Tail reconciliation Claude has and CodeBuddy does not.
import { classifyClaude } from '../../src/agents/claude.js';
import { ClaudeNativeTailReader } from '../../src/agents/claudeNativeTail.js';
import { HookBridgeConnector, projectHookInbox } from '../hookBridge.js';
import type {
  HookBridgeConnectorOptions,
  HookBridgeProjectionInput,
  HookInboxProjection,
} from '../hookBridge.js';
import type { ForegroundProcessIdentity, LivePane } from '../../src/agent-runtime/adapter.js';

// Claude's records are explicitly marked `agent: "claude"`; an ABSENT marking is the legacy Claude row from
// before the multi-Agent format (the reader admits it). Anything else fails closed at the Connector entrance.
function acceptsClaudeAgent(agent: unknown): boolean {
  return agent === 'claude';
}

// Project one Claude Hook edge. Kept as a named export because it is Claude's documented projection and is
// the only place the Claude classifier meets the shared Inbox operation shape.
export function projectClaudeHookInbox(input: HookBridgeProjectionInput): HookInboxProjection {
  return projectHookInbox({ classify: classifyClaude, ...input });
}

// tmux reports the native installer's version-named binary (e.g. "2_1_196"), and the value is normalized
// to 'claude' at ingest by resolveVersionedComms — so an exact single-name match is right here. A
// version-shaped command is corroborated through the process's REAL executable path.
function looksLikeClaude(pane: LivePane, foreground: ForegroundProcessIdentity): boolean {
  if (pane.currentCommand === 'claude') return true;
  if (!/^\d+[._]\d+[._]\d+$/.test(pane.currentCommand)) return false;
  return typeof foreground.executable === 'string' && /claude/.test(foreground.executable);
}

function claudeProfile(nativeTail: ClaudeNativeTailReader) {
  return {
    agentId: 'claude',
    label: 'Claude',
    attachmentPrefix: 'claude-hook',
    eventPrefix: 'claude-hook',
    acceptsAgent: acceptsClaudeAgent,
    matchesAgentPane: looksLikeClaude,
    project: projectClaudeHookInbox,
    nativeTail,
  };
}

export interface ClaudeHookBridgeConnectorOptions extends Omit<HookBridgeConnectorOptions, 'profile'> {
  nativeTail?: ClaudeNativeTailReader;
}

export class ClaudeHookBridgeConnector extends HookBridgeConnector {
  constructor({ nativeTail = new ClaudeNativeTailReader(), ...options }: ClaudeHookBridgeConnectorOptions) {
    super({ ...options, profile: claudeProfile(nativeTail) });
  }
}
