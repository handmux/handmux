import type { LocalAgentBridgeHost } from './bridgeTypes.js';
import type { AgentResourceRegistry } from './resourceTypes.js';
import type { AgentRunRegistry, ScopedAgentRunController } from './run.js';

export interface AgentPresentation {
  // Trusted static asset id only. The web bundle decides whether this id exists.
  iconId?: string;
}

export interface LivePane {
  paneId: string;
  sessionName: string;
  windowId: string;
  windowName: string;
  currentCommand: string;
  tty?: string;
  foregroundPid?: number;
}

export interface ForegroundProcessIdentity {
  pid: number;
  // Parent pid, when the probe provides the process tree. Only the group variant below fills it; it lets a
  // verifier reason about which candidate is the ancestor of the others instead of trusting row order.
  ppid?: number;
  startedAt?: number;
  tty?: string;
  executable?: string;
  // Best-effort process title/command line from ps. Adapters must match a narrow provider-owned entrypoint;
  // this is evidence for ambiguous launchers such as node, never a shell command to execute.
  commandLine?: string;
  argv?: string[];
}

export interface ProcessContext {
  inspectForeground(pane: LivePane): Promise<ForegroundProcessIdentity | null>;
  // Every process in the pane tty's foreground group, as evidence for adapters whose Agent runs INSIDE an
  // ambiguous launcher rather than as a native-binary descendant (e.g. a Node CLI that never spawns a child
  // binary). inspectForeground deliberately prefers a non-launcher descendant for such panes, so those
  // adapters would otherwise see a transient tool child and lose their own process. Entries carry the group's
  // command lines and parent links but no per-pid executable/start-time resolution, so this stays one `ps`
  // read. Optional: a runtime without it leaves such adapters degrading to `unknown` instead of guessing.
  inspectForegroundGroup?(pane: LivePane): Promise<readonly ForegroundProcessIdentity[]>;
  // One known process, by pid. This is the cheap "is this still the same process generation?" probe a lease
  // needs on every tick: only the fields a generation check uses are resolved (never the executable, whose
  // lsof costs ~70ms on a Node process). Null means the probe could not confirm that process — callers must
  // treat it as inconclusive, not as proof the process exited.
  inspectProcess?(pid: number): Promise<ForegroundProcessIdentity | null>;
}

export interface ReadonlyPaneSource {
  list(): Promise<readonly LivePane[]>;
  subscribe(listener: (snapshot: readonly LivePane[]) => void): () => void;
}

export type AdapterJsonValue =
  | null | boolean | number | string
  | AdapterJsonValue[]
  | { [key: string]: AdapterJsonValue };

export interface AdapterLogger {
  debug(message: string, fields?: Record<string, AdapterJsonValue>): void;
  info(message: string, fields?: Record<string, AdapterJsonValue>): void;
  warn(message: string, fields?: Record<string, AdapterJsonValue>): void;
  error(message: string, fields?: Record<string, AdapterJsonValue>): void;
}

export type AdapterAvailability = 'ready' | 'degraded' | 'unavailable';

export interface AdapterHealthReporter {
  report(update: {
    capability?: string;
    availability: AdapterAvailability;
    message?: string;
    lastSuccessAt?: number;
  }): void;
}

