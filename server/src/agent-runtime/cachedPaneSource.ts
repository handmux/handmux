import type { LivePane, ReadonlyPaneSource } from './adapter.js';

// A pane list that may be up to `maxAgeMs` old, shared by background pollers that only need recent pane
// presence: every `tmux list-panes` is a process spawn, and the Hook Bridge (250ms) and native Inbox
// (500ms) pollers would otherwise each spawn one per tick. Anything that acts on a pane (sending, deleting
// scheduled data, Codex restart) must keep reading the underlying source directly.
//
// Concurrent callers share one in-flight read. A failed read is never cached and an expired list is never
// served, so a tmux failure surfaces once the current list expires. Every caller gets its own copy.
export function cachedPaneSource(
  source: ReadonlyPaneSource,
  maxAgeMs: number,
  now: () => number = Date.now,
): ReadonlyPaneSource {
  if (!source || typeof source.list !== 'function' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('Cached pane source requires a pane source and a non-negative max age');
  }
  let cached: { panes: readonly LivePane[]; readAt: number } | undefined;
  let inFlight: Promise<readonly LivePane[]> | undefined;

  // A negative age means the wall clock stepped back: treat the list as expired rather than serving it
  // until the clock catches up.
  const isFresh = ({ readAt }: { readAt: number }): boolean => {
    const age = now() - readAt;
    return age >= 0 && age < maxAgeMs;
  };

  const read = (): Promise<readonly LivePane[]> => {
    if (!inFlight) {
      // Age counts from when the read started: that is the moment the list describes.
      const readAt = now();
      inFlight = source.list().then((panes) => {
        cached = { panes, readAt };
        return panes;
      }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };

  return {
    async list() {
      const current = cached && isFresh(cached) ? cached.panes : await read();
      return structuredClone(current);
    },
    subscribe: (listener) => source.subscribe(listener),
  };
}
