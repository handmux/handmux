import { useCallback, useEffect, useRef, useState } from 'react';
import { getCodexSession } from '../api.js';
import { usePollingLoop } from './usePollingLoop.js';
import { parseCodexGoal } from '../../../server/src/codexStreamProtocol.js';
import { parseCodexQueueItem } from '../../../server/src/codexQueueProtocol.js';
import { normalizeCodexPlan } from '../../../server/src/codexPlan.js';
import type { CodexGoal } from '../../../server/src/codexStreamProtocol.js';
import type { CodexQueueItem } from '../../../server/src/codexQueueProtocol.js';
import type { CodexPlanStep } from '../../../server/src/codexPlan.js';

export type CodexSessionKind = 'working' | 'permission' | 'compacting' | 'error' | null;

export interface CodexSessionStatus {
  type: string;
  activeFlags: string[];
}

export interface CodexSessionSettings {
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandboxPolicy?: { type?: string | null } | null;
}

export interface CodexSessionPlan {
  turnId?: string;
  steps: CodexPlanStep[];
  explanation?: string;
}

export interface CodexContextUsage {
  usedTokens: number;
  totalTokens: number;
}

export interface CodexSessionSnapshot {
  loaded: boolean;
  managed: boolean;
  threadId: string | null;
  status: CodexSessionStatus | null;
  activeTurnId: string | null;
  settings: CodexSessionSettings | null;
  contextUsage: CodexContextUsage | null;
  approvals: unknown[];
  userInputs: unknown[];
  queue: CodexQueueItem[];
  error: string | null;
  activityKind?: string | null;
  lastTurn?: { status?: string | null } | null;
  gitBranch?: string | null;
  plan?: CodexSessionPlan | null;
  goal?: CodexGoal | null;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const optionalString = (value: unknown): string | null => (
  typeof value === 'string' && value ? value : null
);

export const parseCodexSessionSettings = (value: unknown): CodexSessionSettings | null => {
  const settings = recordOf(value);
  if (!settings) return null;
  const sandbox = recordOf(settings.sandboxPolicy);
  return {
    model: optionalString(settings.model),
    effort: optionalString(settings.effort),
    serviceTier: optionalString(settings.serviceTier),
    cwd: optionalString(settings.cwd),
    approvalPolicy: optionalString(settings.approvalPolicy),
    approvalsReviewer: optionalString(settings.approvalsReviewer),
    sandboxPolicy: sandbox ? { type: optionalString(sandbox.type) } : null,
  };
};

const statusOf = (value: unknown): CodexSessionStatus | null => {
  const status = recordOf(value);
  if (!status || typeof status.type !== 'string') return null;
  return {
    type: status.type,
    activeFlags: Array.isArray(status.activeFlags)
      ? status.activeFlags.filter((flag): flag is string => typeof flag === 'string')
      : [],
  };
};

const contextUsageOf = (value: unknown): CodexContextUsage | null => {
  const usage = recordOf(value);
  if (!usage || typeof usage.usedTokens !== 'number' || !Number.isFinite(usage.usedTokens)
    || typeof usage.totalTokens !== 'number' || !Number.isFinite(usage.totalTokens)) return null;
  return { usedTokens: usage.usedTokens, totalTokens: usage.totalTokens };
};

const planOf = (value: unknown): CodexSessionPlan | null => {
  const plan = recordOf(value);
  if (!plan) return null;
  const steps = normalizeCodexPlan(plan.steps ?? plan.plan);
  if (!steps?.length) return null;
  return {
    steps,
    ...(typeof plan.turnId === 'string' && plan.turnId ? { turnId: plan.turnId } : {}),
    ...(typeof plan.explanation === 'string' && plan.explanation ? { explanation: plan.explanation } : {}),
  };
};

export function parseCodexSessionSnapshot(value: unknown): Omit<CodexSessionSnapshot, 'loaded'> | null {
  const session = recordOf(value);
  if (!session) return null;
  const queue = Array.isArray(session.queue)
    ? session.queue.map(parseCodexQueueItem).filter((item): item is CodexQueueItem => item !== null)
    : [];
  const lastTurn = recordOf(session.lastTurn);
  const hasGoal = Object.hasOwn(session, 'goal');
  return {
    managed: session.managed === true,
    threadId: optionalString(session.threadId),
    status: statusOf(session.status),
    activeTurnId: optionalString(session.activeTurnId),
    settings: parseCodexSessionSettings(session.settings),
    contextUsage: contextUsageOf(session.contextUsage),
    approvals: Array.isArray(session.approvals) ? session.approvals : [],
    userInputs: Array.isArray(session.userInputs) ? session.userInputs : [],
    queue,
    error: optionalString(session.error),
    activityKind: optionalString(session.activityKind),
    lastTurn: lastTurn ? { status: optionalString(lastTurn.status) } : null,
    gitBranch: optionalString(session.gitBranch),
    plan: planOf(session.plan),
    ...(hasGoal ? { goal: parseCodexGoal(session.goal) } : {}),
  };
}

export const EMPTY_CODEX_SESSION: CodexSessionSnapshot = {
  loaded: false, managed: false, threadId: null, status: null, activeTurnId: null, settings: null,
  contextUsage: null, approvals: [], userInputs: [], queue: [], error: null,
};
// One missed 750ms status poll is routine during App Server reconnects. Only a sustained outage should
// replace the loading/current conversation with a blocking connection explanation.
const CONNECTION_FAILURE_GRACE_MS = 5_000;

export function useCodexSession(
  pane: string,
  enabled: boolean,
  refreshToken: unknown = null,
): CodexSessionSnapshot {
  const scope = enabled && pane ? pane : null;
  const [snapshot, setSnapshot] = useState<{ scope: string | null; session: CodexSessionSnapshot }>(
    () => ({ scope, session: EMPTY_CODEX_SESSION }),
  );
  const connectionFailureSinceRef = useRef<number | null>(null);
  useEffect(() => {
    connectionFailureSinceRef.current = null;
    setSnapshot((current) => (
      current.scope === scope ? current : { scope, session: EMPTY_CODEX_SESSION }
    ));
  }, [scope]);
  const fetch = useCallback(() => getCodexSession(pane), [pane]);
  const apply = useCallback((result: unknown): void => {
    const parsed = parseCodexSessionSnapshot(result);
    if (!parsed) return;
    connectionFailureSinceRef.current = null;
    setSnapshot({
      scope,
      session: {
        ...EMPTY_CODEX_SESSION, ...parsed, loaded: true, error: null,
      },
    });
  }, [scope]);
  const fail = useCallback((error: unknown): void => {
    const now = Date.now();
    if (connectionFailureSinceRef.current == null) connectionFailureSinceRef.current = now;
    if (now - connectionFailureSinceRef.current < CONNECTION_FAILURE_GRACE_MS) return;
    setSnapshot((current) => ({
      scope,
      session: {
        ...(current.scope === scope ? current.session : EMPTY_CODEX_SESSION),
        loaded: true,
        error: error instanceof Error && error.message
          ? error.message
          : 'Codex connection unavailable',
      },
    }));
  }, [scope]);
  usePollingLoop({
    fetch,
    apply,
    onError: fail,
    intervalMs: 750,
    enabled: enabled && !!pane,
    deps: [pane, refreshToken],
  });
  return snapshot.scope === scope ? snapshot.session : EMPTY_CODEX_SESSION;
}

type CodexKindInput = Pick<
  CodexSessionSnapshot,
  'managed' | 'activityKind' | 'status' | 'lastTurn'
>;

export function codexKind(session: Partial<CodexKindInput> | null | undefined): CodexSessionKind {
  if (!session?.managed) return null;
  if (session.activityKind === 'compacting') return 'compacting';
  if (session.status?.type === 'active') {
    const waiting = session.status.activeFlags?.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
    return waiting ? 'permission' : 'working';
  }
  if (session.status?.type === 'systemError' || session.lastTurn?.status === 'failed') return 'error';
  return null;
}
