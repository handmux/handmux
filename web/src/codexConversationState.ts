import type { CodexGoal } from '../../server/src/codexStreamProtocol.js';
import type { CodexConversationMutation } from '../../server/src/codexConversationProjection.js';

export interface CodexConversationMessage {
  [key: string]: unknown;
  id?: string;
  k?: number | string;
  i?: number | string;
  turnId?: string | null;
  itemId?: string | null;
  role?: string;
  type?: string;
  text?: string;
  event?: string;
  goal?: Partial<CodexGoal>;
  live?: boolean;
  completed?: boolean;
  streaming?: boolean;
}

export interface CodexConversationEventLike {
  type?: string;
  mutation?: CodexConversationMutation | null;
}

function latestOrder(messages: readonly CodexConversationMessage[]): number {
  return messages.reduce((latest, message) => {
    const value = Number(message.k ?? message.i);
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, -1);
}

function goalOrder(
  messages: readonly CodexConversationMessage[],
  turnId: string | null,
): number {
  if (!turnId) return latestOrder(messages) + 0.5;
  let turnEnd = -1;
  messages.forEach((message, index) => {
    if (message.turnId === turnId) turnEnd = index;
  });
  if (turnEnd < 0) return latestOrder(messages) + 0.5;
  const current = Number(messages[turnEnd]?.k ?? messages[turnEnd]?.i);
  const following = Number(messages[turnEnd + 1]?.k ?? messages[turnEnd + 1]?.i);
  if (!Number.isFinite(current)) return latestOrder(messages) + 0.5;
  return Number.isFinite(following) && following > current
    ? current + ((following - current) / 2)
    : current + 0.5;
}

function insertGoal(
  messages: CodexConversationMessage[],
  message: CodexConversationMessage,
): CodexConversationMessage[] {
  if (!message.turnId) return [...messages, message];
  let turnEnd = -1;
  messages.forEach((candidate, index) => {
    if (candidate.turnId === message.turnId) turnEnd = index;
  });
  if (turnEnd < 0 && ['complete', 'blocked'].includes(message.goal?.status ?? '')) return messages;
  if (turnEnd < 0) return [...messages, message];
  const next = [...messages];
  next.splice(turnEnd + 1, 0, message);
  return next;
}

export function applyCodexConversationEvent(
  messages: CodexConversationMessage[],
  event: CodexConversationEventLike,
): CodexConversationMessage[] {
  if (event.type === 'ready' || event.type === 'cursorReset') {
    const next = messages.filter((message) => {
      if (!message.live) return true;
      if (message.type !== 'goal') return !message.completed;
      return !['complete', 'blocked'].includes(message.goal?.status ?? '') || !!message.turnId;
    });
    return next.length === messages.length ? messages : next;
  }
  const mutation = event.mutation;
  if (!mutation) return messages;
  if (mutation.operation === 'settleTurn') {
    let changed = false;
    const next = messages.map((message) => {
      if (!message.live || message.turnId !== mutation.turnId || message.completed) return message;
      changed = true;
      return { ...message, completed: true, streaming: false };
    });
    return changed ? next : messages;
  }

  const projected = mutation.message;
  const index = messages.findIndex((message) => message.id === projected.id);
  const previous = index >= 0 ? messages[index] : null;
  const persisted = event.type === 'conversation';
  const order = previous?.k ?? (projected.type === 'goal'
    ? goalOrder(messages, projected.turnId)
    : latestOrder(messages) + 0.5);
  let nextMessage: CodexConversationMessage;
  if (projected.type === 'goal') {
    nextMessage = {
      id: projected.id,
      k: order,
      turnId: projected.turnId,
      role: projected.role,
      type: projected.type,
      event: projected.event,
      goal: projected.goal,
      live: !persisted,
      completed: true,
    };
  } else {
    const text = mutation.mode === 'append'
      ? `${previous?.text || ''}${projected.text}`
      : projected.text;
    const completed = projected.completed || previous?.completed === true;
    nextMessage = {
      ...(previous || {}),
      id: projected.id,
      k: order,
      turnId: projected.turnId,
      itemId: projected.itemId,
      role: projected.role,
      type: projected.type,
      text,
      live: !persisted,
      streaming: !completed,
      completed,
    };
  }
  if (index >= 0) {
    return messages.map((message, candidate) => (candidate === index ? nextMessage : message));
  }
  const base = projected.type === 'text' && !projected.completed && mutation.mode === 'replace'
    ? messages.filter((message) => !message.live || message.type === 'goal' || !message.completed)
    : messages;
  return projected.type === 'goal' ? insertGoal(base, nextMessage) : [...base, nextMessage];
}
