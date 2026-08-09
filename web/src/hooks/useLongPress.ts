import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

// Detect a long-press without breaking a normal tap. Pointer events ONLY (never touch+mouse
// together — see the KeyBar/Dock note in CLAUDE.md): one pointer stream = one gesture. A press
// held past HOLD_MS fires onLongPress and suppresses the click that the browser emits afterward;
// a short tap falls through to onClick; a finger move past MOVE_PX cancels the press (the window
// bar scrolls horizontally, so a swipe is a scroll, not a long-press).
//
// Wire BOTH onClick (the normal tap action) and the pointer handlers: a raw click with no
// preceding long-press still selects, so a plain click event (e.g. in tests, or assistive tech)
// keeps working.
const HOLD_MS = 500;
const MOVE_PX = 10;

interface Point { x: number; y: number }

export interface LongPressOptions<T extends Element> {
  onClick?: (event: ReactMouseEvent<T>) => void;
}

export interface LongPressHandlers<T extends Element> {
  onPointerDown: (event: ReactPointerEvent<T>) => void;
  onPointerMove: (event: ReactPointerEvent<T>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClick: (event: ReactMouseEvent<T>) => void;
}

export function useLongPress<T extends Element = HTMLElement>(
  onLongPress?: () => void,
  { onClick }: LongPressOptions<T> = {},
): LongPressHandlers<T> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<Point | null>(null); // pointer-down position
  const fired = useRef(false); // a long-press fired → swallow the next click

  const clear = (): void => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  };
  useEffect(() => clear, []);

  return {
    onPointerDown: (event) => {
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress?.();
      }, HOLD_MS);
    },
    onPointerMove: (event) => {
      if (timer.current === null || !start.current) return;
      if (Math.abs(event.clientX - start.current.x) > MOVE_PX ||
          Math.abs(event.clientY - start.current.y) > MOVE_PX) {
        clear();
      }
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onClick: (event) => {
      if (fired.current) { // the click that follows a fired long-press — eat it
        fired.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event);
    },
  };
}
