import { describe, it, expect } from 'vitest';
import {
  keyboardSwipeAction,
  shouldKeepKeyboard,
  rubberBand,
  composerAbsorbsScroll,
  type ComposerScrollState,
} from '../src/dockKeyboard.js';

describe('rubberBand', () => {
  it('follows at slope c for small pulls', () => {
    expect(rubberBand(2, 44, 0.5)).toBeCloseTo(1, 1);
  });
  it('never reaches or overshoots max, however hard you pull', () => {
    expect(rubberBand(1e6, 44, 0.5)).toBeLessThan(44);
    expect(rubberBand(1e6, 44, 0.5)).toBeGreaterThan(43);
  });
  it('resistance grows toward the end — each further pull adds less travel, but never zero', () => {
    const a = rubberBand(50) - rubberBand(25);
    const b = rubberBand(200) - rubberBand(175);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(0);
  });
  it('is symmetric and zero at rest', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-30)).toBeCloseTo(-rubberBand(30), 6);
  });
});

describe('keyboardSwipeAction', () => {
  it('a vertical drag UP past the threshold shows the keyboard', () => {
    expect(keyboardSwipeAction(2, -40)).toBe('show');
  });
  it('a vertical drag DOWN past the threshold hides the keyboard', () => {
    expect(keyboardSwipeAction(-3, 40)).toBe('hide');
  });
  it('a horizontal-dominant drag is not a keyboard gesture (page swipe owns it)', () => {
    expect(keyboardSwipeAction(50, -40)).toBeNull();
  });
  it('a too-short vertical drag does not commit', () => {
    expect(keyboardSwipeAction(0, -10)).toBeNull();
    expect(keyboardSwipeAction(0, 10)).toBeNull();
  });
  it('respects a custom threshold', () => {
    expect(keyboardSwipeAction(0, -30, 50)).toBeNull();
    expect(keyboardSwipeAction(0, -60, 50)).toBe('show');
  });
});

describe('composerAbsorbsScroll', () => {
  const state = (scrollTop: number, scrollHeight: number, clientHeight = 156): ComposerScrollState => (
    { scrollTop, scrollHeight, clientHeight }
  );
  it('a non-scrollable draft never absorbs — the keyboard gesture owns vertical', () => {
    expect(composerAbsorbsScroll(state(0, 44), -30)).toBe(false);
    expect(composerAbsorbsScroll(state(0, 156), 30)).toBe(false);
  });
  it('a mid-scrolled draft absorbs BOTH directions (still room either way)', () => {
    expect(composerAbsorbsScroll(state(100, 400), -30)).toBe(true);
    expect(composerAbsorbsScroll(state(100, 400), 30)).toBe(true);
  });
  it('at the BOTTOM edge, a further UP drag falls off to the keyboard (does not absorb)', () => {
    expect(composerAbsorbsScroll(state(244, 400), -30)).toBe(false);
    expect(composerAbsorbsScroll(state(244, 400), 30)).toBe(true);
  });
  it('at the TOP edge, a further DOWN drag falls off to the keyboard (does not absorb)', () => {
    expect(composerAbsorbsScroll(state(0, 400), 30)).toBe(false);
    expect(composerAbsorbsScroll(state(0, 400), -30)).toBe(true);
  });
  it('no composer (gesture began elsewhere) never absorbs', () => {
    expect(composerAbsorbsScroll(null, -30)).toBe(false);
  });
});

describe('shouldKeepKeyboard', () => {
  const element = (tag: 'input' | 'textarea' | 'div', className = '') => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  it('keeps focus when a text input holds it (command capture)', () => {
    expect(shouldKeepKeyboard(element('input'))).toBe(true);
  });
  it('keeps focus when the chat composer (textarea) holds it', () => {
    expect(shouldKeepKeyboard(element('textarea'))).toBe(true);
  });
  it('does NOT pin on xterm\'s own hidden helper textarea', () => {
    expect(shouldKeepKeyboard(element('textarea', 'xterm'))).toBe(false);
  });
  it('does NOT pin on a non-input element or nothing', () => {
    expect(shouldKeepKeyboard(element('div'))).toBe(false);
    expect(shouldKeepKeyboard(null)).toBe(false);
  });
});
