import { describe, expect, it } from 'vitest';
import { enrichCodexFileDiffs, parseUnifiedDiff } from '../src/codexDiff.js';

describe('Codex file diffs', () => {
  it('parses real old/new starts for every unified-diff hunk', () => {
    expect(parseUnifiedDiff([
      '@@ -12,2 +12,3 @@',
      ' keep',
      '-old',
      '+new',
      '+extra',
      '@@ -80 +81 @@',
      '-before',
      '+after',
    ].join('\n'))).toEqual({
      added: 3,
      removed: 2,
      hunks: [
        { oldStart: 12, newStart: 12, lines: [' keep', '-old', '+new', '+extra'] },
        { oldStart: 80, newStart: 81, lines: ['-before', '+after'] },
      ],
    });
  });

  it('keeps unknown bare-hunk positions empty instead of inventing line zero', () => {
    expect(parseUnifiedDiff('@@\n-old\n+new')).toEqual({
      added: 1, removed: 1, hunks: null,
    });
  });

  it('matches same-turn edits by path and changed content before adding line numbers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.js',
      '@@',
      '-second old',
      '+second new',
      '*** End Patch',
    ].join('\n');
    const messages = [{
      type: 'tool', turnId: 'turn-1',
      tool: {
        name: 'apply_patch', input: { file_path: 'src/a.js', patch },
        diff: {
          added: 1,
          removed: 1,
          hunks: [{ oldStart: null, newStart: null, lines: ['-second old', '+second new'] }],
        },
      },
    }];
    const thread = { turns: [{
      id: 'turn-1', items: [{
        type: 'fileChange', changes: [
          { path: '/work/src/a.js', kind: { type: 'update' }, diff: '@@ -10 +10 @@\n-first old\n+first new' },
          { path: '/work/src/a.js', kind: { type: 'update' }, diff: '@@ -70 +70 @@\n-second old\n+second new' },
        ],
      }],
    }] };

    expect(enrichCodexFileDiffs(messages, thread)[0].tool.diff.hunks[0])
      .toMatchObject({ oldStart: 70, newStart: 70 });
  });
});
