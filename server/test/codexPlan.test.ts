import { describe, expect, it } from 'vitest';
import { codexPlanSnapshot, normalizeCodexPlan } from '../src/codexPlan.js';
import type { CodexPlanSnapshot } from '../src/codexPlan.js';

describe('Codex Plan contract', () => {
  it('normalizes App Server and persisted status spellings into one typed projection', () => {
    expect(normalizeCodexPlan([
      { step: ' inspect ', status: 'in_progress' },
      { step: 'implement', status: 'inProgress' },
      { step: 'verify', status: 'completed' },
      { step: 'ignored', status: 'unknown' },
    ])).toEqual([
      { step: 'inspect', status: 'inProgress' },
      { step: 'implement', status: 'inProgress' },
      { step: 'verify', status: 'completed' },
    ]);
  });

  it('rejects malformed boundary data and caps text before exposing it to clients', () => {
    expect(normalizeCodexPlan({ plan: [] })).toBeNull();
    expect(normalizeCodexPlan([null, { step: 42, status: 'pending' }])).toEqual([]);

    const snapshot: CodexPlanSnapshot | null = codexPlanSnapshot(
      'turn-1',
      [{ step: 'x'.repeat(2_100), status: 'pending' }],
      `  ${'y'.repeat(4_100)}  `,
    );
    expect(snapshot?.steps[0]?.step).toHaveLength(2_000);
    expect(snapshot?.explanation).toHaveLength(4_000);
  });

  it('requires both a turn identity and at least one valid step', () => {
    expect(codexPlanSnapshot(null, [{ step: 'inspect', status: 'pending' }])).toBeNull();
    expect(codexPlanSnapshot('turn-1', [])).toBeNull();
  });
});
