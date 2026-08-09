import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void> | void;
}

interface WakeLockNavigator {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

// Keep the screen awake while `active` is true (e.g. during voice capture) so the phone doesn't dim
// or lock mid-dictation. Uses the Screen Wake Lock API (iOS Safari 16.4+, Chrome/Android); a no-op
// where unsupported. The OS auto-releases the lock when the page is hidden, so we re-acquire on
// visibilitychange whenever we come back to the foreground and are still active.
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    const wakeLock = (navigator as unknown as WakeLockNavigator).wakeLock;
    if (!active || !wakeLock) return undefined;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async (): Promise<void> => {
      try {
        const s = await wakeLock.request('screen');
        if (cancelled) {
          try { await s.release(); } catch { /* ignore */ }
          return;
        }
        sentinel = s;
      } catch { /* denied / battery saver / lost gesture — let the screen behave normally */ }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && !cancelled) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) void Promise.resolve(sentinel.release()).catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
