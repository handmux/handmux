import { useEffect, useRef, useState } from 'react';
import { streamCodexMessages, UnauthorizedError } from '../api.js';

const MAX_LIVE_MESSAGES = 20;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4_000;

function eventKey(event) {
  return event?.turnId && event?.itemId ? `${event.turnId}:${event.itemId}` : null;
}

export function applyCodexStreamEvent(messages, event, afterK = -1) {
  if (!event || !['started', 'snapshot', 'delta', 'completed', 'turnCompleted'].includes(event.type)) {
    return messages;
  }
  if (event.type === 'turnCompleted') {
    let changed = false;
    const next = messages.map((message) => {
      if (message.turnId !== event.turnId || message.completed) return message;
      changed = true;
      return { ...message, completed: true, streaming: false };
    });
    return changed ? next : messages;
  }

  const key = eventKey(event);
  if (!key) return messages;
  const index = messages.findIndex((message) => message.streamKey === key);
  const previous = index >= 0 ? messages[index] : null;
  const text = event.type === 'delta'
    ? `${previous?.text || ''}${event.delta || ''}`
    : (typeof event.text === 'string' ? event.text : previous?.text || '');
  const completed = event.type === 'completed' || event.completed === true || previous?.completed === true;
  const nextMessage = {
    ...(previous || {}),
    id: `codex-stream:${key}`,
    streamKey: key,
    turnId: event.turnId,
    itemId: event.itemId,
    role: 'assistant',
    type: 'text',
    text,
    live: true,
    streaming: !completed,
    completed,
    afterK: previous?.afterK ?? afterK,
  };
  const next = index >= 0
    ? messages.map((message, candidate) => (candidate === index ? nextMessage : message))
    : [...messages, nextMessage];
  return next.slice(-MAX_LIVE_MESSAGES);
}

export function durableCoversLiveMessage(durableMessages, liveMessage) {
  if (!liveMessage?.completed || !liveMessage.text) return false;
  return durableMessages.some((message) => message?.role === 'assistant' && message.type === 'text'
    && Number(message.k) > Number(liveMessage.afterK ?? -1) && message.text === liveMessage.text);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
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

// The SSE connection accelerates rendering only. Completed rollout messages still replace these temporary
// bubbles, and a broken/backgrounded mobile connection silently retries while transcript polling continues.
export function useCodexMessageStream({
  pane, threadId, enabled, durableMessages, onSettled, onAuthFail,
}) {
  const scope = enabled && pane && threadId ? `${pane}\0${threadId}` : null;
  const [snapshot, setSnapshot] = useState({ scope, messages: [] });
  const latestKRef = useRef(-1);
  const onSettledRef = useRef(onSettled);
  const onAuthFailRef = useRef(onAuthFail);
  latestKRef.current = durableMessages.reduce((latest, message) => (
    Number.isFinite(Number(message?.k)) ? Math.max(latest, Number(message.k)) : latest
  ), -1);
  onSettledRef.current = onSettled;
  onAuthFailRef.current = onAuthFail;

  useEffect(() => {
    setSnapshot((current) => (current.scope === scope ? current : { scope, messages: [] }));
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    setSnapshot((current) => {
      if (current.scope !== scope) return current;
      const messages = current.messages.filter((message) => !durableCoversLiveMessage(durableMessages, message));
      return messages.length === current.messages.length ? current : { scope, messages };
    });
  }, [scope, durableMessages]);

  useEffect(() => {
    if (!scope) return undefined;
    const controller = new AbortController();
    let retryMs = RETRY_MIN_MS;
    const onEvent = (event) => {
      if (event?.threadId && event.threadId !== threadId) return;
      if (event?.type === 'completed' || event?.type === 'turnCompleted') onSettledRef.current?.();
      setSnapshot((current) => {
        if (current.scope !== scope) return current;
        const messages = applyCodexStreamEvent(current.messages, event, latestKRef.current);
        return messages === current.messages ? current : { scope, messages };
      });
    };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await streamCodexMessages(pane, { signal: controller.signal, onEvent });
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
    return () => controller.abort();
  }, [scope, pane, threadId]);

  return snapshot.scope === scope ? snapshot.messages : [];
}
