import { stat as statFile } from 'node:fs/promises';
import { parseCodexGoal } from '../codexStreamProtocol.js';
import { readLatestContextUsage } from '../codexUsageSnapshot.js';
import type { CodexContextUsage } from '../codexUsageSnapshot.js';
import { resolveCodexRollout, sessionsDir } from './codex.js';
import type {
  AgentConversationCommandControllerV1,
  AgentConversationContextControllerV1,
  AgentConversationGoalControllerV1,
  AgentConversationPlanControllerV1,
  AgentConversationPermissionControllerV1,
  ConversationContextSnapshot,
  ConversationPermissionSnapshot,
  ConversationPermissionMode,
} from '../agent-runtime/conversationControls.js';

type JsonRecord = Record<string, unknown>;

export interface CodexConversationControlApp {
  status(pane: string, threadId: string): Promise<unknown>;
  compact(pane: string, threadId: string): Promise<unknown>;
  getGoal(pane: string, threadId: string): Promise<unknown>;
  startGoal(pane: string, threadId: string, objective: string): Promise<unknown>;
  updateGoal(pane: string, threadId: string, updates: JsonRecord): Promise<unknown>;
  clearGoal(pane: string, threadId: string): Promise<unknown>;
  updateSettings(pane: string, threadId: string, updates: JsonRecord): Promise<unknown>;
}

export interface CodexConversationControls {
  goal: AgentConversationGoalControllerV1;
  plan: AgentConversationPlanControllerV1;
  context: AgentConversationContextControllerV1;
  permission: AgentConversationPermissionControllerV1;
  commands: AgentConversationCommandControllerV1;
}

interface CodexConversationControlOptions {
  sessionsRoot?: string;
  findRollout?: (root: string, threadId: string) => Promise<string | null>;
  reader?: (file: string) => CodexContextUsage | null | Promise<CodexContextUsage | null>;
  stat?: (file: string) => Promise<{ size: number; mtimeMs: number }>;
  now?: () => number;
}

const CONTEXT_RECOVERY_TTL_MS = 2_000;
const CONTEXT_RECOVERY_CACHE_LIMIT = 64;

const record = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
);
const string = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

function target(run: { ref: { paneId: string; sessionId?: string } }): { pane: string; threadId: string } {
  const threadId = run.ref.sessionId;
  if (!threadId) throw new Error('Codex conversation control requires a managed thread');
  return { pane: run.ref.paneId, threadId };
}

