import type { MutableRefObject } from 'react';
import { scrollPane, sendKeys } from './api.js';
import { shouldKeepKeyboard } from './dockKeyboard.js';
import { drainWheel, notchDir } from './wheelScroll.js';
import { flingStep, shouldFling } from './momentum.js';
import { scrollDecision } from './terminalViewport.js';
import { setFont } from './storage.js';
import type { TerminalSelectionController } from './terminalSelectionController.js';

const WHEEL_PX = 22;
const FORWARDED_WHEEL_PX = 12;

interface TouchTerminal {
  options: { fontSize?: number };
  readonly rows: number;
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } };
  getSelection(): string;
  scrollToLine(target: number): void;
}

export interface TerminalTouchController {
  freezeHistoryGesture(): void;
  settleHistoryAnchor(target: number): void;
  dispose(): void;
}

export interface TerminalTouchControllerOptions {
  term: TouchTerminal;
  host: HTMLElement;
  desktop: boolean;
  pane: string;
  fontRef: MutableRefObject<number | null>;
  selection: Pick<TerminalSelectionController, 'start' | 'extend' | 'refresh' | 'clear'>;
  selectionActiveRef: MutableRefObject<boolean>;
  stopFlingRef: MutableRefObject<(() => void) | null>;
  getStreamExact: () => boolean;
  getAltScreen: () => boolean;
  getMouseAware: () => boolean;
  onActivity: () => void;
  onUserScroll: () => void;
  showScrollPosition: () => void;
  maybePullMore: () => void;
  enterStreamHistory?: (distance: number) => boolean | void;
  scheduleFit: () => void;
  wake: () => void;
  onTap: () => void;
  onKeepKeyboard?: () => boolean;
}

