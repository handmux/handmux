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

// The raw App Server fields remain on the event for compatibility, but consumers only receive this
// canonical mutation. Reconstructing the mutation from the validated event prevents a forged duplicate
// payload from smuggling a second identity or lifecycle into the Web projection.
export function parseCodexConversationMutation(
  value: unknown,
  event: CodexStreamDomainEvent,
): CodexConversationMutation | null | undefined {
  const expected = projectCodexConversationMutation(event);
  if (!expected) return value === null ? null : undefined;
  const supplied = recordOf(value);
  if (!supplied || supplied.operation !== expected.operation) return undefined;
  if (expected.operation === 'settleTurn') {
    return supplied.turnId === expected.turnId ? expected : undefined;
  }
  const message = recordOf(supplied.message);
  if (supplied.mode !== expected.mode || !message) return undefined;
  const projected = expected.message;
  if (message.id !== projected.id || message.role !== projected.role
    || message.type !== projected.type || message.turnId !== projected.turnId
    || message.completed !== projected.completed) return undefined;
  if (projected.type === 'text') {
    if (message.itemId !== projected.itemId || message.text !== projected.text
      || message.streaming !== projected.streaming) return undefined;
  } else if (message.event !== projected.event) return undefined;
  return expected;
}
