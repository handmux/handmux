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

export type CodexApprovalSimpleDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type CodexApprovalDecision = CodexApprovalSimpleDecision | {
  type: 'execpolicy';
  id: string;
  rule?: string[];
} | {
  type: 'networkPolicy';
  id: string;
  action: 'allow' | 'deny';
  host: string;
};

export interface CodexApprovalRequest {
  id: string;
  type?: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  decisions: CodexApprovalDecision[];
}

export interface CodexInputOption {
  label: string;
  description?: string;
}

export interface CodexInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: CodexInputOption[] | null;
}

export interface CodexInputRequest {
  id: string;
  questions: CodexInputQuestion[];
}

export interface CodexSessionSnapshot {
  loaded: boolean;
  managed: boolean;
  threadId: string | null;
  status: CodexSessionStatus | null;
  activeTurnId: string | null;
  settings: CodexSessionSettings | null;
  contextUsage: CodexContextUsage | null;
  approvals: CodexApprovalRequest[];
  userInputs: CodexInputRequest[];
  queue: CodexQueueItem[];
  error: string | null;
  activityKind?: string | null;
  lastTurn?: { status?: string | null } | null;
  gitBranch?: string | null;
  plan?: CodexSessionPlan | null;
  goal?: CodexGoal | null;
  takeover?: { state: 'starting' | 'timed-out'; needsTerminal: boolean } | null;
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

const unfinishedPlanOf = (value: unknown): CodexSessionPlan | null => {
  const plan = planOf(value);
  return plan?.steps.some((step) => step.status !== 'completed') ? plan : null;
};

const approvalDecisionOf = (value: unknown, index: number): CodexApprovalDecision | null => {
  const simple: readonly CodexApprovalSimpleDecision[] = [
    'accept', 'acceptForSession', 'decline', 'cancel',
  ];
  if (typeof value === 'string') return simple.find((decision) => decision === value) ?? null;
  const decision = recordOf(value);
  if (!decision) return null;
  const id = optionalString(decision.id) || `structured:${index}`;
  if (decision.type === 'execpolicy') {
    const rule = Array.isArray(decision.rule)
      ? decision.rule.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    return { type: 'execpolicy', id, ...(rule ? { rule } : {}) };
  }
  if (decision.type === 'networkPolicy'
    && (decision.action === 'allow' || decision.action === 'deny')) {
    const host = optionalString(decision.host);
    return host ? { type: 'networkPolicy', id, action: decision.action, host } : null;
  }
  return null;
};

const approvalOf = (value: unknown): CodexApprovalRequest | null => {
  const approval = recordOf(value);
  const id = optionalString(approval?.id);
  if (!approval || !id || !Array.isArray(approval.decisions)) return null;
  const decisions = approval.decisions.map(approvalDecisionOf)
    .filter((decision): decision is CodexApprovalDecision => decision !== null);
  if (!decisions.length) return null;
  const type = optionalString(approval.type);
  return {
    id,
    ...(type ? { type } : {}),
    reason: approval.reason == null ? null : optionalString(approval.reason),
    command: approval.command == null ? null : optionalString(approval.command),
    cwd: approval.cwd == null ? null : optionalString(approval.cwd),
    decisions,
  };
};

const inputOf = (value: unknown): CodexInputRequest | null => {
  const input = recordOf(value);
  const id = optionalString(input?.id);
  if (!input || !id || !Array.isArray(input.questions)) return null;
  const questions = input.questions.flatMap((candidate): CodexInputQuestion[] => {
    const question = recordOf(candidate);
    const questionId = optionalString(question?.id);
    const text = optionalString(question?.question);
    if (!question || !questionId || !text) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((entry): CodexInputOption[] => {
        const option = recordOf(entry);
        const label = optionalString(option?.label);
        const description = optionalString(option?.description);
        return label ? [{
          label,
          ...(description ? { description } : {}),
        }] : [];
      })
      : question.options === null ? null : undefined;
    const header = optionalString(question.header);
    return [{
      id: questionId,
      question: text,
      ...(header ? { header } : {}),
      ...(question.isOther === true ? { isOther: true } : {}),
      ...(question.isSecret === true ? { isSecret: true } : {}),
      ...(options !== undefined ? { options } : {}),
    }];
  });
  return questions.length ? { id, questions } : null;
};

export function parseCodexSessionSnapshot(value: unknown): Omit<CodexSessionSnapshot, 'loaded'> | null {
  const session = recordOf(value);
  if (!session) return null;
  // App Server associates each update_plan snapshot with its originating turn. Between turns it exposes
  // that snapshot as lastPlan instead of plan; keep an unfinished thread-level plan resident until the
  // next turn publishes a replacement. A completed lastPlan must not leave a stale composer row behind.
  const plan = planOf(session.plan) || unfinishedPlanOf(session.lastPlan);
  const queue = Array.isArray(session.queue)
    ? session.queue.map(parseCodexQueueItem).filter((item): item is CodexQueueItem => item !== null)
    : [];
  const lastTurn = recordOf(session.lastTurn);
  const takeover = recordOf(session.takeover);
  const takeoverState = takeover?.state === 'starting' || takeover?.state === 'timed-out'
    ? takeover.state : null;
  const hasGoal = Object.hasOwn(session, 'goal');
  return {
    managed: session.managed === true,
    threadId: optionalString(session.threadId),
    status: statusOf(session.status),
    activeTurnId: optionalString(session.activeTurnId),
    settings: parseCodexSessionSettings(session.settings),
    contextUsage: contextUsageOf(session.contextUsage),
    approvals: Array.isArray(session.approvals)
      ? session.approvals.map(approvalOf)
        .filter((approval): approval is CodexApprovalRequest => approval !== null)
      : [],
    userInputs: Array.isArray(session.userInputs)
      ? session.userInputs.map(inputOf)
        .filter((input): input is CodexInputRequest => input !== null)
      : [],
    queue,
    error: optionalString(session.error),
    activityKind: optionalString(session.activityKind),
    lastTurn: lastTurn ? { status: optionalString(lastTurn.status) } : null,
    gitBranch: optionalString(session.gitBranch),
    plan,
    ...(takeoverState ? { takeover: { state: takeoverState, needsTerminal: takeover?.needsTerminal === true } } : {}),
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