export interface AgentAdapterContext {
  runs: AgentRunRegistry;
  runControl: ScopedAgentRunController;
  panes: ReadonlyPaneSource;
  bridge: LocalAgentBridgeHost;
  resources: AgentResourceRegistry;
  logger: AdapterLogger;
  health: AdapterHealthReporter;
  options: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface AgentProcessIdentity {
  commands: readonly string[];
  ambiguousCommands?: readonly string[];
  // Process presence itself can establish a sessionless root run. Provider sources may associate a
  // session later, but must not create a competing attachment.
  runtimeAttach?: true;
  // Some native installers expose a versioned tmux command instead of a stable binary name. This
  // predicate may only nominate a command for the same executable-backed verification used below;
  // it can never identify an Agent by itself.
  ambiguousCommand?(command: string): boolean;
  // `true` — verified; the pane's foreground leaf is the Agent, as for every Agent that appears as its own
  // process (Claude, Codex, Pi). An identity — verified, AND this is the Agent's process, which then becomes
  // the anchor for attachment and every later recheck. Return the identity only when the Agent is NOT the
  // foreground leaf (e.g. it runs inside an ambiguous launcher and never spawns a native child binary); it
  // must be the very process the verifier just proved, because the lease is tied to exactly that pid.
  verify?(pane: LivePane, context: ProcessContext): Promise<boolean | ForegroundProcessIdentity>;
}

export interface VersionedCapabilityAdapter {
  apiVersion: 1;
}

export interface ConversationCapabilityAdapter extends VersionedCapabilityAdapter {
  experimental?: boolean;
}

export interface AgentAdapter {
  adapterApiVersion: 1;
  id: string;
  label: string;
  presentation?: AgentPresentation;
  process: AgentProcessIdentity;
  activate?(context: AgentAdapterContext): Promise<void | (() => void)>;
  capabilities: {
    inbox?: VersionedCapabilityAdapter;
    conversation?: ConversationCapabilityAdapter;
    conversationActivation?: VersionedCapabilityAdapter;
    conversationGoal?: VersionedCapabilityAdapter;
    conversationPlan?: VersionedCapabilityAdapter;
    conversationContext?: VersionedCapabilityAdapter;
    conversationPermission?: VersionedCapabilityAdapter;
    conversationCommands?: VersionedCapabilityAdapter;
    interaction?: VersionedCapabilityAdapter;
    sessionControl?: VersionedCapabilityAdapter;
    subscriptionUsage?: VersionedCapabilityAdapter;
  };
}

export type AgentAdapterIssueCode =
  | 'invalid-adapter'
  | 'duplicate-id'
  | 'duplicate-command'
  | 'ambiguous-exact-conflict';

export interface AgentAdapterIssue {
  code: AgentAdapterIssueCode;
  message: string;
  adapterIds: string[];
  command?: string;
}

export interface ValidatedAgentAdapters {
  available: readonly AgentAdapter[];
  issues: readonly AgentAdapterIssue[];
}

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function validCapabilities(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'inbox', 'conversation', 'conversationActivation', 'conversationGoal', 'conversationPlan',
    'conversationContext', 'conversationPermission', 'conversationCommands', 'interaction', 'sessionControl',
    'subscriptionUsage',
  ]);
  for (const [key, capability] of Object.entries(value)) {
    if (!allowed.has(key) || !isRecord(capability) || capability.apiVersion !== 1) return false;
    if (key === 'conversation' && capability.experimental !== undefined
      && typeof capability.experimental !== 'boolean') return false;
    if (key !== 'conversation' && capability.experimental !== undefined) return false;
  }
  return true;
}

function validAdapter(value: unknown): value is AgentAdapter {
  if (!isRecord(value) || value.adapterApiVersion !== 1) return false;
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return false;
  if (typeof value.label !== 'string' || value.label.trim().length === 0) return false;
  if (value.presentation !== undefined) {
    if (!isRecord(value.presentation)) return false;
    if (value.presentation.iconId !== undefined
      && (typeof value.presentation.iconId !== 'string' || !ID_RE.test(value.presentation.iconId))) return false;
  }
  if (value.activate !== undefined && typeof value.activate !== 'function') return false;
  const process = value.process;
  if (!isRecord(process) || !validStringArray(process.commands)) return false;
  const commands = process.commands;
  if (process.ambiguousCommands !== undefined
    && !validStringArray(process.ambiguousCommands)) return false;
  if (Array.isArray(process.ambiguousCommands)
    && process.ambiguousCommands.some((command) => commands.includes(command))) return false;
  if (process.ambiguousCommand !== undefined && typeof process.ambiguousCommand !== 'function') return false;
  if (process.verify !== undefined && typeof process.verify !== 'function') return false;
  if (process.runtimeAttach !== undefined && process.runtimeAttach !== true) return false;
  if ((process.ambiguousCommands !== undefined || process.ambiguousCommand !== undefined)
    && typeof process.verify !== 'function') return false;
  return validCapabilities(value.capabilities);
}

