// Claude's pending interactions (a permission gate, an AskUserQuestion menu) read off the pane, with the
// mechanics in the shared Hook-driven adapter (hookInteraction.ts): Claude's screen contract, the option
// digit as the choice key, and the same degradation policy. Only the naming is Claude's.
//
// Screen shapes and the digit-driving behaviour are documented in pendingPrompt.ts (verified live).
import type { AgentInteractionAdapterV1 } from '../agent-runtime/interactionTypes.js';
import { createHookInteractionAdapter } from './hookInteraction.js';
import type { HookInteractionControl } from './hookInteraction.js';

export type ClaudeInteractionControl = HookInteractionControl;

export function createClaudeInteractionAdapter(
  control: ClaudeInteractionControl,
  pollMs = 750,
  reportHealth: (availability: 'ready' | 'degraded', message?: string) => void = () => {},
): AgentInteractionAdapterV1 {
  return createHookInteractionAdapter(control, { id: 'claude', label: 'Claude' }, pollMs, reportHealth);
}
