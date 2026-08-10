import { codexGoalMessageId, codexItemMessageId } from './codexMessageIdentity.js';
import type {
  CodexGoal, CodexGoalEvent, CodexStreamDomainEvent,
} from './codexStreamProtocol.js';

export interface CodexProjectedTextMessage {
  id: string;
  role: 'assistant';
  type: 'text';
  turnId: string;
  itemId: string;
  text: string;
  completed: boolean;
  streaming: boolean;
}

export interface CodexProjectedGoalMessage {
  id: string;
  role: 'assistant';
  type: 'goal';
  turnId: string | null;
  event: CodexGoalEvent;
  goal: CodexGoal;
  completed: true;
}

export type CodexProjectedConversationMessage =
  | CodexProjectedTextMessage
  | CodexProjectedGoalMessage;

export type CodexConversationMutation =
  | {
    operation: 'upsert';
    mode: 'append' | 'replace';
    message: CodexProjectedConversationMessage;
  }
  | {
    operation: 'settleTurn';
    turnId: string;
  };

export interface CodexConversationDomainEvent {
  [key: string]: unknown;
  type: 'conversation';
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  mutation: CodexConversationMutation;
}

function textMutation(
  event: Extract<CodexStreamDomainEvent, { type: 'started' | 'snapshot' | 'delta' | 'completed' }>,
): CodexConversationMutation | null {
  const id = codexItemMessageId(event.turnId, event.itemId);
  if (!id) return null;
  const completed = event.type === 'completed' || event.completed === true;
  return {
    operation: 'upsert',
    mode: event.type === 'delta' ? 'append' : 'replace',
    message: {
      id,
      role: 'assistant',
      type: 'text',
      turnId: event.turnId,
      itemId: event.itemId,
      text: event.type === 'delta' ? event.delta ?? '' : event.text ?? '',
      completed,
      streaming: !completed,
    },
  };
}

export function projectCodexConversationMutation(
  event: CodexStreamDomainEvent,
): CodexConversationMutation | null {
  if (event.type === 'conversation') return event.mutation;
  if (event.type === 'started' || event.type === 'snapshot'
    || event.type === 'delta' || event.type === 'completed') {
    return textMutation(event);
  }
  if (event.type === 'turnCompleted') {
    return event.turnId ? { operation: 'settleTurn', turnId: event.turnId } : null;
  }
  if (event.type === 'goal') {
    if (['blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(event.goal.status)
      && !event.turnId) return null;
    const id = codexGoalMessageId(event.goal, event.event);
    if (!id) return null;
    return {
      operation: 'upsert',
      mode: 'replace',
      message: {
        id,
        role: 'assistant',
        type: 'goal',
        turnId: event.turnId,
        event: event.event,
        goal: event.goal,
        completed: true,
      },
    };
  }
  // Clearing the current Goal changes session state, not an already recorded conversation card.
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function parseCodexConversationMutationValue(
  value: unknown,
): CodexConversationMutation | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.operation === 'settleTurn') {
    const turnId = nonEmpty(record.turnId);
    return turnId ? { operation: 'settleTurn', turnId } : null;
  }
  if (record.operation !== 'upsert' || !['append', 'replace'].includes(String(record.mode))) return null;
  const message = recordOf(record.message);
  if (!message) return null;
  const id = nonEmpty(message.id);
  const turnId = nonEmpty(message.turnId);
  if (!id || message.role !== 'assistant' || typeof message.completed !== 'boolean') return null;
  if (message.type === 'text') {
    const itemId = nonEmpty(message.itemId);
    if (!turnId || !itemId || id !== codexItemMessageId(turnId, itemId)
      || typeof message.text !== 'string' || typeof message.streaming !== 'boolean') return null;
    return {
      operation: 'upsert', mode: record.mode as 'append' | 'replace',
      message: {
        id, role: 'assistant', type: 'text', turnId, itemId, text: message.text,
        completed: message.completed, streaming: message.streaming,
      },
    };
  }
  const goal = recordOf(message.goal);
  const event = nonEmpty(message.event) as CodexGoalEvent | null;
  const itemId = nonEmpty(message.itemId);
  const statuses = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
  const events = ['set', 'restarted', ...statuses];
  const objective = nonEmpty(goal?.objective);
  const numericKeys = ['createdAt', 'updatedAt', 'tokensUsed', 'timeUsedSeconds'];
  const invalidNumber = numericKeys.some((key) => goal && Object.hasOwn(goal, key)
    && (typeof goal[key] !== 'number' || !Number.isFinite(goal[key])));
  const invalidBudget = goal && Object.hasOwn(goal, 'tokenBudget') && goal.tokenBudget !== null
    && (typeof goal.tokenBudget !== 'number' || !Number.isFinite(goal.tokenBudget));
  if (message.type !== 'goal' || message.completed !== true || !goal || !objective
    || !statuses.includes(String(goal.status)) || !event || !events.includes(event)
    || invalidNumber || invalidBudget
    || (message.turnId !== null && !turnId)
    || (id !== codexGoalMessageId(goal as Partial<CodexGoal>, event)
      && (!turnId || !itemId || id !== codexItemMessageId(turnId, itemId)))) return null;
  return {
    operation: 'upsert', mode: record.mode as 'append' | 'replace',
    message: {
      id, role: 'assistant', type: 'goal', turnId: turnId || null, event,
      goal: goal as CodexGoal, completed: true,
    },
  };
}

