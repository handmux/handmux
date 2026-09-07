const FAST_WINDOW_MS = 30_000;
const FAST_INTERVAL_MS = 400;
const SLOW_INTERVAL_MS = 2_000;

export function conversationDiscoveryInterval(startedAt: number, now = Date.now()): number {
  return now - startedAt < FAST_WINDOW_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

export function waitForConversationDiscovery(
  startedAt: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = window.setTimeout(finish, conversationDiscoveryInterval(startedAt));
    signal.addEventListener('abort', abort, { once: true });
  });
}
