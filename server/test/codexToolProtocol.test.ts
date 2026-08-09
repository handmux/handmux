import { describe, expect, it } from 'vitest';
import { parseCodexDiff, parseCodexToolProjection } from '../src/codexToolProtocol.js';

describe('Codex tool protocol', () => {
  it('validates positioned and unpositioned file diffs', () => {
    expect(parseCodexDiff({
      added: 1, removed: 1,
      hunks: [{ oldStart: 10, newStart: 10, lines: ['-old', '+new'] }],
    })).toMatchObject({ added: 1, removed: 1 });
    expect(parseCodexDiff({
      added: 1, removed: 0,
      hunks: [{ oldStart: null, newStart: null, lines: ['+new'] }], created: true,
    })).toMatchObject({ created: true });
    expect(parseCodexDiff({ added: -1, removed: 0, hunks: null })).toBeNull();
  });

  it('accepts a complete tool card and rejects malformed nested data', () => {
    expect(parseCodexToolProjection({
      name: 'apply_patch', input: { file_path: 'src/a.ts' }, result: '', isError: false,
      outcome: 'success', diff: { added: 1, removed: 0, hunks: null },
    })).toMatchObject({ name: 'apply_patch', outcome: 'success' });
    expect(parseCodexToolProjection({
      name: 'custom_tool', input: ['one'], result: null, isError: false,
    })).toMatchObject({ input: ['one'] });
    expect(parseCodexToolProjection({
      name: 'apply_patch', input: {}, result: '', isError: false,
      diff: { added: 1, removed: 0, hunks: [{ oldStart: '1', newStart: 1, lines: [] }] },
    })).toBeNull();
  });
});
