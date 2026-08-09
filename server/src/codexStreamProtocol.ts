const GOAL_STATUSES = [
  'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
] as const;

const GOAL_EVENTS = [
  'set', 'restarted', 'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
] as const;

export type CodexGoalStatus = (typeof GOAL_STATUSES)[number];
export type CodexGoalEvent = (typeof GOAL_EVENTS)[number];

export interface CodexGoal {
  [key: string]: unknown;
  threadId?: string;
  objective: string;
  status: CodexGoalStatus;
  createdAt?: number;
  updatedAt?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number | null;
}

export type CodexAgentStreamEvent = {
  [key: string]: unknown;
  type: 'started' | 'snapshot' | 'delta' | 'completed';
  threadId: string;
  turnId: string;
  itemId: string;
  text?: string;
  delta?: string;
  completed?: boolean;
};

export type CodexStreamEvent =
  | { [key: string]: unknown; type: 'ready'; threadId: string }
  | CodexAgentStreamEvent
  | {
    [key: string]: unknown;
    type: 'turnCompleted';
    threadId: string;
    turnId: string | null;
    status: string | null;
  }
  | {
    [key: string]: unknown;
    type: 'goal';
    threadId: string;
    turnId: string | null;
    event: CodexGoalEvent;
    goal: CodexGoal;
  }
  | {
    [key: string]: unknown;
    type: 'goalCleared';
    threadId: string;
    turnId: string | null;
  }
  | { [key: string]: unknown; type: 'disconnected'; threadId: string }
  | { [key: string]: unknown; type: 'error'; message: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value == null) return null;
  return nonEmptyString(value) ?? undefined;
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseCodexGoal(value: unknown): CodexGoal | null {
  const record = recordOf(value);
  if (!record) return null;
  const objective = nonEmptyString(record.objective);
  const status = GOAL_STATUSES.find((candidate) => candidate === record.status);
  if (!objective || !status) return null;

  const threadId = record.threadId == null ? undefined : nonEmptyString(record.threadId) ?? undefined;
  if (record.threadId != null && !threadId) return null;
  const numericKeys = ['createdAt', 'updatedAt', 'tokensUsed', 'timeUsedSeconds'] as const;
  const numeric = Object.fromEntries(numericKeys.map((key) => [key, optionalFiniteNumber(record, key)]));
  if (numericKeys.some((key) => Object.hasOwn(record, key) && numeric[key] === undefined)) return null;
  const tokenBudget = record.tokenBudget;
  if (Object.hasOwn(record, 'tokenBudget') && tokenBudget !== null
    && (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget))) return null;

  return {
    ...record,
    objective,
    status,
    ...(threadId ? { threadId } : {}),
    ...Object.fromEntries(Object.entries(numeric).filter(([, field]) => field !== undefined)),
    ...(Object.hasOwn(record, 'tokenBudget') ? { tokenBudget: tokenBudget as number | null } : {}),
  } as CodexGoal;
}

function parseAgentEvent(record: Record<string, unknown>): CodexAgentStreamEvent | null {
  const type = record.type;
  if (type !== 'started' && type !== 'snapshot' && type !== 'delta' && type !== 'completed') return null;
  const threadId = nonEmptyString(record.threadId);
  const turnId = nonEmptyString(record.turnId);
  const itemId = nonEmptyString(record.itemId);
  if (!threadId || !turnId || !itemId) return null;
  if (type === 'delta' && typeof record.delta !== 'string') return null;
  if (type !== 'delta' && typeof record.text !== 'string') return null;
  if (record.completed != null && typeof record.completed !== 'boolean') return null;
  return { ...record, type, threadId, turnId, itemId } as CodexAgentStreamEvent;
}

export function parseCodexStreamEvent(value: unknown): CodexStreamEvent | null {
  const record = recordOf(value);
  if (!record) return null;
  const agentEvent = parseAgentEvent(record);
  if (agentEvent) return agentEvent;

  const type = record.type;
  if (type === 'error') {
    const message = nonEmptyString(record.message);
    return message ? { ...record, type, message } : null;
  }
  const threadId = nonEmptyString(record.threadId);
  if (!threadId) return null;
  if (type === 'ready' || type === 'disconnected') return { ...record, type, threadId };
  if (type === 'turnCompleted') {
    const turnId = nullableString(record.turnId);
    const status = nullableString(record.status);
    if (turnId === undefined || status === undefined) return null;
    return { ...record, type, threadId, turnId, status };
  }
  if (type === 'goalCleared') {
    const turnId = nullableString(record.turnId);
    return turnId === undefined ? null : { ...record, type, threadId, turnId };
  }
  if (type === 'goal') {
    const turnId = nullableString(record.turnId);
    const event = GOAL_EVENTS.find((candidate) => candidate === record.event);
    const goal = parseCodexGoal(record.goal);
    if (turnId === undefined || !event || !goal) return null;
    return { ...record, type, threadId, turnId, event, goal };
  }
  return null;
}
