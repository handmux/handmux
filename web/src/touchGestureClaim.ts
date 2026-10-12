// Native-scroll cancellation is not ownership: the page guard also calls preventDefault.
// Only a handler actually taking over a touch event marks it. Weak storage does not retain events.
const claimedEvents = new WeakSet<Event>();

export function claimTouchGesture(event: TouchEvent): void {
  claimedEvents.add(event);
  event.preventDefault();
}

export function isTouchGestureClaimed(event: TouchEvent): boolean {
  return claimedEvents.has(event);
}
