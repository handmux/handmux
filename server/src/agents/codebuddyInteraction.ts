// CodeBuddy's pending interactions, with the mechanics in the shared Hook-driven adapter
// (hookInteraction.ts). Same contract as Claude's — the same cursor-marked numbered option list, the same
// option DIGIT as the choice key — verified live on 2.156.0:
//
//   question    ❯ 1. 红色 / 2. 蓝色 (+ 描述行)               sending 1 selects and advances
//   review      ❯ 1. Submit answers / 2. Cancel              sending 1 submits
//   permission   > 1. Yes / 2. Yes, and don't ask again…     sending 1 ran the tool (the file appeared)
//                3. No, and tell CodeBuddy what to do…
//
// The permission gate marks its cursor with `>` rather than `❯`; `parsePendingPrompt` already accepts both,
// so nothing here parses anything of its own.
import type { AgentInteractionAdapterV1 } from '../agent-runtime/interactionTypes.js';
import { createHookInteractionAdapter } from './hookInteraction.js';
import type { HookInteractionControl } from './hookInteraction.js';

export type CodeBuddyInteractionControl = HookInteractionControl;

export function createCodeBuddyInteractionAdapter(
  control: CodeBuddyInteractionControl,
  pollMs = 750,
  reportHealth: (availability: 'ready' | 'degraded', message?: string) => void = () => {},
): AgentInteractionAdapterV1 {
  return createHookInteractionAdapter(control, { id: 'codebuddy', label: 'CodeBuddy' }, pollMs, reportHealth);
}
