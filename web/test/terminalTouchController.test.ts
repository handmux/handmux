import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalTouchController,
  type TerminalTouchController,
} from '../src/terminalTouchController.js';

const touchEvent = (type: string, y: number, touches = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: touches ? [{ clientX: 100, clientY: y }] : [],
  });
  return event;
};

function setup() {
  const host = document.createElement('div');
  const live = document.createElement('div');
  live.className = 'terminal__live';
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  live.append(viewport, screen);
  host.append(live);
  document.body.append(host);

  const term = {
    options: { fontSize: 14 },
    rows: 24,
    buffer: { active: { viewportY: 0, baseY: 300 } },
    getSelection: () => '',
    scrollToLine: vi.fn(),
  };
  let controller!: TerminalTouchController;
  const maybePullMore = vi.fn(() => controller.freezeHistoryGesture());
  controller = createTerminalTouchController({
    term,
    host,
    desktop: false,
    pane: '%1',
    fontRef: { current: null as number | null },
    selection: {
      start: vi.fn(),
      extend: vi.fn(),
      refresh: vi.fn(),
      clear: vi.fn(),
    },
    selectionActiveRef: { current: false },
    stopFlingRef: { current: null },
    getStreamExact: () => false,
    getAltScreen: () => false,
    getMouseAware: () => false,
    onActivity: vi.fn(),
    onUserScroll: vi.fn(),
    showScrollPosition: vi.fn(),
    maybePullMore,
    enterStreamHistory: vi.fn(),
    scheduleFit: vi.fn(),
    wake: vi.fn(),
    onTap: vi.fn(),
    onKeepKeyboard: vi.fn(),
  });
  return { controller, host, screen, maybePullMore };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('terminal touch history pull', () => {
  it('freezes the triggering drag until touchend so xterm cannot overwrite the restored anchor', () => {
    const { controller, screen, maybePullMore } = setup();
    const reachedXterm = vi.fn();
    screen.addEventListener('touchmove', reachedXterm);

    screen.dispatchEvent(touchEvent('touchstart', 100));
    const triggeringMove = touchEvent('touchmove', 130);
    screen.dispatchEvent(triggeringMove);
    screen.dispatchEvent(touchEvent('touchmove', 170));

    expect(maybePullMore).toHaveBeenCalledOnce();
    expect(triggeringMove.defaultPrevented).toBe(true);
    expect(reachedXterm).not.toHaveBeenCalled();

    screen.dispatchEvent(touchEvent('touchend', 170, 0));
    maybePullMore.mockImplementation(() => {});
    screen.dispatchEvent(touchEvent('touchstart', 170));
    screen.dispatchEvent(touchEvent('touchmove', 200));

    expect(reachedXterm).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('never blocks continuous wheel scrolling', () => {
    const { controller, screen, maybePullMore } = setup();
    const reachedXterm = vi.fn();
    screen.addEventListener('wheel', reachedXterm);

    const first = new WheelEvent('wheel', {
      deltaY: -40, bubbles: true, cancelable: true,
    });
    screen.dispatchEvent(first);
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -40, bubbles: true, cancelable: true,
    }));

    expect(maybePullMore).toHaveBeenCalledTimes(2);
    expect(first.defaultPrevented).toBe(false);
    expect(reachedXterm).toHaveBeenCalledTimes(2);

    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -40, bubbles: true, cancelable: true,
    }));

    expect(maybePullMore).toHaveBeenCalledTimes(3);
    expect(reachedXterm).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it('blocks only the two-frame DOM sync boundary after restoring a history anchor', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const { controller, screen } = setup();
    const reachedXterm = vi.fn();
    screen.addEventListener('wheel', reachedXterm);

    controller.settleHistoryAnchor(100);
    const dispatchWheel = () => {
      const event = new WheelEvent('wheel', {
        deltaY: -1, bubbles: true, cancelable: true,
      });
      screen.dispatchEvent(event);
      return event;
    };

    expect(dispatchWheel().defaultPrevented).toBe(true);
    expect(reachedXterm).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(dispatchWheel().defaultPrevented).toBe(true);
    expect(reachedXterm).not.toHaveBeenCalled();
    frames.shift()!(16);
    expect(dispatchWheel().defaultPrevented).toBe(false);
    expect(reachedXterm).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
