// CodeBuddy's pending interactions. Everything but the naming lives in the shared Hook-driven adapter
// (hookInteraction.ts), the shared parser (pendingPrompt.ts) and the shared choice sender
// (paneInput.sendPaneMenuChoice) — this file only says which provider it is.
//
// Its screens parse with the same contract as Claude's (a cursor-marked numbered option list, meta rows
// filtered out), and the permission gate marks its cursor with `>` rather than `❯`; `parsePendingPrompt`
// already accepts both, so nothing here parses anything of its own.
//
// Which KEY answers a menu depends on the screen, and was measured live on 2.156.0 one screen at a time:
//
//   question    ❯ 1. 红色 / 2. 蓝色 (+ 描述行)            digit IGNORED (the highlight does not budge)
//   review      ❯ 1. Submit answers / 2. Cancel           digit commits
//   permission   > 1. Yes / 2. Yes, and don't ask again…  digit commits (the tool really ran)
//                3. No, and tell CodeBuddy what to do…
//
// So question menus are walked and Entered; only the gate takes its digit.
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
