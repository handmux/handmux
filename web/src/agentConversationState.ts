import type {
  ConversationDelta,
  ConversationEvent,
  ConversationItem,
  ConversationItemDraft,
} from './agentConversationTypes.js';

export interface AgentConversationProjectionSlot {
  key: string;
  item?: ConversationItem | ConversationItemDraft;
  provisionalId?: string;
  durableItemId?: string;
  provisional: boolean;
  live: boolean;
  historyGrace?: true;
}

export interface AgentConversationProjection {
  slots: AgentConversationProjectionSlot[];
  lastSequence: number;
}

function durableSlot(item: ConversationItem): AgentConversationProjectionSlot {
  return {
    key: `durable:${item.id}`,
    item: structuredClone(item),
    provisional: false,
    live: false,
  };
}

interface GoalSlotIdentity {
  objective: string;
  status: string;
  lifecycle: string;
  createdAt: number | null;
}

function goalSlotIdentity(item: ConversationItem | ConversationItemDraft): GoalSlotIdentity | null {
  if (item.kind !== 'notice' || item.code !== 'goal_updated') return null;
  const goal = item.extensions?.['conversation.goal'];
  const event = item.extensions?.['conversation.goalEvent'];
  if (!goal || typeof goal !== 'object' || Array.isArray(goal) || typeof event !== 'string') return null;
  const objective = typeof goal.objective === 'string' ? goal.objective : null;
  const status = typeof goal.status === 'string' ? goal.status : null;
  if (!objective || !status) return null;
  const createdAt = typeof goal.createdAt === 'number' && Number.isFinite(goal.createdAt)
    ? goal.createdAt : null;
  const lifecycle = status === 'active' && ['set', 'restarted', 'active'].includes(event)
    ? 'active' : event;
  return { objective, status, lifecycle, createdAt };
}

function sameGoalSlot(
  left: ConversationItem | ConversationItemDraft,
  right: ConversationItem | ConversationItemDraft,
): boolean {
  const leftGoal = goalSlotIdentity(left);
  const rightGoal = goalSlotIdentity(right);
  return leftGoal !== null && rightGoal !== null
    && leftGoal.objective === rightGoal.objective
    && leftGoal.status === rightGoal.status
    && leftGoal.lifecycle === rightGoal.lifecycle
    && (leftGoal.createdAt === null || rightGoal.createdAt === null
      || leftGoal.createdAt === rightGoal.createdAt);
}

function sameSettledLiveOccurrence(
  left: ConversationItem | ConversationItemDraft,
  right: ConversationItem,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'tool_call' && right.kind === 'tool_call') return left.callId === right.callId;
  if (left.kind === 'tool_result' && right.kind === 'tool_result') return left.callId === right.callId;
  return left.kind === 'message' && right.kind === 'message'
    && left.role === right.role
    && 'sourceCreatedAt' in left && left.sourceCreatedAt !== undefined
    && right.sourceCreatedAt !== undefined
    && left.sourceCreatedAt === right.sourceCreatedAt;
}

export function emptyAgentConversationProjection(): AgentConversationProjection {
  return { slots: [], lastSequence: 0 };
}

