// Auto-repeat for held keys: fire once immediately, then (after a short delay so a quick
// tap stays a single press) repeat at a fixed interval until stop(). DOM-free for testing.
export interface Repeater {
  start(): void;
  stop(): void;
}

export function createRepeater(
  fn: () => void,
  { delay = 400, interval = 120 }: { delay?: number; interval?: number } = {},
): Repeater {
  let to: ReturnType<typeof setTimeout> | null = null;
  let iv: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (to) clearTimeout(to);
    if (iv) clearInterval(iv);
    to = null;
    iv = null;
  };
  const start = () => {
    stop();
    fn();
    to = setTimeout(() => { iv = setInterval(fn, interval); }, delay);
  };
  return { start, stop };
}
