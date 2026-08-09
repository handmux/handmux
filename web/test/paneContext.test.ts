import { describe, expect, it } from 'vitest';
import { parsePaneContext } from '../src/hooks/usePaneContext.js';

describe('parsePaneContext', () => {
  it('normalizes the context snapshot without leaking malformed fields', () => {
    expect(parsePaneContext({ model: 'gpt-test', usedPercent: 42 }))
      .toEqual({ model: 'gpt-test', usedPercent: 42 });
    expect(parsePaneContext({ model: 7, usedPercent: Number.NaN }))
      .toEqual({ model: null, usedPercent: null });
    expect(parsePaneContext([])).toBeNull();
  });
});