const PERMISSION_SETTINGS: Record<Exclude<ConversationPermissionMode, 'custom'>, JsonRecord> = {
  default: {
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite' },
  },
  'auto-review': {
    approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    sandboxPolicy: { type: 'workspaceWrite' },
  },
  'full-access': {
    approvalPolicy: 'never', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
};

function permissionMode(settings: JsonRecord): ConversationPermissionMode {
  const sandbox = string(record(settings.sandboxPolicy)?.type);
  const approval = string(settings.approvalPolicy);
  const reviewer = string(settings.approvalsReviewer);
  if ((sandbox === 'dangerFullAccess' || sandbox === 'danger-full-access') && approval === 'never') {
    return 'full-access';
  }
  if ((sandbox === 'workspaceWrite' || sandbox === 'workspace-write') && approval === 'on-request') {
    return reviewer === 'auto_review' || reviewer === 'guardian_subagent' ? 'auto-review' : 'default';
  }
  return 'custom';
}

function contextSnapshot(value: unknown): ConversationContextSnapshot {
  const status = record(value) ?? {};
  const settings = record(status.settings) ?? {};
  const usage = record(status.contextUsage);
  const nativeStatus = record(status.status);
  const flags = Array.isArray(nativeStatus?.activeFlags) ? nativeStatus.activeFlags : [];
  const activity = status.activityKind === 'compacting' ? 'compacting'
    : flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
      || (Array.isArray(status.approvals) && status.approvals.length > 0)
      || (Array.isArray(status.userInputs) && status.userInputs.length > 0) ? 'waiting'
      : nativeStatus?.type === 'active' ? 'working' : 'idle';
  const sandbox = string(record(settings.sandboxPolicy)?.type);
  const access = sandbox === 'readOnly' || sandbox === 'read-only' ? 'read-only'
    : sandbox === 'workspaceWrite' || sandbox === 'workspace-write' ? 'workspace-write'
      : sandbox === 'dangerFullAccess' || sandbox === 'danger-full-access' ? 'full-access' : undefined;
  const usedTokens = typeof usage?.usedTokens === 'number' ? usage.usedTokens : undefined;
  const totalTokens = typeof usage?.totalTokens === 'number' ? usage.totalTokens : undefined;
  const cwd = string(settings.cwd);
  const branch = string(status.gitBranch);
  return {
    activity,
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(branch === undefined ? {} : { branch }),
    ...(access === undefined ? {} : { access }),
  };
}

function permissionSnapshot(value: unknown): ConversationPermissionSnapshot {
  const status = record(value) ?? {};
  const settings = record(status.settings) ?? {};
  return {
    mode: permissionMode(settings),
    options: ['default', 'auto-review', 'full-access'],
  };
}

function planSnapshot(value: unknown) {
  const status = record(value) ?? {};
  const plan = record(status.plan);
  const stepsValue = Array.isArray(plan?.steps) ? plan.steps : Array.isArray(plan?.plan) ? plan.plan : [];
  const steps = stepsValue.flatMap((candidate) => {
    const step = record(candidate);
    const label = string(step?.step);
    const state = ['pending', 'inProgress', 'completed'].find((item) => item === step?.status);
    return label && state ? [{ step: label, status: state as 'pending' | 'inProgress' | 'completed' }] : [];
  });
  if (!steps.length) return null;
  const explanation = string(plan?.explanation);
  const turnId = string(plan?.turnId) ?? string(status.activeTurnId);
  const waiting = contextSnapshot(status).activity === 'waiting';
  return {
    steps,
    ...(explanation === undefined ? {} : { explanation }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(waiting ? { waiting: true } : {}),
  };
}

export function createCodexConversationControls(
  app: CodexConversationControlApp,
  clear: (pane: string, threadId: string) => Promise<void>,
  {
    sessionsRoot = sessionsDir(),
    findRollout = resolveCodexRollout,
    reader = readLatestContextUsage,
    stat = statFile,
    now = Date.now,
  }: CodexConversationControlOptions = {},
): CodexConversationControls {
  let cached: { key: string; expiresAt: number; value: Promise<unknown> } | undefined;
  type RecoveredContext = {
    checkedAt: number;
    file: string | null;
    size?: number;
    mtimeMs?: number;
    value: CodexContextUsage | null;
    inFlight?: Promise<CodexContextUsage | null>;
  };
  const recoveredContexts = new Map<string, RecoveredContext>();
  const storeRecovered = (threadId: string, entry: RecoveredContext): void => {
    if (recoveredContexts.has(threadId)) recoveredContexts.delete(threadId);
    if (recoveredContexts.size >= CONTEXT_RECOVERY_CACHE_LIMIT) {
      const oldest = recoveredContexts.keys().next().value as string | undefined;
      if (oldest !== undefined) recoveredContexts.delete(oldest);
    }
    recoveredContexts.set(threadId, entry);
  };
  const recoverContext = (threadId: string): Promise<CodexContextUsage | null> => {
    const checkedAt = now();
    const previous = recoveredContexts.get(threadId);
    if (previous?.inFlight) return previous.inFlight;
    if (previous && previous.checkedAt + CONTEXT_RECOVERY_TTL_MS > checkedAt) {
      return Promise.resolve(previous.value);
    }
    let pending: Promise<CodexContextUsage | null>;
    pending = (async () => {
      try {
        const file = await findRollout(sessionsRoot, threadId);
        if (!file) {
          storeRecovered(threadId, { checkedAt, file: null, value: null });
          return null;
        }
        const metadata = await stat(file);
        if (previous?.file === file && previous.size === metadata.size
          && previous.mtimeMs === metadata.mtimeMs) {
          storeRecovered(threadId, {
            checkedAt,
            file,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            value: previous.value,
          });
          return previous.value;
        }
        const value = await reader(file);
        storeRecovered(threadId, {
          checkedAt, file, size: metadata.size, mtimeMs: metadata.mtimeMs, value,
        });
        return value;
      } catch {
        const fallback: RecoveredContext = previous ?? { checkedAt, file: null, value: null };
        storeRecovered(threadId, {
          checkedAt,
          file: fallback.file,
          ...(fallback.size === undefined ? {} : { size: fallback.size }),
          ...(fallback.mtimeMs === undefined ? {} : { mtimeMs: fallback.mtimeMs }),
          value: fallback.value,
        });
        return fallback.value;
      }
    })();
    storeRecovered(threadId, {
      checkedAt,
      file: previous?.file ?? null,
      ...(previous?.size === undefined ? {} : { size: previous.size }),
      ...(previous?.mtimeMs === undefined ? {} : { mtimeMs: previous.mtimeMs }),
      value: previous?.value ?? null,
      inFlight: pending,
    });
    return pending;
  };
  const status = (pane: string, threadId: string): Promise<unknown> => {
    const key = `${pane}\0${threadId}`;
    if (cached?.key === key && cached.expiresAt >= now()) return cached.value;
    const value = app.status(pane, threadId);
    cached = { key, expiresAt: now() + 100, value };
    void value.catch(() => { if (cached?.value === value) cached = undefined; });
    return value;
  };
  const invalidate = (): void => { cached = undefined; };
  return {
    goal: {
      apiVersion: 1,
      async read(run) {
        const { pane, threadId } = target(run);
        return parseCodexGoal(await app.getGoal(pane, threadId));
      },
      async start(run, objective) {
        const { pane, threadId } = target(run);
        const goal = parseCodexGoal(await app.startGoal(pane, threadId, objective));
        if (!goal) throw new Error('Codex returned an invalid Goal');
        invalidate(); return goal;
      },
      async update(run, patch) {
        const { pane, threadId } = target(run);
        const goal = parseCodexGoal(await app.updateGoal(pane, threadId, patch));
        if (!goal) throw new Error('Codex returned an invalid Goal');
        invalidate(); return goal;
      },
      async clear(run) {
        const { pane, threadId } = target(run);
        await app.clearGoal(pane, threadId); invalidate();
      },
    },
    plan: {
      apiVersion: 1,
      async read(run) {
        const { pane, threadId } = target(run);
        return planSnapshot(await status(pane, threadId));
      },
    },
    context: {
      apiVersion: 1,
      async read(run) {
        const { pane, threadId } = target(run);
        const snapshot = contextSnapshot(await status(pane, threadId));
        if (snapshot.usedTokens !== undefined && snapshot.totalTokens !== undefined) return snapshot;
        const recovered = await recoverContext(threadId);
        return recovered ? {
          ...snapshot,
          usedTokens: recovered.usedTokens,
          totalTokens: recovered.totalTokens,
        } : snapshot;
      },
    },
    permission: {
      apiVersion: 1,
      async read(run) {
        const { pane, threadId } = target(run);
        return permissionSnapshot(await status(pane, threadId));
      },
      async update(run, mode) {
        const { pane, threadId } = target(run);
        await app.updateSettings(pane, threadId, PERMISSION_SETTINGS[mode]);
        invalidate();
        return permissionSnapshot(await status(pane, threadId));
      },
    },
    commands: {
      apiVersion: 1,
      commands: ['compact', 'clear'],
      async execute(run, command) {
        const { pane, threadId } = target(run);
        if (command === 'compact') await app.compact(pane, threadId);
        else await clear(pane, threadId);
        invalidate();
      },
    },
  };
}