// The raw App Server fields remain on the event for compatibility, but consumers only receive this
// canonical mutation. Reconstructing the mutation from the validated event prevents a forged duplicate
// payload from smuggling a second identity or lifecycle into the Web projection.
export function parseCodexConversationMutation(
  value: unknown,
  event: CodexStreamDomainEvent,
): CodexConversationMutation | null | undefined {
  const expected = projectCodexConversationMutation(event);
  if (!expected) return value === null ? null : undefined;
  const supplied = parseCodexConversationMutationValue(value);
  if (!supplied) return undefined;
  if (expected.operation === 'settleTurn') {
    if (supplied.operation !== 'settleTurn') return undefined;
    return supplied.turnId === expected.turnId ? expected : undefined;
  }
  if (supplied.operation !== 'upsert') return undefined;
  const message = supplied.message;
  if (supplied.mode !== expected.mode) return undefined;
  const projected = expected.message;
  if (message.id !== projected.id || message.role !== projected.role
    || message.type !== projected.type || message.turnId !== projected.turnId
    || message.completed !== projected.completed) return undefined;
  if (projected.type === 'text') {
    if (message.type !== 'text') return undefined;
    if (message.itemId !== projected.itemId || message.text !== projected.text
      || message.streaming !== projected.streaming) return undefined;
  } else {
    if (message.type !== 'goal' || message.event !== projected.event) return undefined;
  }
  return expected;
}

export function projectCodexRolloutMutation(value: unknown): CodexConversationMutation | null {
  const message = recordOf(value);
  const id = nonEmpty(message?.id);
  if (!message || !id || message.role !== 'assistant') return null;
  if (message.type === 'text') {
    const turnId = nonEmpty(message.turnId);
    const itemId = nonEmpty(message.itemId);
    if (!turnId || !itemId || typeof message.text !== 'string'
      || id !== codexItemMessageId(turnId, itemId)) return null;
    return {
      operation: 'upsert', mode: 'replace',
      message: {
        id, role: 'assistant', type: 'text', turnId, itemId, text: message.text,
        completed: true, streaming: false,
      },
    };
  }
  if (message.type !== 'goal') return null;
  const parsed = parseCodexConversationMutationValue({
    operation: 'upsert', mode: 'replace',
    message: { ...message, completed: true },
  });
  return parsed?.operation === 'upsert' ? parsed : null;
}

export function reconcileCodexRolloutMessages(
  previous: ReadonlyMap<string, string>,
  liveMessageIds: ReadonlySet<string>,
  messages: readonly unknown[],
): { fingerprints: Map<string, string>; mutations: CodexConversationMutation[] } {
  const fingerprints = new Map<string, string>();
  const mutations: CodexConversationMutation[] = [];
  for (const value of messages) {
    const mutation = projectCodexRolloutMutation(value);
    if (!mutation || mutation.operation !== 'upsert') continue;
    const fingerprint = JSON.stringify(mutation.message);
    fingerprints.set(mutation.message.id, fingerprint);
    if (liveMessageIds.has(mutation.message.id)
      && previous.get(mutation.message.id) !== fingerprint) mutations.push(mutation);
  }
  return { fingerprints, mutations };
}
