import { describe, expect, it } from 'vitest';
import { parseTerminalStreamMessage } from '../src/terminalStreamProtocol.js';

describe('terminal stream protocol', () => {
  it('accepts complete seed, ready and probe frames', () => {
    expect(parseTerminalStreamMessage({
      type: 'seed',
      ansi: 'prompt\n',
      width: 80,
      height: 24,
      historyLines: 1,
      alt: false,
      mouseAware: false,
      mouseSgr: false,
    })).toMatchObject({ type: 'seed', width: 80, height: 24 });
    expect(parseTerminalStreamMessage({
      type: 'ready',
      cur: { row: 0, col: 4, vis: true },
    })).toEqual({ type: 'ready', cur: { row: 0, col: 4, vis: true } });
    expect(parseTerminalStreamMessage({ type: 'probe', id: 7 }))
      .toEqual({ type: 'probe', id: 7 });
  });

  it('rejects partial, mistyped and unknown network frames', () => {
    expect(parseTerminalStreamMessage({ type: 'seed', width: 80, height: 24 })).toBeNull();
    expect(parseTerminalStreamMessage({
      type: 'ready',
      cur: { row: -1, col: 0, vis: true },
    })).toBeNull();
    expect(parseTerminalStreamMessage({ type: 'probe', id: '7' })).toBeNull();
    expect(parseTerminalStreamMessage({ type: 'other' })).toBeNull();
    expect(parseTerminalStreamMessage(null)).toBeNull();
  });
});
