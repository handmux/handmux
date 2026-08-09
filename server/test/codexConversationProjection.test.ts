import { describe, expect, it } from 'vitest';
import {
  parseCodexConversationMutation, projectCodexConversationMutation,
} from '../src/codexConversationProjection.js';

describe('Codex conversation projection', () => {
  it('projects App Server text lifecycle into canonical conversation mutations', () => {
    expect(projectCodexConversationMutation({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '你',
    })).toEqual({
      operation: 'upsert', mode: 'append',
      message: {
        id: 'codex:turn-1:agent-1', role: 'assistant', type: 'text',
        turnId: 'turn-1', itemId: 'agent-1', text: '你', completed: false, streaming: true,
      },
    });
    expect(projectCodexConversationMutation({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', text: '你好',
    })).toMatchObject({
      operation: 'upsert', mode: 'replace',
      message: { id: 'codex:turn-1:agent-1', text: '你好', completed: true, streaming: false },
    });
  });

  it('projects Goal and turn lifecycle without inventing a placement', () => {
    const goal = { objective: 'Ship', status: 'complete' as const, createdAt: 10 };
    expect(projectCodexConversationMutation({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-1', event: 'complete', goal,
    })).toEqual({
      operation: 'upsert', mode: 'replace',
      message: {
        id: 'codex-goal:10:complete', role: 'assistant', type: 'goal', turnId: 'turn-1',
        event: 'complete', goal, completed: true,
      },
    });
    expect(projectCodexConversationMutation({
      type: 'turnCompleted', threadId: 'thread-1', turnId: 'turn-1', status: 'completed',
    })).toEqual({ operation: 'settleTurn', turnId: 'turn-1' });
    expect(projectCodexConversationMutation({
      type: 'goalCleared', threadId: 'thread-1', turnId: null,
    })).toBeNull();
  });

  it('rejects a mutation whose identity disagrees with its validated event', () => {
    const event = {
      type: 'delta' as const, threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '你',
    };
    const mutation = projectCodexConversationMutation(event);
    expect(parseCodexConversationMutation(mutation, event)).toEqual(mutation);
    expect(parseCodexConversationMutation({
      ...mutation,
      message: { ...(mutation?.operation === 'upsert' ? mutation.message : {}), id: 'forged' },
    }, event)).toBeUndefined();
  });
});
