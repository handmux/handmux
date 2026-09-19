// The CodeBuddy Code agent adapter. Everything here is what Handmux knows that is SPECIFIC to CodeBuddy;
// the shared engine consumes this descriptor like any other provider.
//
// CodeBuddy is npm-first. `codebuddy`, `codebuddy-code` and `cbc` are symlinks onto one bin/codebuddy entry,
// so tmux only reports a stable name for the native build. In the documented npm layout the CLI runs INSIDE
// a Node process (`node /usr/local/bin/codebuddy` — verified live on 2.154.0), which makes three of the usual
// identity routes unusable:
//   - `#{pane_current_command}` is a bare "node", so no exact command can ever own the pane;
//   - the process's real executable (lsof/proc) is the Node binary, so executable-backed proof — the Claude
//     and Codex route — cannot name CodeBuddy;
//   - the Agent never spawns a native child binary, so the single-leaf foreground view, which deliberately
//     prefers a non-launcher descendant for ambiguous launchers, can hand back a transient tool child
//     (an npm/ruby update check) instead of the Agent itself.
// Identity therefore comes from the pane's whole foreground group, matched at a path boundary against the
// published launch entry points. We only ever answer "yes" from positive evidence, and we stay inconclusive
// rather than negative when the group was not actually read.
import type { AgentAdapter } from '../agent-runtime/adapter.js';
import type { ForegroundProcessIdentity, LivePane, ProcessContext } from '../agent-runtime/adapter.js';

// The three entries the CodeBuddy CLI installs, plus the package that owns the npm layout.
const LAUNCH_NAMES = new Set(['codebuddy', 'codebuddy-code', 'cbc']);
const NPM_PACKAGE_MARKER = '/@tencent-ai/codebuddy-code/';
const NODE_PROGRAM_RE = /^(\S*\/)?node$/;

const basename = (value: string): string => value.split('/').at(-1) ?? '';

// Node's entry argument is the first non-flag token after the program. Nothing beyond it may be searched:
// the agent's own arguments (a prompt, a file path, a session id) are free to contain any word, and matching
// those would turn "some Node script that was passed the word codebuddy" into a false identity.
function nodeEntryArgument(rest: string): string {
  return rest.split(/\s+/).find((token) => token.length > 0 && !token.startsWith('-')) ?? '';
}

// Exported for the contract tests that freeze the accepted launch shapes.
export function isCodeBuddyCommandLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const segments = trimmed.split(/\s+/);
  const program = (segments[0] ?? '').replace(/^-/, '');
  // Native build: the launcher itself is the program token.
  if (LAUNCH_NAMES.has(basename(program))) return true;
  // npm / Node launcher: `node <entry> …`. The entry must carry one of the published names AND sit in a
  // recognised install layout — a bare `node codebuddy`, or an unrelated file that merely shares the name,
  // is not proof.
  if (!NODE_PROGRAM_RE.test(program)) return false;
  const entry = nodeEntryArgument(segments.slice(1).join(' '));
  if (!entry || !LAUNCH_NAMES.has(basename(entry))) return false;
  return entry.includes(NPM_PACKAGE_MARKER) || /(?:^|\/)(?:\.bin|bin)\//.test(entry);
}

// Returns the matched row rather than a bare `true`: that row is CodeBuddy's process, and the Runtime needs
// it as the lease anchor precisely because the pane's foreground leaf is NOT CodeBuddy. A row whose start time
// could not be resolved is still returned — the Runtime then declines to publish a lease until it can name a
// process generation, which is the same rule it applies to every other Agent.
export async function verifyCodeBuddyProcess(
  pane: LivePane,
  context: ProcessContext,
): Promise<boolean | ForegroundProcessIdentity> {
  const group = await context.inspectForegroundGroup?.(pane);
  // A host that cannot supply the group cannot confirm a CodeBuddy pane (the single-leaf view may return a
  // transient tool child), so CodeBuddy goes unidentified there. That is deliberately a plain `false` and not
  // a thrown error: an inconclusive verdict is contagious — resolveAgentIdentity downgrades the WHOLE pane to
  // `unknown` when any ambiguous candidate is unresolved, which would poison Codex/Pi on those hosts. Every
  // production host builds its ProcessContext from createLocalAgentProcessContext, which does supply the group.
  if (!group) return false;
  return group.find((entry) => isCodeBuddyCommandLine(entry.commandLine ?? '')) ?? false;
}

export const codebuddy: AgentAdapter = {
  adapterApiVersion: 1 as const,
  id: 'codebuddy',
  label: 'CodeBuddy',
  process: {
    commands: ['codebuddy', 'codebuddy-code', 'cbc'],
    ambiguousCommands: ['node'],
    // Process presence alone establishes the sessionless run. Beyond being the base every later capability
    // builds on, this is what puts CodeBuddy on the pane roster the phone reads: the per-window Agent badge
    // for windows you are NOT looking at comes from the Runtime's active runs (`/states`), not from pane
    // identity — the pane you have selected is the only one resolved by `identifyPanes`.
    runtimeAttach: true as const,
    verify: verifyCodeBuddyProcess,
  },
  presentation: { iconId: 'codebuddy' },
  // Only what is actually implemented. Inbox/Conversation/Interaction are added as each one lands.
  capabilities: {},
};
