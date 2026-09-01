import { describe, expect, it } from 'vitest';
import {
  applyAgentConversationEvent,
  emptyAgentConversationProjection,
  prependAgentConversationItems,
  seedAgentConversationProjection,
} from './agentConversationState.js';
import type { ConversationItem, ConversationItemDraft } from './agentConversationTypes.js';

const historyItem = {
  id: 'history-1', sessionId: 'session-1', kind: 'message' as const, role: 'user' as const,
  status: 'complete' as const, content: [{ type: 'text' as const, text: 'history' }],
};

function goalDraft(event: 'set' | 'restarted', createdAt?: number): ConversationItemDraft {
  return {
    kind: 'notice', level: 'info', code: 'goal_updated', message: 'Ship safely · active',
    extensions: {
      'conversation.goal': {
        objective: 'Ship safely', status: 'active',
        ...(createdAt === undefined ? {} : { createdAt }),
      },
      'conversation.goalEvent': event,
    },
  };
}

function goalItem(id: string, event: 'set' | 'restarted', createdAt?: number): ConversationItem {
  return {
    id, sessionId: 'session-1', status: 'complete',
    ...goalDraft(event, createdAt),
  } as ConversationItem;
}

describe('Agent Conversation live projection', () => {
  it('merges provisional deltas and replaces them with the settled durable item', () => {
    let state = seedAgentConversationProjection([], 4);
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 5, provisionalId: 'answer-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '你' }] },
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.delta', sequence: 6, provisionalId: 'answer-1',
      delta: { op: 'text.append', target: 'message.content', text: '好' },
    });
    expect(state.slots[0]?.item).toMatchObject({
      kind: 'message', content: [{ type: 'text', text: '你好' }],
    });

    const openedKey = state.slots[0]?.key;

    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 7, provisionalId: 'answer-1', durableItemId: 'pi:entry-1',
      item: {
        id: 'pi:entry-1', sessionId: 'session-1', kind: 'message', role: 'assistant',
        status: 'complete', content: [{ type: 'text', text: '你好' }],
      },
    });
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0]).toMatchObject({
      key: openedKey, provisional: false, live: true,
      item: { id: 'pi:entry-1' },
    });
  });

  it('keeps a settled exact item slot key when the next epoch reads it authoritatively', () => {
    const item: ConversationItem = {
      id: 'answer-1', sessionId: 'session-1', kind: 'message', role: 'assistant',
      status: 'complete', content: [{ type: 'text', text: 'done' }],
    };
    let state = applyAgentConversationEvent(emptyAgentConversationProjection(), {
      type: 'item.opened', sequence: 1, provisionalId: 'answer-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    const slotKey = state.slots[0]!.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 2, provisionalId: 'answer-1',
      durableItemId: 'answer-1', item,
    });

    state = seedAgentConversationProjection([item], 0, state);

    expect(state.slots).toEqual([
      expect.objectContaining({ key: slotKey, provisional: false, live: false }),
    ]);
  });

  it('attaches snapshot-before-opened replay to the restored row without duplicating it', () => {
    const pending: ConversationItem = {
      id: 'pending-answer', sessionId: 'session-1', kind: 'message', role: 'assistant',
      status: 'complete', content: [{ type: 'text', text: 'answer' }],
    };
    let state = seedAgentConversationProjection([pending], 1);
    const snapshotKey = state.slots[0]?.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 2, provisionalId: 'pending-answer',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
    expect(state.slots).toEqual([
      expect.objectContaining({
        key: snapshotKey, provisionalId: 'pending-answer', provisional: true, live: true,
      }),
    ]);
    state = applyAgentConversationEvent(state, {
      type: 'item.delta', sequence: 3, provisionalId: 'pending-answer',
      delta: { op: 'text.append', target: 'message.content', text: 'answer' },
    });
    expect(state.slots[0]?.item).toMatchObject({
      kind: 'message', content: [{ type: 'text', text: 'answer' }],
    });

    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 4, provisionalId: 'pending-answer', item: pending,
    });
    expect(state.slots).toEqual([
      expect.objectContaining({ key: snapshotKey, provisional: false, live: true }),
    ]);
  });

  it('hands differently identified Goals to durable occurrences newest-first and only once', () => {
    let state = emptyAgentConversationProjection();
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 1, provisionalId: 'goal-live-1',
      draft: goalDraft('restarted', 10),
    });
    const firstKey = state.slots[0]!.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 2, provisionalId: 'goal-live-1',
      durableItemId: 'goal-live-1', item: goalItem('goal-live-1', 'restarted', 10),
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 3, provisionalId: 'goal-live-2',
      draft: goalDraft('set', 20),
    });
    const secondKey = state.slots[1]!.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 4, provisionalId: 'goal-live-2',
      durableItemId: 'goal-live-2', item: goalItem('goal-live-2', 'set', 20),
    });

    const both = seedAgentConversationProjection([
      goalItem('goal-context-1', 'set'), goalItem('goal-context-2', 'set'),
    ], 0, state);
    expect(both.slots.map((slot) => slot.key)).toEqual([firstKey, secondKey]);

    const newestOnly = seedAgentConversationProjection([
      goalItem('goal-context-2', 'set'),
    ], 0, state);
    expect(newestOnly.slots[0]?.key).toBe(secondKey);

    const laterRepeat = seedAgentConversationProjection([
      goalItem('goal-context-3', 'set'),
    ], 0, newestOnly);
    expect(laterRepeat.slots[0]?.key).toBe('durable:goal-context-3');
  });

  it('keeps interleaved live slots when a later item settles first', () => {
    let state = seedAgentConversationProjection([historyItem], 0);
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 1, provisionalId: 'answer-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 2, provisionalId: 'goal-1',
      draft: { kind: 'notice', level: 'info', code: 'goal_updated', message: 'goal' },
    });
    const goalKey = state.slots[2]?.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 3, provisionalId: 'goal-1', durableItemId: 'goal-final',
      item: {
        id: 'goal-final', sessionId: 'session-1', status: 'complete', kind: 'notice',
        level: 'info', code: 'goal_updated', message: 'goal',
      },
    });

    expect(state.slots.map((slot) => slot.item && ('id' in slot.item
      ? slot.item.id : slot.provisionalId))).toEqual(['history-1', 'answer-1', 'goal-final']);
    expect(state.slots[2]).toMatchObject({ key: goalKey, provisional: false, live: true });
  });

  it('starts a new observation at its checkpoint and accepts its sequence one', () => {
    let previous = seedAgentConversationProjection([historyItem], 7);
    previous = applyAgentConversationEvent(previous, {
      type: 'item.opened', sequence: 8, provisionalId: 'old-live',
      draft: { kind: 'reasoning_summary', text: 'old' },
    });

    let next = seedAgentConversationProjection([historyItem], 0, previous);
    next = applyAgentConversationEvent(next, {
      type: 'item.opened', sequence: 1, provisionalId: 'new-live',
      draft: { kind: 'reasoning_summary', text: 'new' },
    });

    expect(next.lastSequence).toBe(1);
    expect(next.slots.map((slot) => slot.provisionalId).filter(Boolean)).toEqual(['new-live']);
    expect(JSON.stringify(next)).not.toContain('old-live');
  });

  it('prepends older durable items without moving the live tail', () => {
    const current = {
      ...historyItem,
      id: 'history-2',
      content: [{ type: 'text' as const, text: 'current' }],
    };
    let state = seedAgentConversationProjection([current], 0);
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 1, provisionalId: 'answer-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    });
    state = prependAgentConversationItems(state, [historyItem, current]);

    expect(state.slots.map((slot) => slot.item && ('id' in slot.item
      ? slot.item.id : slot.provisionalId))).toEqual(['history-1', 'history-2', 'answer-1']);
    expect(state.slots[2]).toMatchObject({ provisional: true, live: true });
    expect(state.lastSequence).toBe(1);
  });

  it('keeps an id-only settlement slot until the authoritative page arrives', () => {
    let state = applyAgentConversationEvent(emptyAgentConversationProjection(), {
      type: 'item.opened', sequence: 1, provisionalId: 'first',
      draft: { kind: 'reasoning_summary', text: 'first' },
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 2, provisionalId: 'first', durableItemId: 'durable-first',
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 3, provisionalId: 'second',
      draft: { kind: 'reasoning_summary', text: 'second' },
    });

    expect(state.slots).toEqual([
      expect.objectContaining({ durableItemId: 'durable-first', provisional: false, live: true }),
      expect.objectContaining({ provisionalId: 'second', provisional: true, live: true }),
    ]);
  });

  it('keeps an ahead-of-replay durable item in its authoritative page position', () => {
    const first = { ...historyItem, id: 'answer-final' };
    const second = { ...historyItem, id: 'tool-final' };
    let state = seedAgentConversationProjection([first, second], 0);
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 1, provisionalId: 'answer-live',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    });
    const liveKey = state.slots[2]!.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 2, provisionalId: 'answer-live',
      durableItemId: 'answer-final', item: first,
    });

    expect(state.slots.map((slot) => slot.item && 'id' in slot.item ? slot.item.id : null))
      .toEqual(['answer-final', 'tool-final']);
    expect(state.slots[0]?.key).toBe(liveKey);
  });

  it('drops open drafts on a gap but keeps a settlement available for authoritative handoff', () => {
    const settledItem: ConversationItem = {
      id: 'settled', sessionId: 'session-1', kind: 'message', role: 'assistant',
      status: 'complete', content: [{ type: 'text', text: 'done' }],
    };
    let state = applyAgentConversationEvent(emptyAgentConversationProjection(), {
      type: 'item.opened', sequence: 1, provisionalId: 'settled',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    const settledKey = state.slots[0]!.key;
    state = applyAgentConversationEvent(state, {
      type: 'item.settled', sequence: 2, provisionalId: 'settled',
      durableItemId: 'settled', item: settledItem,
    });
    state = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 3, provisionalId: 'answer-1',
      draft: { kind: 'reasoning_summary', text: 'summary' },
    });
    state = applyAgentConversationEvent(state, {
      type: 'stream.gap', sequence: 4, afterSequence: 3,
    });
    const replayed = applyAgentConversationEvent(state, {
      type: 'item.opened', sequence: 3, provisionalId: 'stale',
      draft: { kind: 'notice', level: 'info', message: 'stale' },
    });
    expect(replayed).toBe(state);
    expect(state.slots).toEqual([
      expect.objectContaining({ key: settledKey, provisional: false, live: true }),
    ]);

    state = seedAgentConversationProjection([settledItem], 4, state);
    expect(state.slots).toEqual([
      expect.objectContaining({ key: settledKey, provisional: false, live: false }),
    ]);
  });

  it('rejects a delta that targets the wrong provisional kind', () => {
    const state = applyAgentConversationEvent(emptyAgentConversationProjection(), {
      type: 'item.opened', sequence: 1, provisionalId: 'tool-1',
      draft: { kind: 'tool_call', callId: 'call-1', name: 'bash' },
    });
    expect(() => applyAgentConversationEvent(state, {
      type: 'item.delta', sequence: 2, provisionalId: 'tool-1',
      delta: { op: 'text.append', target: 'message.content', text: 'bad' },
    })).toThrow('does not match');
  });
});
