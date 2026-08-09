import { useEffect, useRef, useState } from 'react';
import { streamCodexMessages, UnauthorizedError } from '../api.js';

const MAX_LIVE_MESSAGES = 20;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4_000;

function eventKey(event) {
  return event?.turnId && event?.itemId ? `${event.turnId}:${event.itemId}` : null;
}

export function applyCodexStreamEvent(messages, event, afterK = -1) {
  if (!event || !['ready', 'started', 'snapshot', 'delta', 'completed', 'turnCompleted'].includes(event.type)) {
    return messages;
  }
  // A new SSE connection replays only unfinished App Server items. Finalized temporary bubbles must not
  // survive beside the rollout history, otherwise an old reply can remain below the current one forever.
  if (event.type === 'ready') {
    const next = messages.filter((message) => !message.completed);
    return next.length === messages.length ? messages : next;
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
  // Once a later assistant item starts, every earlier finalized assistant item is already history. Keep
  // only unfinished accumulators; the durable rollout remains the single source for completed content.
  const baseMessages = !previous && !completed && (event.type === 'started' || event.type === 'snapshot')
    ? messages.filter((message) => !message.completed)
    : messages;
  const baseIndex = baseMessages.findIndex((message) => message.streamKey === key);
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
  const next = baseIndex >= 0
    ? baseMessages.map((message, candidate) => (candidate === baseIndex ? nextMessage : message))
    : [...baseMessages, nextMessage];
  return next.slice(-MAX_LIVE_MESSAGES);
}

export function durableCoversLiveMessage(durableMessages, liveMessage) {
  if (!liveMessage?.text) return false;
  return durableMessages.some((message) => {
    if (message?.role !== 'assistant' || message.type !== 'text' || message.text !== liveMessage.text) return false;
    if (message.turnId && liveMessage.turnId) return message.turnId === liveMessage.turnId;
    return Number(message.k) > Number(liveMessage.afterK ?? -1);
  });
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
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const latestKRef = useRef(-1);
  const onSettledRef = useRef(onSettled);
  const onAuthFailRef = useRef(onAuthFail);
  const streamControllerRef = useRef(null);
  const lastForegroundWakeRef = useRef(0);
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
      // A matching durable partial hides the duplicate in ChatView, but keep its live accumulator until
      // completion: a later delta still needs the full prefix. Finalized items can be discarded outright.
      const messages = current.messages.filter((message) => (
        !message.completed || !durableCoversLiveMessage(durableMessages, message)
      ));
      return messages.length === current.messages.length ? current : { scope, messages };
    });
  }, [scope, durableMessages]);

  useEffect(() => {
    if (!scope) return undefined;
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
    const onPageShow = (event) => { if (event.persisted) wake(); };
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
    if (!scope) return undefined;
    const controller = new AbortController();
    streamControllerRef.current = controller;
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
    return () => {
      controller.abort();
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
    };
  }, [scope, pane, threadId, connectionEpoch]);

  return snapshot.scope === scope ? snapshot.messages : [];
}
