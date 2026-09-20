// The CodeBuddy Code Inbox Connector. Pipeline mechanics live in the generic Hook Bridge Connector
// (connectors/hookBridge.ts); this module is the CodeBuddy profile — the product facts only CodeBuddy can
// answer. It is deliberately thin: CodeBuddy drives the same file Hooks and the same shared writer as
// Claude, so the only CodeBuddy-specific pieces are the record marking, the pane-process anchor, and the
// `src`+payload classification (src/codebuddyEvents.ts).
import { classifyCodeBuddy } from '../../src/codebuddyEvents.js';
import { isCodeBuddyCommandLine, verifyCodeBuddyProcess } from '../../src/agents/codebuddy.js';
import { HookBridgeConnector, projectHookInbox } from '../hookBridge.js';
import type {
  HookBridgeConnectorOptions,
  HookBridgeProjectionInput,
  HookInboxProjection,
} from '../hookBridge.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
} from '../../src/agent-runtime/adapter.js';

// Which record markings this Connector may read. It only ever reads CodeBuddy's OWN state file and spool
// directory, so the mark is provenance rather than routing — but the writer is a SHARED script that stamps
// its own literal on every Agent's spool (today: the Claude one), so both the agent id CodeBuddy will carry
// once the writer is parameterized and that literal must be admitted. An explicit foreign provider still
// fails closed: a leftover row in this directory must never be projected as CodeBuddy state.
// Exported for the contract tests that freeze which record marks this Connector may read.
export function acceptsCodeBuddyAgent(agent: unknown): boolean {
  return agent === 'codebuddy';
}

export function projectCodeBuddyHookInbox(input: HookBridgeProjectionInput): HookInboxProjection {
  return projectHookInbox({ classify: classifyCodeBuddy, ...input });
}

// CodeBuddy is never the pane's foreground LEAF: it runs inside a Node launcher whose group also carries
// transient tool children (npm/ruby update checks), and the single-leaf view prefers such a child. The Hook
// shell records the owning CodeBuddy process, and Runtime anchors the lease on that very row — so the
// Connector must resolve identity exactly like the adapter verifies it. Comparing the recorded fingerprint
// (or publishing a candidate) against the leaf instead would never match, and the whole chain would drop
// every event.
async function resolveCodeBuddyPaneProcess(
  pane: LivePane,
  context: ProcessContext,
): Promise<ForegroundProcessIdentity | null> {
  const verified = await verifyCodeBuddyProcess(pane, context);
  return verified && typeof verified === 'object' ? verified : null;
}

// Only reached for a record with NO process fingerprint (an older writer). The resolved anchor is already
// proven CodeBuddy, so this just re-states that in command-line terms.
function looksLikeCodeBuddy(pane: LivePane, foreground: ForegroundProcessIdentity): boolean {
  return isCodeBuddyCommandLine(foreground.commandLine ?? '')
    || isCodeBuddyCommandLine(pane.currentCommand);
}

// CodeBuddy fires NO Hook when the user answers a PermissionRequest, so a granted tool leaves the pane
// latched at 需要你 until whatever Hook comes next — for a tool outside the PostToolUse matcher, that is the
// turn's end. Its prompt is a Claude-shaped chooser drawn in the pane, so the SCREEN is the only proof the
// user answered, and the generic Connector asks this one question about it: is the prompt still there?
//
// The signature is the chooser's own shape — the `Enter to select · …` footer under a numbered option
// list — rather than any particular wording, so a reworded question keeps matching. Observed live on
// 2.155.0, both shapes in use: the permission gate
//     `Do you want to proceed?` / `> 1. Yes` / `2. Yes, and don't ask again for session (shift + tab)` /
//     `3. No, and tell CodeBuddy what to do differently (escape)` / `Enter to select · Tab/Arrow keys…`
// and the AskUserQuestion picker
//     `请选择一个选项：` / `❯ 1. 选项 A` / `Enter to select · ↑/↓ to navigate · Esc to cancel`
//
// A screen this cannot recognize (an older/newer shape, a clipped dialog) only means the Connector keeps
// waiting for a Hook, so the check can close a gate but never open one on its own.
export function codeBuddyBlockingPromptVisible(screen: string): boolean {
  return /Enter to select/.test(screen) && /^\s*(?:[>❯])?\s*\d+\.\s+\S/m.test(screen);
}

// No nativeTail: Claude's transcript/registry reconciler exists to close gates no Hook closes (ESC
// interrupts, no-op /compact, resolved permission prompts) by reading the session transcript. CodeBuddy has
// no equivalent reader in this slice, and inventing a weaker one would report unverified state — the
// Connector therefore trusts the Hook edges alone, and a missing closing edge is handled by the shared
// Inbox/lease lifecycle rather than guessed at.
export type CodeBuddyHookBridgeConnectorOptions = Omit<HookBridgeConnectorOptions, 'profile'>;

export class CodeBuddyHookBridgeConnector extends HookBridgeConnector {
  constructor(options: CodeBuddyHookBridgeConnectorOptions) {
    super({
      ...options,
      profile: {
        agentId: 'codebuddy',
        label: 'CodeBuddy',
        attachmentPrefix: 'codebuddy-hook',
        eventPrefix: 'codebuddy-hook',
        acceptsAgent: acceptsCodeBuddyAgent,
        matchesAgentPane: looksLikeCodeBuddy,
        project: projectCodeBuddyHookInbox,
        resolvePaneProcess: resolveCodeBuddyPaneProcess,
        // No Hook closes a permission gate, and CodeBuddy keeps no status file to read it from (its live
        // state lives in its own Centrifugo channel), so the pane's screen is the one source: see
        // codeBuddyBlockingPromptVisible.
        blockingPromptVisible: codeBuddyBlockingPromptVisible,
      },
    });
  }
}
