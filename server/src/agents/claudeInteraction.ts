// Claude's pending interactions (a permission gate, an AskUserQuestion menu) read off the pane. Everything
// but the naming lives in the shared Hook-driven adapter (hookInteraction.ts), the shared parser
// (pendingPrompt.ts) and the shared choice sender (paneInput.sendPaneMenuChoice) — this file only says which
// provider it is.
//
// Which KEY answers a menu depends on the screen, not on the provider: for Claude's question menu a digit
// only moves the highlight (its bundle's `1`-`9` branch calls the same move function as ↑/↓, while only
// `return` commits), so the sender walks the cursor and presses Enter there, and uses the digit on a
// permission gate, where it commits.
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