/** Start a new live-observation epoch from its authoritative durable page. */
export function seedAgentConversationProjection(
  items: ConversationItem[],
  streamSequence: number,
  previous?: AgentConversationProjection,
): AgentConversationProjection {
  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const previousSlots = previous?.slots ?? [];
  const claimedPrevious = new Set<number>();
  const inheritedKeys = new Map<number, string>();

  // Exact durable identity always wins globally. Besides preserving an already handed-off slot across
  // later epochs, this reserves exact occurrences before the Goal-only semantic fallback runs.
  uniqueItems.forEach((item, itemIndex) => {
    const previousIndex = previousSlots.findIndex((slot, slotIndex) => (
      !slot.provisional && !claimedPrevious.has(slotIndex)
      && (slot.durableItemId === item.id
        || (slot.item && 'id' in slot.item && slot.item.id === item.id))
    ));
    if (previousIndex < 0) return;
    claimedPrevious.add(previousIndex);
    inheritedKeys.set(itemIndex, previousSlots[previousIndex]!.key);
  });

  // A Connector can settle a low-latency live item before its native durable id exists. Transfer
  // that row to the authoritative occurrence once the history barrier exposes it. Matching is limited
  // to provider-stable identities (callId or an exact native message timestamp), newest-to-newest.
  for (let itemIndex = uniqueItems.length - 1; itemIndex >= 0; itemIndex--) {
    if (inheritedKeys.has(itemIndex)) continue;
    const item = uniqueItems[itemIndex]!;
    for (let slotIndex = previousSlots.length - 1; slotIndex >= 0; slotIndex--) {
      const slot = previousSlots[slotIndex];
      if (!slot || claimedPrevious.has(slotIndex) || slot.provisional || slot.live !== true
        || !slot.item || !sameSettledLiveOccurrence(slot.item, item)) continue;
      claimedPrevious.add(slotIndex);
      inheritedKeys.set(itemIndex, slot.key);
      break;
    }
  }

  // App Server's immediate Goal card and the later injected rollout context intentionally have
  // different ids. Transfer only settled live slots, newest occurrence to newest occurrence, once.
  // A slot that was already made authoritative (`live: false`) may keep its key only by exact id;
  // otherwise a later identical Goal could steal an older occurrence's position.
  for (let itemIndex = uniqueItems.length - 1; itemIndex >= 0; itemIndex--) {
    if (inheritedKeys.has(itemIndex)) continue;
    const item = uniqueItems[itemIndex]!;
    if (!goalSlotIdentity(item)) continue;
    for (let slotIndex = previousSlots.length - 1; slotIndex >= 0; slotIndex--) {
      const slot = previousSlots[slotIndex];
      if (!slot || claimedPrevious.has(slotIndex) || slot.provisional || slot.live !== true
        || !slot.item || !sameGoalSlot(slot.item, item)) continue;
      claimedPrevious.add(slotIndex);
      inheritedKeys.set(itemIndex, slot.key);
      break;
    }
  }

  return {
    slots: uniqueItems.map((item, itemIndex) => ({
      ...durableSlot(item),
      key: inheritedKeys.get(itemIndex) ?? `durable:${item.id}`,
    })),
    lastSequence: streamSequence,
  };
}

/** Prepend an older durable page without disturbing current live slots. */
export function prependAgentConversationItems(
  state: AgentConversationProjection,
  items: ConversationItem[],
): AgentConversationProjection {
  const seen = new Set(state.slots.flatMap((slot) => (
    slot.item && 'id' in slot.item ? [slot.item.id]
      : slot.durableItemId ? [slot.durableItemId] : []
  )));
  const older = items.flatMap((item) => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [durableSlot(item)];
  });
  return older.length ? { ...state, slots: [...older, ...state.slots] } : state;
}

function nextDraft(current: ConversationItemDraft, delta: ConversationDelta): ConversationItemDraft {
  if (delta.op === 'item.replace') {
    if (current.kind !== delta.draft.kind
      || (current.kind === 'message' && delta.draft.kind === 'message' && current.role !== delta.draft.role)
      || (current.kind === 'tool_call' && delta.draft.kind === 'tool_call'
        && current.callId !== delta.draft.callId)
      || (current.kind === 'tool_result' && delta.draft.kind === 'tool_result'
        && current.callId !== delta.draft.callId)) {
      throw new Error('Conversation delta changed provisional identity');
    }
    return structuredClone(delta.draft);
  }
  const next = structuredClone(current);
  if (delta.target === 'reasoning_summary.text' && next.kind === 'reasoning_summary') {
    next.text += delta.text;
    return next;
  }
  if ((delta.target === 'message.content' && next.kind === 'message')
    || (delta.target === 'tool_result.content' && next.kind === 'tool_result')) {
    const index = delta.blockIndex ?? next.content.length - 1;
    const block = next.content[index];
    if (!block || block.type !== 'text') throw new Error('Conversation delta has no text target');
    block.text += delta.text;
    return next;
  }
  throw new Error('Conversation delta target does not match its item');
}

function provisionalIndex(state: AgentConversationProjection, provisionalId: string): number {
  return state.slots.findIndex((slot) => (
    slot.provisional && slot.provisionalId === provisionalId
  ));
}

