import { describe, expect, it } from 'vitest';
import { parseCodexGoal, parseCodexStreamEvent } from '../src/codexStreamProtocol.js';

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
});
