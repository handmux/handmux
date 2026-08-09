import { useEffect, useRef, useState } from 'react';
import { streamCodexMessages, UnauthorizedError } from '../api.js';
import type { CodexGoal } from '../../../server/src/codexStreamProtocol.js';
import {
  codexGoalMessageId, codexItemMessageId,
} from '../../../server/src/codexMessageIdentity.js';

const MAX_LIVE_MESSAGES = 20;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4_000;

interface CodexStreamEventLike {
  type?: string;
  threadId?: string;
  turnId?: string | null;
  itemId?: string | null;
  text?: string;
  delta?: string;
  completed?: boolean;
  event?: string;
  goal?: Partial<CodexGoal>;
  cursor?: number;
  sequence?: number;
}

export interface CodexLiveMessage {
  id: string;
  streamKey: string;
  turnId: string | null;
  itemId?: string | null;
  role: 'assistant';
  type: 'text' | 'goal';
  text?: string;
  event?: string;
  goal?: Partial<CodexGoal>;
  live: true;
  completed: boolean;
  streaming?: boolean;
  afterK: number;
}

export interface CodexDurableMessage {
  id?: string;
  k?: number | string;
  i?: number | string;
  role?: string;
  type?: string;
  text?: string;
  turnId?: string | null;
  itemId?: string | null;
  event?: string;
  goal?: Partial<CodexGoal>;
}

function eventKey(event: CodexStreamEventLike): string | null {
  return event?.turnId && event?.itemId ? `${event.turnId}:${event.itemId}` : null;
}

export function applyCodexStreamEvent(
  messages: CodexLiveMessage[],
  event: CodexStreamEventLike,
  afterK = -1,
): CodexLiveMessage[] {
  if (!['ready', 'cursorReset', 'started', 'snapshot', 'delta', 'completed', 'turnCompleted', 'goal', 'goalCleared'].includes(event.type ?? '')) {
    return messages;
  }
  // A new SSE connection replays only unfinished App Server items. Finalized temporary bubbles must not
  // survive beside the rollout history, otherwise an old reply can remain below the current one forever.
  if (event.type === 'ready' || event.type === 'cursorReset') {
    const next = messages.filter((message) => {
      if (message.type !== 'goal') return !message.completed;
      return !['complete', 'blocked'].includes(message.goal?.status ?? '') || !!message.turnId;
    });
    return next.length === messages.length ? messages : next;
  }
  if (event.type === 'goalCleared') return messages;
  if (event.type === 'goal' && event.goal?.objective) {
    // Terminal Goal cards are historical events, not current-tail status. Older App Server builds may
    // replay one without a turnId after reconnecting; omit that unplaceable overlay and let the ordered
    // durable rollout render it where update_goal actually ran.
    if (['complete', 'blocked'].includes(event.goal.status ?? '') && !event.turnId) return messages;
    const marker = event.goal.createdAt ?? event.goal.updatedAt ?? event.goal.objective;
    const key = `goal:${marker}:${event.event || event.goal.status || 'set'}`;
    const id = codexGoalMessageId(event.goal, event.event || event.goal.status || 'set');
    if (!id) return messages;
    const nextMessage: CodexLiveMessage = {
      id,
      streamKey: key,
      turnId: event.turnId || null,
      role: 'assistant',
      type: 'goal',
      event: event.event || (event.goal.status === 'active' ? 'set' : event.goal.status),
      goal: event.goal,
      live: true,
      completed: true,
      afterK,
    };
    const index = messages.findIndex((message) => message.streamKey === key);
    const next = index >= 0
      ? messages.map((message, candidate) => (candidate === index ? nextMessage : message))
      : [...messages, nextMessage];
    return next.slice(-MAX_LIVE_MESSAGES);
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
    ? messages.filter((message) => message.type === 'goal' || !message.completed)
    : messages;
  const baseIndex = baseMessages.findIndex((message) => message.streamKey === key);
  const nextMessage: CodexLiveMessage = {
    ...(previous || {}),
    id: codexItemMessageId(event.turnId, event.itemId) || `codex-stream:${key}`,
    streamKey: key,
    turnId: event.turnId ?? null,
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

export function durableCoversLiveMessage(
  durableMessages: CodexDurableMessage[],
  liveMessage: CodexLiveMessage,
): boolean {
  return durableMessages.some((message) => message?.id != null && String(message.id) === liveMessage.id);
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

// The SSE connection accelerates rendering only. Completed rollout messages still replace these temporary
// bubbles, and a broken/backgrounded mobile connection silently retries while transcript polling continues.
export function useCodexMessageStream({
  pane, threadId, enabled, durableMessages, onSettled, onAuthFail,
}: {
  pane?: string | null;
  threadId?: string | null;
  enabled: boolean;
  durableMessages: CodexDurableMessage[];
  onSettled?: () => void;
  onAuthFail?: () => void;
}): CodexLiveMessage[] {
  const scope = enabled && pane && threadId ? `${pane}\0${threadId}` : null;
  const [snapshot, setSnapshot] = useState<{
    scope: string | null;
    messages: CodexLiveMessage[];
  }>({ scope, messages: [] });
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const latestKRef = useRef(-1);
  const lastSequenceRef = useRef(-1);
  const onSettledRef = useRef<(() => void) | undefined>(onSettled);
  const onAuthFailRef = useRef<(() => void) | undefined>(onAuthFail);
  const streamControllerRef = useRef<AbortController | null>(null);
  const lastForegroundWakeRef = useRef(0);
  latestKRef.current = durableMessages.reduce((latest, message) => (
    Number.isFinite(Number(message?.k)) ? Math.max(latest, Number(message.k)) : latest
  ), -1);
  onSettledRef.current = onSettled;
  onAuthFailRef.current = onAuthFail;

  useEffect(() => {
    lastSequenceRef.current = -1;
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
      setSnapshot((current) => {
        if (current.scope !== scope) return current;
        const messages = applyCodexStreamEvent(current.messages, event, latestKRef.current);
        return messages === current.messages ? current : { scope, messages };
      });
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

  return snapshot.scope === scope ? snapshot.messages : [];
}