export function createTerminalTouchController({
  term,
  host,
  desktop,
  pane,
  fontRef,
  selection,
  selectionActiveRef,
  stopFlingRef,
  getStreamExact,
  getAltScreen,
  getMouseAware,
  onActivity,
  onUserScroll,
  showScrollPosition,
  maybePullMore,
  enterStreamHistory,
  scheduleFit,
  wake,
  onTap,
  onKeepKeyboard,
}: TerminalTouchControllerOptions): TerminalTouchController {
  const buffer = () => term.buffer.active;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let axis: -1 | 0 | 1 = 0;
  let pinching = false;
  let initialPinchDistance = 0;
  let initialPinchFont = 0;
  let selecting = false;
  let selectionOnDown = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMoveX = 0;
  let lastMoveY = 0;
  let lastMoveTime = 0;
  let scrollVelocityX = 0;
  let scrollVelocityY = 0;
  let touchActive = false;
  let historyPullFrozen = false;
  let flingRAF: number | null = null;
  let wheelAccum = 0;
  let wheelPreviousY = 0;
  let wheelPending = 0;
  let wheelBusy = false;
  let historyAnchorSettling = false;
  let historyAnchorRAF: number | null = null;
  const liveViewport = () => (
    host.querySelector<HTMLElement>('.terminal__live .xterm-viewport')
      || host.querySelector<HTMLElement>('.xterm-viewport')
  );

  const cancelLongPress = (): void => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  const touchDistance = (touches: TouchList): number => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
  const stopFling = (): void => {
    if (flingRAF != null) {
      cancelAnimationFrame(flingRAF);
      flingRAF = null;
    }
  };
  stopFlingRef.current = stopFling;
  const startFling = (
    element: HTMLElement | null,
    property: 'scrollLeft' | 'scrollTop',
    initialVelocity: number,
  ): void => {
    if (!element) return;
    let velocity = initialVelocity;
    let previousTime: number | null = null;
    const frame = (time: number): void => {
      if (previousTime == null) {
        previousTime = time;
        flingRAF = requestAnimationFrame(frame);
        return;
      }
      const step = flingStep(velocity, time - previousTime);
      previousTime = time;
      velocity = step.v;
      const before = element[property];
      element[property] = before + step.delta;
      const hitEdge = Math.abs(step.delta) >= 1 && element[property] === before;
      if (property === 'scrollTop') {
        showScrollPosition();
        maybePullMore();
      }
      if (step.done || hitEdge || flingRAF == null) {
        flingRAF = null;
        return;
      }
      flingRAF = requestAnimationFrame(frame);
    };
    flingRAF = requestAnimationFrame(frame);
  };

  const flushWheel = async (): Promise<void> => {
    if (wheelBusy || wheelPending === 0) return;
    wheelBusy = true;
    const direction = notchDir(wheelPending);
    const count = Math.min(Math.abs(wheelPending), 40);
    wheelPending = 0;
    try {
      if (getMouseAware()) await scrollPane(pane, direction, count);
      else await sendKeys(pane, Array(count).fill(direction === 'up' ? 'Up' : 'Down'));
      wake();
    } catch {
      // A later gesture can retry after a transient network failure.
    } finally {
      wheelBusy = false;
      if (wheelPending !== 0) void flushWheel();
    }
  };

  const onTouchStart = (event: TouchEvent): void => {
    onActivity();
    cancelLongPress();
    stopFling();
    touchActive = event.touches.length > 0;
    historyPullFrozen = false;
    selectionOnDown = selectionActiveRef.current;
    selecting = false;
    if (event.touches.length === 2) {
      pinching = true;
      axis = -1;
      initialPinchDistance = touchDistance(event.touches);
      initialPinchFont = term.options.fontSize || 14;
      return;
    }
    pinching = false;
    if (event.touches.length !== 1) {
      axis = -1;
      return;
    }
    const liveSurface = host.querySelector<HTMLElement>('.terminal__live');
    if (getStreamExact() && !getAltScreen() && liveSurface
      && event.touches[0].clientY < liveSurface.getBoundingClientRect().top) {
      enterStreamHistory?.(0);
    }
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    startLeft = host.scrollLeft;
    axis = 0;
    lastMoveX = startX;
    lastMoveY = startY;
    lastMoveTime = event.timeStamp;
    scrollVelocityX = 0;
    scrollVelocityY = 0;
    wheelPreviousY = startY;
    wheelAccum = 0;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      selecting = true;
      axis = -1;
      selection.start(startX, startY);
    }, 500);
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (pinching && event.touches.length === 2) {
      if (initialPinchDistance > 0) {
        const fontSize = Math.max(8, Math.min(
          40,
          Math.round(initialPinchFont * (touchDistance(event.touches) / initialPinchDistance)),
        ));
        if (fontSize !== (term.options.fontSize || 14)) {
          term.options.fontSize = fontSize;
          fontRef.current = fontSize;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (selecting && event.touches.length === 1) {
      selection.extend(event.touches[0].clientX, event.touches[0].clientY);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cancelLongPress();
    if (axis === 0) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 1 : -1;
    }
    if (axis === 1) {
      host.scrollLeft = startLeft - dx;
      const x = event.touches[0].clientX;
      const elapsed = event.timeStamp - lastMoveTime;
      if (elapsed > 0) scrollVelocityX = (lastMoveX - x) / elapsed;
      lastMoveX = x;
      lastMoveTime = event.timeStamp;
      event.preventDefault();
      // Axis-locked horizontal gesture: Handmux owns scrollLeft, so xterm must not also consume the
      // gesture's small vertical noise. Browser gesture takeover is blocked up front by touch-action:none.
      event.stopPropagation();
      return;
    }

    // A history pull rewrites xterm's buffer and then restores the old content anchor. If the same
    // finger remains down, xterm's next touchmove can immediately overwrite that restored scrollTop
    // against the expanded buffer, occasionally landing at the new page's far edge. Once this gesture
    // starts a pull, hold it still until touchend; the next deliberate gesture continues normally.
    if (historyPullFrozen) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    showScrollPosition();
    maybePullMore();
    if (historyPullFrozen) {
      scrollVelocityY = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const y = event.touches[0].clientY;
    const stepY = y - wheelPreviousY;
    wheelPreviousY = y;
    if (getStreamExact()) {
      event.preventDefault();
      event.stopPropagation();
      const before = host.scrollTop;
      host.scrollTop -= stepY;
      if (host.scrollTop !== before) {
        onUserScroll();
        return;
      }
      if (!getAltScreen()) {
        if (stepY > 0) enterStreamHistory?.(stepY);
        return;
      }
    }
    if (getAltScreen()) {
      event.preventDefault();
      event.stopPropagation();
      const viewport = liveViewport();
      const direction = stepY > 0 ? -1 : 1;
      if (viewport && scrollDecision(
        buffer().viewportY,
        buffer().baseY,
        direction,
      ) === 'internal') {
        viewport.scrollTop -= stepY;
        onUserScroll();
        return;
      }
      const drained = drainWheel(wheelAccum + stepY, FORWARDED_WHEEL_PX);
      wheelAccum = drained.rem;
      if (drained.notches) {
        wheelPending += drained.notches;
        void flushWheel();
      }
      return;
    }
    const elapsed = event.timeStamp - lastMoveTime;
    if (elapsed > 0) scrollVelocityY = (lastMoveY - y) / elapsed;
    lastMoveY = y;
    lastMoveTime = event.timeStamp;
  };

  const onTouchEnd = (event: TouchEvent): void => {
    cancelLongPress();
    const ended = event.touches.length === 0;
    if (ended) touchActive = false;
    if (selecting && event.touches.length === 0) {
      selecting = false;
      const text = term.getSelection();
      if (text && text.trim()) selection.refresh();
      else selection.clear();
      historyPullFrozen = false;
      return;
    }
    if (pinching && event.touches.length < 2) {
      pinching = false;
      setFont(term.options.fontSize || 14);
      scheduleFit();
      if (ended) historyPullFrozen = false;
      return;
    }
    if (ended && !historyPullFrozen && shouldFling(
      axis === 1 ? scrollVelocityX : scrollVelocityY,
      event.timeStamp - lastMoveTime,
    )) {
      if (axis === 1) startFling(host, 'scrollLeft', scrollVelocityX);
      else if (axis === -1) {
        startFling(getStreamExact() ? host : liveViewport(), 'scrollTop', scrollVelocityY);
      }
    }
    if (event.touches.length === 0 && !selecting && !pinching && axis === 0) {
      if (selectionOnDown) selection.clear();
      else onTap();
    }
    if (ended) historyPullFrozen = false;
  };

  const onWheel = (event: WheelEvent): void => {
    // A horizontal trackpad swipe usually contains a little deltaY noise. Claim horizontal-dominant
    // gestures before xterm treats that noise as vertical scroll and cancels ancestor panning.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && host.scrollWidth > host.clientWidth) {
      const pixels = event.deltaMode === 1
        ? event.deltaX * WHEEL_PX
        : event.deltaMode === 2
          ? event.deltaX * host.clientWidth
          : event.deltaX;
      host.scrollLeft += pixels;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!event.deltaY) return;
    if (getStreamExact()) {
      const before = host.scrollTop;
      host.scrollTop += event.deltaY;
      if (host.scrollTop !== before) {
        event.preventDefault();
        event.stopPropagation();
        onUserScroll();
        return;
      }
      if (!getAltScreen() && event.deltaY < 0 && enterStreamHistory?.(-event.deltaY)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!getAltScreen()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (getAltScreen()) {
      event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaMode === 1
        ? event.deltaY * WHEEL_PX
        : event.deltaMode === 2
          ? event.deltaY * term.rows * WHEEL_PX
          : event.deltaY;
      const drained = drainWheel(wheelAccum - pixels, WHEEL_PX);
      wheelAccum = drained.rem;
      if (drained.notches) {
        wheelPending += drained.notches;
        void flushWheel();
      }
      return;
    }
    // xterm expands its logical buffer before its DOM viewport synchronizes scrollTop on the next frame.
    // A wheel event in that gap writes the old scrollTop=0 back and jumps exactly one loaded page.
    if (historyAnchorSettling) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    showScrollPosition();
    maybePullMore();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (desktop) {
      const liveSurface = host.querySelector<HTMLElement>('.terminal__live');
      if (getStreamExact() && !getAltScreen() && liveSurface
        && event.clientY < liveSurface.getBoundingClientRect().top) {
        enterStreamHistory?.(0);
      }
      onTap();
      return;
    }
    // One common rule for every terminal gesture axis: if the dock field still owns the keyboard, or the
    // physical keyboard is open but focus drifted, restore/keep that field before the browser's default
    // pointer action can collapse it. A clean tap still dismisses explicitly in onTouchEnd; drags keep it.
    const keepKeyboard = shouldKeepKeyboard(document.activeElement) || onKeepKeyboard?.();
    if (keepKeyboard && event.cancelable) event.preventDefault();
  };

  host.addEventListener('pointerdown', onPointerDown, { capture: true });
  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

  return {
    freezeHistoryGesture() {
      if (touchActive && axis === -1) {
        historyPullFrozen = true;
        scrollVelocityY = 0;
      }
      stopFling();
    },
    settleHistoryAnchor(target) {
      historyAnchorSettling = true;
      if (historyAnchorRAF != null) cancelAnimationFrame(historyAnchorRAF);
      term.scrollToLine(target);
      historyAnchorRAF = requestAnimationFrame(() => {
        // xterm's buffer-size sync runs first. Reassert the anchor and keep the guard through its DOM event.
        term.scrollToLine(target);
        historyAnchorRAF = requestAnimationFrame(() => {
          historyAnchorRAF = null;
          historyAnchorSettling = false;
        });
      });
    },
    dispose() {
      cancelLongPress();
      stopFling();
      if (historyAnchorRAF != null) cancelAnimationFrame(historyAnchorRAF);
      host.removeEventListener('pointerdown', onPointerDown, { capture: true });
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('touchstart', onTouchStart, { capture: true });
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd, { capture: true });
    },
  };
}
