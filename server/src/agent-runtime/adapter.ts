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
  // Some native installers expose a versioned tmux command instead of a stable binary name. This
  // predicate may only nominate a command for the same executable-backed verification used below;
  // it can never identify an Agent by itself.
  ambiguousCommand?(command: string): boolean;
  verify?(pane: LivePane, context: ProcessContext): Promise<boolean>;
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
  | { kind: 'matched'; adapter: AgentAdapter }
  | { kind: 'none' }
  | { kind: 'unknown'; candidateIds: string[] }
  | { kind: 'conflict'; candidateIds: string[] };

type VerificationResult = 'verified' | 'rejected' | 'unknown';

async function verifiedWithin(
  adapter: AgentAdapter,
  pane: LivePane,
  context: ProcessContext,
  timeoutMs: number,
): Promise<VerificationResult> {
  if (!adapter.process.verify) return 'rejected';
  let timer: NodeJS.Timeout | undefined;
  try {
    const verification = Promise.resolve()
      .then(() => adapter.process.verify!(pane, context))
      .then(
        (value): VerificationResult => value ? 'verified' : 'rejected',
        (): VerificationResult => 'unknown',
      );
    return await Promise.race([
      verification,
      new Promise<VerificationResult>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs);
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
  const matched = verdicts.filter((verdict) => verdict.result === 'verified')
    .map((verdict) => verdict.adapter);
  if (matched.length > 1) {
    return { kind: 'conflict', candidateIds: matched.map((adapter) => adapter.id).sort() };
  }
  const unknown = [
    ...predicateFailures,
    ...verdicts.filter((verdict) => verdict.result === 'unknown').map((verdict) => verdict.adapter.id),
  ];
  if (unknown.length) {
    return {
      kind: 'unknown',
      candidateIds: [...new Set([...matched.map((adapter) => adapter.id), ...unknown])].sort(),
    };
  }
  if (matched.length === 1) return { kind: 'matched', adapter: matched[0]! };
  return { kind: 'none' };
}
