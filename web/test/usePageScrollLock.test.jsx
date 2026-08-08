import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { usePageScrollLock } from '../src/hooks/usePageScrollLock.js';

afterEach(cleanup);

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

function Harness() {
  usePageScrollLock();
  return <div data-testid="scroller" style={{ overflowY: 'auto' }}><div /></div>;
}

function setGeometry(el, { scrollTop, scrollHeight = 1000, clientHeight = 200 }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

function touch(el, type, x, y) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    configurable: true,
    value: [{ clientX: x, clientY: y }],
  });
  el.dispatchEvent(event);
  return event;
}

describe('usePageScrollLock', () => {
  it('contains native overscroll at the conversation boundary', () => {
    expect(styles).toMatch(/\.chat-scroll\s*\{[^}]*overscroll-behavior-y:\s*contain/);
  });

  it('allows an internal vertical scroll while that direction still has room', () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId('scroller');
    setGeometry(el, { scrollTop: 400 });

    touch(el, 'touchstart', 20, 100);
    expect(touch(el, 'touchmove', 20, 70).defaultPrevented).toBe(false);
  });

  it('blocks page-pan when an upward drag reaches the scrollable bottom edge', () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId('scroller');
    setGeometry(el, { scrollTop: 400 });

    touch(el, 'touchstart', 20, 100);
    expect(touch(el, 'touchmove', 20, 70).defaultPrevented).toBe(false);
    el.scrollTop = 800;
    expect(touch(el, 'touchmove', 20, 50).defaultPrevented).toBe(true);
  });

  it('blocks page-pan when a downward drag starts at the scrollable top edge', () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId('scroller');
    setGeometry(el, { scrollTop: 0 });

    touch(el, 'touchstart', 20, 100);
    expect(touch(el, 'touchmove', 20, 130).defaultPrevented).toBe(true);
  });

  it('uses the current direction when a gesture reverses at an edge', () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId('scroller');
    setGeometry(el, { scrollTop: 800 });

    touch(el, 'touchstart', 20, 100);
    expect(touch(el, 'touchmove', 20, 60).defaultPrevented).toBe(true);
    expect(touch(el, 'touchmove', 20, 70).defaultPrevented).toBe(false);
  });
});
