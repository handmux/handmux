// The CodeBuddy Code Inbox Connector. Pipeline mechanics live in the generic Hook Bridge Connector
// (connectors/hookBridge.ts); this module is the CodeBuddy profile — the product facts only CodeBuddy can
// answer. It is deliberately thin: CodeBuddy drives the same file Hooks and the same shared writer as
// Claude, so the only CodeBuddy-specific pieces are the record marking, the pane-process anchor, and the
// `src`+payload classification (src/codebuddyEvents.ts).
import { acceptsCodeBuddyAgent, classifyCodeBuddy } from '../../src/codebuddyEvents.js';
import { isCodeBuddyCommandLine, verifyCodeBuddyProcess } from '../../src/agents/codebuddy.js';
import { CodeBuddyNativeTailReader } from '../../src/agents/codebuddyNativeTail.js';
import { HookBridgeConnector, projectHookInbox } from '../hookBridge.js';
import type {
  HookBridgeConnectorOptions,
  HookBridgeNativeTail,
  HookBridgeProjectionInput,
  HookInboxProjection,
} from '../hookBridge.js';
import type {
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
} from '../../src/agent-runtime/adapter.js';

// The marking rule and its reasoning live in src/codebuddyEvents.ts — the conversation lens's pane binding
// has to answer it identically, so there is exactly one definition rather than two that can drift.
export { acceptsCodeBuddyAgent };

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

// The out-of-band reconciler. Claude's exists to close gates no Hook closes (ESC interrupts, no-op
// /compact, resolved permission prompts) by reading the session transcript; CodeBuddy's does the narrower
// job its own gaps require — a permission gate the user has answered never gets a Hook, so the granted
// tool's result record is the only proof the pane moved on. See src/agents/codebuddyNativeTail.ts.
export type CodeBuddyHookBridgeConnectorOptions = Omit<HookBridgeConnectorOptions, 'profile'> & {
  nativeTail?: HookBridgeNativeTail;
};

export class CodeBuddyHookBridgeConnector extends HookBridgeConnector {
  constructor({
    nativeTail = new CodeBuddyNativeTailReader(),
    ...options
  }: CodeBuddyHookBridgeConnectorOptions) {
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
        nativeTail,
      },
    });
  }
}
