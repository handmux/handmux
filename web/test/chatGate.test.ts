// web/test/chatGate.test.js
import { describe, it, expect } from 'vitest';
import { fallbackGate } from '../src/chatGate.js';
import { parsePendingPrompt } from '../src/hooks/usePendingPrompt.js';

// The transcript-based gate was removed: a pending prompt's options aren't in the .jsonl until answered, so
// options are now scraped from the pane (see server/src/pendingPrompt.js + PromptGate). chatGate only holds
// the generic 允许/拒绝 fallback used when the menu can't be parsed.
describe('fallbackGate', () => {
  it('returns 允许/拒绝 driving Enter / Escape', () => {
    const g = fallbackGate();
    expect(g.options.map((o) => o.label)).toEqual(['允许', '拒绝']);
    expect(g.options[0].keys).toEqual(['Enter']);
    expect(g.options[1].keys).toEqual(['Escape']);
  });

  it('validates scraped prompt options before rendering the gate', () => {
    expect(parsePendingPrompt({
      title: '选择方案', cursor: 2,
      options: [
        { n: 1, label: 'A', description: '推荐' },
        { n: '2', label: 'invalid' },
        { n: 2, label: 'B' },
      ],
    })).toEqual({
      title: '选择方案', cursor: 2,
      options: [{ n: 1, label: 'A', description: '推荐' }, { n: 2, label: 'B' }],
    });
    expect(parsePendingPrompt({ title: 'empty', options: [] })).toBeNull();
  });
});
