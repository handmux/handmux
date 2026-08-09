import { describe, expect, it } from 'vitest';
import {
  parseCodexGoal, parseCodexProjectedStreamEvent, parseCodexStreamEvent, projectCodexStreamEvent,
} from '../src/codexStreamProtocol.js';

describe('Codex stream protocol', () => {
  it('validates a native Goal while retaining forward-compatible metadata', () => {
    expect(parseCodexGoal({
      threadId: 'thread-1', objective: 'Ship safely', status: 'active',
      createdAt: 1, updatedAt: 2, tokensUsed: 3, timeUsedSeconds: 4,
      tokenBudget: null, futureField: { enabled: true },
    })).toEqual({
      threadId: 'thread-1', objective: 'Ship safely', status: 'active',
      createdAt: 1, updatedAt: 2, tokensUsed: 3, timeUsedSeconds: 4,
      tokenBudget: null, futureField: { enabled: true },
    });
  });

  it('rejects malformed Goal fields before they enter the session projection', () => {
    expect(parseCodexGoal({ objective: '', status: 'active' })).toBeNull();
    expect(parseCodexGoal({ objective: 'Ship', status: 'unknown' })).toBeNull();
    expect(parseCodexGoal({ objective: 'Ship', status: 'active', tokensUsed: '3' })).toBeNull();
  });

  it('accepts complete lifecycle events and rejects incomplete wire events', () => {
    expect(parseCodexStreamEvent({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello',
    })).toMatchObject({ type: 'delta', delta: 'hello' });
    expect(parseCodexStreamEvent({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'set',
      goal: { objective: 'Ship', status: 'active' },
    })).toMatchObject({ type: 'goal', goal: { objective: 'Ship', status: 'active' } });
    expect(parseCodexStreamEvent({ type: 'delta', delta: 'missing identity' })).toBeNull();
    expect(parseCodexStreamEvent({ type: 'future/event', threadId: 'thread-1' })).toBeNull();
  });

  it('projects domain events onto a strict ordered wire identity', () => {
    const projected = projectCodexStreamEvent({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello',
    }, 7);
    expect(projected).toEqual({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello',
      eventId: 'thread-1:7', sequence: 7, kind: 'assistantMessage', lifecycle: 'delta',
      mutation: {
        operation: 'upsert', mode: 'append',
        message: {
          id: 'codex:turn-1:item-1', role: 'assistant', type: 'text', turnId: 'turn-1',
          itemId: 'item-1', text: 'hello', completed: false, streaming: true,
        },
      },
    });
    if (!projected || projected.mutation?.operation !== 'upsert') {
      throw new Error('expected an upsert projection');
    }
    expect(parseCodexProjectedStreamEvent(projected)).toEqual(projected);
    expect(parseCodexProjectedStreamEvent({ ...projected, sequence: 8 })).toBeNull();
    expect(parseCodexProjectedStreamEvent({ ...projected, lifecycle: 'completed' })).toBeNull();
    expect(parseCodexProjectedStreamEvent({
      ...projected,
      mutation: { ...projected.mutation, message: { ...projected.mutation.message, id: 'forged' } },
    })).toBeNull();
    expect(projectCodexStreamEvent({ type: 'ready', threadId: 'thread-1' }, 8)).toBeNull();
    expect(projectCodexStreamEvent({
      type: 'turnCompleted', threadId: 'thread-1', turnId: 'turn-1', status: 'completed',
    }, 8)).toMatchObject({
      eventId: 'thread-1:8', sequence: 8, turnId: 'turn-1', itemId: null,
      kind: 'turn', lifecycle: 'completed',
    });
  });

  it('validates a cursor reset without treating it as a projected domain event', () => {
    expect(parseCodexStreamEvent({ type: 'cursorReset', threadId: 'thread-1', cursor: 12 }))
      .toEqual({ type: 'cursorReset', threadId: 'thread-1', cursor: 12 });
    expect(parseCodexStreamEvent({ type: 'cursorReset', threadId: 'thread-1', cursor: -1 })).toBeNull();
  });
});
