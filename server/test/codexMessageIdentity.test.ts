import { describe, expect, it } from 'vitest';
import { codexGoalMessageId, codexItemMessageId } from '../src/codexMessageIdentity.js';

describe('Codex canonical message identity', () => {
  it('uses the native turn and item identity across live and rollout projections', () => {
    expect(codexItemMessageId('turn-1', 'agent-1')).toBe('codex:turn-1:agent-1');
    expect(codexItemMessageId('turn-1', 'tool-1', 2)).toBe('codex:turn-1:tool-1:child-2');
    expect(codexItemMessageId(null, 'agent-1')).toBeNull();
  });

  it('uses native Goal creation identity and lifecycle', () => {
    expect(codexGoalMessageId({ objective: 'Ship', status: 'complete', createdAt: 10 }, 'complete'))
      .toBe('codex-goal:10:complete');
    expect(codexGoalMessageId({ objective: 'Ship', status: 'active' }, 'set'))
      .toBe('codex-goal:Ship:set');
  });
});