export function applyAgentConversationEvent(
  state: AgentConversationProjection,
  event: ConversationEvent,
): AgentConversationProjection {
  if (event.sequence <= state.lastSequence) return state;
  if (event.type === 'item.opened') {
    if (provisionalIndex(state, event.provisionalId) >= 0) {
      throw new Error('Conversation item.opened reused a provisional id');
    }
    const snapshotIndex = state.slots.findIndex((slot) => (
      !slot.provisional && slot.item && 'id' in slot.item && slot.item.id === event.provisionalId
    ));
    if (snapshotIndex >= 0) {
      // Connector snapshots are flushed before queued ephemeral events. If the snapshot already
      // restored this provisional occurrence, attach the replayed opened event to that row instead
      // of appending a duplicate. A later settled/cancelled event can then address it normally.
      const slots = [...state.slots];
      const current = slots[snapshotIndex];
      if (!current) throw new Error('Conversation snapshot item lost its slot');
      slots[snapshotIndex] = {
        ...current,
        item: structuredClone(event.draft),
        provisionalId: event.provisionalId,
        provisional: true,
        live: true,
      };
      return { slots, lastSequence: event.sequence };
    }
    return {
      slots: [...state.slots, {
        key: `live:${event.provisionalId}`,
        provisionalId: event.provisionalId,
        item: structuredClone(event.draft),
        provisional: true,
        live: true,
      }],
      lastSequence: event.sequence,
    };
  }
  if (event.type === 'item.delta') {
    const index = provisionalIndex(state, event.provisionalId);
    if (index < 0) throw new Error('Conversation delta arrived before item.opened');
    const current = state.slots[index];
    if (!current?.item || 'id' in current.item) {
      throw new Error('Conversation delta arrived after item.settled');
    }
    const slots = [...state.slots];
    slots[index] = { ...current, item: nextDraft(current.item, event.delta) };
    return { slots, lastSequence: event.sequence };
  }
  if (event.type === 'item.settled') {
    const index = provisionalIndex(state, event.provisionalId);
    if (index < 0) throw new Error('Conversation settlement arrived before item.opened');
    if (!event.item) {
      const slots = [...state.slots];
      const current = slots[index];
      if (!current || !event.durableItemId) {
        throw new Error('Conversation settlement has no durable identity');
      }
      // Keep an invisible ordered hole until the authoritative page arrives. Dropping the slot here
      // would let later live items move ahead of this settlement.
      slots[index] = {
        key: current.key,
        durableItemId: event.durableItemId,
        provisional: false,
        live: true,
      };
      return {
        slots,
        lastSequence: event.sequence,
      };
    }
    const durableIndex = state.slots.findIndex((slot, slotIndex) => (
      slotIndex !== index && slot.item && 'id' in slot.item && slot.item.id === event.item?.id
    ));
    if (durableIndex >= 0) {
      // A reconnect can read a page that is ahead of the shared stream replay. In that race the page
      // already owns the item's canonical position. Transfer the live slot identity to that position
      // before discarding the redundant copy, so an optimistic steer anchored to it does not jump.
      const current = state.slots[index];
      const durable = state.slots[durableIndex];
      if (!current || !durable) throw new Error('Conversation settlement lost its slot');
      const slots = state.slots.map((slot, slotIndex) => (
        slotIndex === durableIndex ? { ...slot, key: current.key } : slot
      ));
      return {
        slots: slots.filter((_, slotIndex) => slotIndex !== index),
        lastSequence: event.sequence,
      };
    }
    const slots = [...state.slots];
    const current = slots[index];
    if (!current) throw new Error('Conversation settlement lost its provisional slot');
    slots[index] = {
      ...current,
      item: structuredClone(event.item),
      durableItemId: event.item.id,
      provisional: false,
      live: true,
    };
    return { slots, lastSequence: event.sequence };
  }
  if (event.type === 'item.cancelled') {
    const index = provisionalIndex(state, event.provisionalId);
    if (index < 0) throw new Error('Conversation cancellation arrived before item.opened');
    return {
      slots: state.slots.filter((_, slotIndex) => slotIndex !== index),
      lastSequence: event.sequence,
    };
  }
  if (event.type === 'stream.gap') {
    return {
      // Open drafts have no trustworthy continuation after a gap. Keep completed live slots only long
      // enough for the authoritative seed to retain their position when it owns the exact/Goal occurrence.
      slots: state.slots.filter((slot) => !slot.provisional),
      lastSequence: event.sequence,
    };
  }
  return { ...state, lastSequence: event.sequence };
}
