import { useEffect, useRef, useState } from 'react';
import { streamCodexMessages, UnauthorizedError } from '../api.js';

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4_000;

interface CodexStreamEventLike {
  type?: string;
  threadId?: string;
  turnId?: string | null;
  itemId?: string | null;
  cursor?: number;
  sequence?: number;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

// The SSE connection owns only cursor/reconnect transport. Server-projected mutations are forwarded into
// useTranscript's single message store; a broken/backgrounded mobile connection retries without a second
// live-message cache.
export function useCodexMessageStream({
  pane, threadId, enabled, onEvent, onSettled, onAuthFail,
}: {
  pane?: string | null;
  threadId?: string | null;
  enabled: boolean;
  onEvent?: (event: CodexStreamEventLike) => void;
  onSettled?: () => void;
  onAuthFail?: () => void;
}): void {
  const scope = enabled && pane && threadId ? `${pane}\0${threadId}` : null;
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const lastSequenceRef = useRef(-1);
  const onEventRef = useRef<((event: CodexStreamEventLike) => void) | undefined>(onEvent);
  const onSettledRef = useRef<(() => void) | undefined>(onSettled);
  const onAuthFailRef = useRef<(() => void) | undefined>(onAuthFail);
  const streamControllerRef = useRef<AbortController | null>(null);
  const lastForegroundWakeRef = useRef(0);
  onEventRef.current = onEvent;
  onSettledRef.current = onSettled;
  onAuthFailRef.current = onAuthFail;

  useEffect(() => {
    lastSequenceRef.current = -1;
  }, [scope]);

  useEffect(() => {
    if (!scope || !pane || !threadId) return undefined;
    const wake = () => {
      if (document.hidden) return;
      const now = Date.now();
      // One app return can report visibilitychange, focus and pageshow back-to-back. Reconnect once.
      if (now - lastForegroundWakeRef.current < 100) return;
      lastForegroundWakeRef.current = now;
      setConnectionEpoch((value) => value + 1);
    };
    const onVisibility = () => {
      if (document.hidden) {
        lastForegroundWakeRef.current = 0;
        streamControllerRef.current?.abort();
      }
      else wake();
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) wake(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [scope]);

  useEffect(() => {
    if (!scope || !pane || !threadId) return undefined;
    const controller = new AbortController();
    streamControllerRef.current = controller;
    let retryMs = RETRY_MIN_MS;
    const onEvent = (event: CodexStreamEventLike) => {
      if (event?.threadId && event.threadId !== threadId) return;
      if (event?.type === 'cursorReset') {
        lastSequenceRef.current = typeof event.cursor === 'number' && Number.isSafeInteger(event.cursor)
          ? event.cursor : -1;
        onSettledRef.current?.();
      } else if (typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence)) {
        const { sequence } = event;
        if (sequence <= lastSequenceRef.current) return;
        if (lastSequenceRef.current >= 0 && sequence > lastSequenceRef.current + 1) {
          onSettledRef.current?.();
        }
        lastSequenceRef.current = sequence;
      }
      if (['completed', 'turnCompleted', 'goal'].includes(event.type ?? '')) onSettledRef.current?.();
      onEventRef.current?.(event);
    };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamCodexMessages(pane, {
            signal: controller.signal,
            onEvent,
            after: lastSequenceRef.current >= 0 ? lastSequenceRef.current : null,
          });
          retryMs = RETRY_MIN_MS;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error instanceof UnauthorizedError) {
            onAuthFailRef.current?.();
            break;
          }
        }
        await abortableDelay(retryMs, controller.signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    };
    void run();
    return () => {
      controller.abort();
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
    };
  }, [scope, pane, threadId, connectionEpoch]);
}
