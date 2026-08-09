import { describe, it, expect } from 'vitest';
import {
  fitRows, scrollDecision, topTarget, bottomTarget, cursorBufferLine,
  bottomPadRows, followTarget, viewportAtTop,
} from '../src/terminalViewport.js';

describe('fitRows', () => {
  it('floors available/cellH, min 1', () => {
    expect(fitRows(300, 20)).toBe(15);
    expect(fitRows(10, 20)).toBe(1);
    expect(fitRows(300, 0)).toBe(1);
  });
});

describe('scrollDecision', () => {
  it('up: internal while above top, else forward', () => {
    expect(scrollDecision(5, 20, -1)).toBe('internal');
    expect(scrollDecision(0, 20, -1)).toBe('forward');
  });
  it('down: internal while below bottom, else forward', () => {
    expect(scrollDecision(5, 20, 1)).toBe('internal');
    expect(scrollDecision(20, 20, 1)).toBe('forward');
  });
});

describe('viewportAtTop', () => {
  it('trusts the clamped DOM edge over xterm row rounding', () => {
    expect(viewportAtTop(1, 0)).toBe(true);
    expect(viewportAtTop(0, 4)).toBe(false);
    expect(viewportAtTop(0, undefined)).toBe(true);
  });
});

describe('topTarget', () => {
  it('puts the cursor on the first visible row, clamped to [0, baseY]', () => {
    expect(topTarget(50, 100)).toBe(50);
    expect(topTarget(-3, 100)).toBe(0);
    expect(topTarget(200, 100)).toBe(100);
  });
});

describe('cursorBufferLine', () => {
  it('counts up from the content bottom; null when hidden', () => {
    expect(cursorBufferLine({ row: 0, col: 0, vis: true }, 30)).toBe(29);
    expect(cursorBufferLine({ row: 5, col: 0, vis: true }, 30)).toBe(24);
    expect(cursorBufferLine({ row: 0, col: 0, vis: false }, 30)).toBe(null);
    expect(cursorBufferLine(null, 30)).toBe(null);
  });
});

describe('bottomPadRows', () => {
  it('rows to prepend so content sits at the grid bottom', () => {
    expect(bottomPadRows(6, 15)).toBe(9);
    expect(bottomPadRows(20, 15)).toBe(0);
  });
});

describe('followTarget (scroll into view, nearest edge)', () => {
  const base = { visibleRows: 20, baseY: 100 };
  it('null when not armed', () => {
    expect(followTarget({ cursorLine: 90, viewportY: 0, armed: false, ...base })).toBe(null);
  });
  it('null when the cursor is still in the visible window', () => {
    expect(followTarget({ cursorLine: 10, viewportY: 0, armed: true, ...base })).toBe(null);
    expect(followTarget({ cursorLine: 70, viewportY: 60, armed: true, ...base })).toBe(null);
  });
  it('below the window → bottom-align (last visible row = cursor)', () => {
    expect(followTarget({ cursorLine: 90, viewportY: 0, armed: true, ...base })).toBe(71);
  });
  it('above the window → top-align (first visible row = cursor)', () => {
    expect(followTarget({ cursorLine: 5, viewportY: 60, armed: true, ...base })).toBe(5);
  });
});

describe('bottomTarget', () => {
  it('puts the cursor on the bottom visible row, clamped to [0, baseY]', () => {
    expect(bottomTarget(90, 20, 100)).toBe(71);
    expect(bottomTarget(5, 20, 100)).toBe(0);
    expect(bottomTarget(200, 20, 100)).toBe(100);
  });
});