function mapOwners(
  adapters: readonly AgentAdapter[],
  select: (adapter: AgentAdapter) => readonly string[] | undefined,
): Map<string, AgentAdapter[]> {
  const owners = new Map<string, AgentAdapter[]>();
  for (const adapter of adapters) {
    for (const command of select(adapter) ?? []) {
      const current = owners.get(command) ?? [];
      current.push(adapter);
      owners.set(command, current);
    }
  }
  return owners;
}

// Validate the complete static registry before any adapter is activated. Conflicting adapters all fail
// closed; array order never decides which adapter owns a process command.
export function validateAgentAdapters(values: readonly unknown[]): ValidatedAgentAdapters {
  const issues: AgentAdapterIssue[] = [];
  const valid: AgentAdapter[] = [];
  const unavailable = new Set<AgentAdapter>();

  for (const value of values) {
    if (validAdapter(value)) {
      valid.push(value);
      continue;
    }
    const declaredId = isRecord(value) && typeof value.id === 'string' ? value.id : '<unknown>';
    issues.push({
      code: 'invalid-adapter',
      adapterIds: [declaredId],
      message: `Invalid AgentAdapter contract: ${declaredId}`,
    });
  }

  const ids = mapOwners(valid, (adapter) => [adapter.id]);
  for (const [id, owners] of ids) {
    if (owners.length < 2) continue;
    owners.forEach((owner) => unavailable.add(owner));
    issues.push({
      code: 'duplicate-id',
      adapterIds: owners.map((owner) => owner.id),
      message: `Duplicate AgentAdapter id: ${id}`,
    });
  }

  const exact = mapOwners(valid, (adapter) => adapter.process.commands);
  for (const [command, owners] of exact) {
    if (owners.length < 2) continue;
    owners.forEach((owner) => unavailable.add(owner));
    issues.push({
      code: 'duplicate-command',
      adapterIds: owners.map((owner) => owner.id).sort(),
      command,
      message: `Exact Agent command has multiple owners: ${command}`,
    });
  }

  const ambiguous = mapOwners(valid, (adapter) => adapter.process.ambiguousCommands);
  for (const [command, ambiguousOwners] of ambiguous) {
    const exactOwners = exact.get(command) ?? [];
    const conflicting = [...new Set([...exactOwners, ...ambiguousOwners])];
    if (!exactOwners.length || conflicting.length < 2) continue;
    conflicting.forEach((owner) => unavailable.add(owner));
    issues.push({
      code: 'ambiguous-exact-conflict',
      adapterIds: conflicting.map((owner) => owner.id).sort(),
      command,
      message: `Ambiguous Agent command overlaps another adapter's exact command: ${command}`,
    });
  }

  return {
    available: valid.filter((adapter) => !unavailable.has(adapter)),
    issues,
  };
}

export type AgentIdentityResolution =
  | { kind: 'matched'; adapter: AgentAdapter; process?: ForegroundProcessIdentity }
  | { kind: 'none' }
  | { kind: 'unknown'; candidateIds: string[] }
  | { kind: 'conflict'; candidateIds: string[] };

interface VerificationOutcome {
  verdict: 'verified' | 'rejected' | 'unknown';
  process?: ForegroundProcessIdentity;
}

