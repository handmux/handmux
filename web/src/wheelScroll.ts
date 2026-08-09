// Pure helper for alt-screen swipe-to-scroll (DOM-free, unit-tested on its own). A full-screen app on the
// alternate screen has no scrollback the client can move, so a vertical drag is forwarded to the app as
// mouse-wheel notches instead (the server injects them — see commands.sendWheel). This module owns the one
// bug-prone bit: turning accumulated finger travel into whole notches with the right direction.

// Drain accumulated vertical finger travel (px) into whole wheel notches, carrying the sub-notch remainder
// forward so a slow drag still scrolls smoothly across many samples. `unitPx` is the travel per notch.
//   finger DOWN  (travel > 0) reveals EARLIER content → wheel 'up'   → +1 notch
//   finger UP    (travel < 0) reveals LATER   content → wheel 'down' → −1 notch
// Returns { notches, rem }: `notches` is the SIGNED count to emit now (+ = up), `rem` the leftover px.
export interface DrainedWheel {
  notches: number;
  rem: number;
}

export type WheelDirection = 'up' | 'down';

export function drainWheel(travelPx: number, unitPx: number): DrainedWheel {
  let notches = 0;
  let rem = travelPx;
  while (Math.abs(rem) >= unitPx) {
    if (rem > 0) { notches += 1; rem -= unitPx; }
    else { notches -= 1; rem += unitPx; }
  }
  return { notches, rem };
}

// Map a signed notch count to the wheel direction the /scroll API expects.
export const notchDir = (signedNotches: number): WheelDirection => (
  signedNotches > 0 ? 'up' : 'down'
);