// A verifier may hand back its own process instead of a bare `true`. Only the evidence fields the anchor is
// built from are accepted, and a pid that cannot name a process generation (non-integer, non-positive) is
// rejected outright rather than trusted — a malformed identity must not become a lease anchor.
function resolvedProcess(value: unknown): ForegroundProcessIdentity | null {
  if (!isRecord(value)) return null;
  const { pid, ppid, startedAt, tty, executable, commandLine, argv } = value;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (ppid !== undefined && (!Number.isSafeInteger(ppid) || (ppid as number) < 0)) return null;
  if (startedAt !== undefined
    && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) return null;
  for (const field of [tty, executable, commandLine]) {
    if (field !== undefined && typeof field !== 'string') return null;
  }
  if (argv !== undefined && (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string'))) {
    return null;
  }
  return {
    pid: pid as number,
    ...(ppid === undefined ? {} : { ppid: ppid as number }),
    ...(startedAt === undefined ? {} : { startedAt: startedAt as number }),
    ...(tty === undefined ? {} : { tty: tty as string }),
    ...(executable === undefined ? {} : { executable: executable as string }),
    ...(commandLine === undefined ? {} : { commandLine: commandLine as string }),
    ...(argv === undefined ? {} : { argv: argv as string[] }),
  };
}

async function verifiedWithin(
  adapter: AgentAdapter,
  pane: LivePane,
  context: ProcessContext,
  timeoutMs: number,
): Promise<VerificationOutcome> {
  if (!adapter.process.verify) return { verdict: 'rejected' };
  let timer: NodeJS.Timeout | undefined;
  try {
    const verification = Promise.resolve()
      .then(() => adapter.process.verify!(pane, context))
      .then(
        (value): VerificationOutcome => {
          if (value === true) return { verdict: 'verified' };
          if (value === false) return { verdict: 'rejected' };
          const process = resolvedProcess(value);
          return process ? { verdict: 'verified', process } : { verdict: 'rejected' };
        },
        (): VerificationOutcome => ({ verdict: 'unknown' }),
      );
    return await Promise.race([
      verification,
      new Promise<VerificationOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ verdict: 'unknown' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Exact commands win without probing. Ambiguous commands are accepted only when exactly one verifier
// succeeds; multiple successes fail closed and surface a deterministic conflict diagnostic.
export async function resolveAgentIdentity(
  pane: LivePane,
  adapters: readonly AgentAdapter[],
  context: ProcessContext,
  { verifyTimeoutMs = 1000 }: { verifyTimeoutMs?: number } = {},
): Promise<AgentIdentityResolution> {
  const exact = adapters.filter((adapter) => adapter.process.commands.includes(pane.currentCommand));
  if (exact.length === 1) return { kind: 'matched', adapter: exact[0]! };
  if (exact.length > 1) {
    return { kind: 'conflict', candidateIds: exact.map((adapter) => adapter.id).sort() };
  }

  const predicateFailures: string[] = [];
  const candidates = adapters.filter((adapter) => {
    if (adapter.process.ambiguousCommands?.includes(pane.currentCommand)) return true;
    try { return adapter.process.ambiguousCommand?.(pane.currentCommand) === true; }
    catch {
      predicateFailures.push(adapter.id);
      return false;
    }
  });
  if (!candidates.length) {
    return predicateFailures.length
      ? { kind: 'unknown', candidateIds: predicateFailures.sort() }
      : { kind: 'none' };
  }

  const verdicts = await Promise.all(candidates.map(async (adapter) => ({
    adapter,
    result: await verifiedWithin(adapter, pane, context, Math.max(1, verifyTimeoutMs)),
  })));
  const matched = verdicts.filter((verdict) => verdict.result.verdict === 'verified');
  if (matched.length > 1) {
    return { kind: 'conflict', candidateIds: matched.map((verdict) => verdict.adapter.id).sort() };
  }
  const unknown = [
    ...predicateFailures,
    ...verdicts.filter((verdict) => verdict.result.verdict === 'unknown')
      .map((verdict) => verdict.adapter.id),
  ];
  if (unknown.length) {
    return {
      kind: 'unknown',
      candidateIds: [...new Set([...matched.map((verdict) => verdict.adapter.id), ...unknown])].sort(),
    };
  }
  const winner = matched[0];
  if (winner) {
    return {
      kind: 'matched',
      adapter: winner.adapter,
      ...(winner.result.process === undefined ? {} : { process: winner.result.process }),
    };
  }
  return { kind: 'none' };
}
