import { useCallback, useEffect, useRef, useState } from 'react';
import {
  discoverAgentConversation,
  downloadAgentConversationResource,
  interruptAgentConversation,
  queryAgentConversationSubmission,
  readAgentConversationPage,
  sendAgentConversationMessage,
  streamAgentConversation,
} from '../agentConversationApi.js';
import {
  applyAgentConversationEvent,
  emptyAgentConversationProjection,
  prependAgentConversationItems,
  seedAgentConversationProjection,
} from '../agentConversationState.js';
import type { AgentConversationProjection } from '../agentConversationState.js';
import { ApiError, UnauthorizedError } from '../apiErrors.js';
import type { AgentRunRef } from '../agentCatalog.js';
import type {
  ConversationQueueItem,
  ConversationSettledReceipt,
  ConversationSubmissionActionResult,
} from '../agentConversationControlsApi.js';
import {
  projectConversationSubmissions,
  projectConversationTimeline,
  queueSubmissionId,
  reconcileConversationSubmissionClaims,
} from '../conversationSubmissionProjection.js';
import type {
  ConversationCapabilities,
  ConversationDescriptor,
  ConversationEvent,
  ConversationItem,
  ConversationItemDraft,
  ConversationPage,
  ConversationSubmissionSnapshot,
} from '../agentConversationTypes.js';

export interface AgentConversationViewItem {
  key: string;
  item: ConversationItem | ConversationItemDraft;
  provisional: boolean;
  live?: boolean;
  outgoing?: {
    clientRequestId: string;
    text: string;
    status: 'sending' | 'accepted' | 'failed' | 'unknown';
    error?: string;
  };
}

export interface AgentConversationController {
  status: 'idle' | 'loading' | 'ready' | 'reconnecting' | 'error';
  error: string | null;
  descriptor: ConversationDescriptor | null;
  canonicalReady?: boolean;
  items: AgentConversationViewItem[];
  canonicalItems?: AgentConversationViewItem[];
  hasMore: boolean;
  atLatest?: boolean;
  loadingOlder: boolean;
  sending: boolean;
  interrupting: boolean;
  downloadResource(resource: { resourceId: string; name?: string; mediaType?: string }): Promise<void>;
  send(text: string, options?: { queueHint?: boolean }): Promise<void>;
  localSubmissions?: Array<{
    clientRequestId: string;
    text: string;
    owner: 'timeline' | 'queue';
    status: 'sending' | 'accepted' | 'failed' | 'unknown';
    delivery?: 'prompt' | 'steer' | 'follow_up';
    createdAt: number;
    revision?: number;
    actionId?: string;
    baseRevision?: number;
    anchor?: { viewId: string; afterItemId?: string };
    baselineKeys?: readonly string[];
    baselineTailKey?: string;
    occurrenceNotBefore?: number;
    claimedCanonicalKey?: string;
    settledObserved?: true;
    error?: string;
  }>;
  beginQueueSteer?(item: ConversationQueueItem): {
    submissionId: string;
    actionId: string;
    baseRevision: number;
    anchor: { viewId: string; afterItemId?: string };
  };
  observeQueueSnapshot?(items: readonly ConversationQueueItem[]): void;
  observeSubmissionSnapshot?(
    items: readonly ConversationSubmissionSnapshot[],
    options?: {
      authoritative?: boolean;
      queue?: readonly ConversationQueueItem[];
      settled?: readonly ConversationSettledReceipt[];
    },
  ): void;
  settleQueueSteer?(
    submissionId: string,
    result: ConversationSubmissionActionResult,
    error?: string,
  ): void;
  removeQueueSubmission?(submissionId: string): void;
  interrupt(): Promise<void>;
  loadOlder(): Promise<void>;
  loadLatest?(options?: { force?: boolean }): Promise<void>;
  retryOutgoing?(clientRequestId: string): Promise<void>;
}

export type RefreshAgentRun = (stale: AgentRunRef) => Promise<AgentRunRef | null>;
export type AgentConversationIdentity = Pick<AgentRunRef, 'agentId' | 'paneId'> & { sessionId: string };
export const MAX_AGENT_CONVERSATION_ITEMS = 1_000;
const MAX_RETAINED_SEND_ATTEMPTS = 20;
const MAX_LOCAL_SUBMISSIONS = 1_000;

function trimLatestProjection(state: AgentConversationProjection): AgentConversationProjection {
  return state.slots.length > MAX_AGENT_CONVERSATION_ITEMS
    ? { ...state, slots: state.slots.slice(-MAX_AGENT_CONVERSATION_ITEMS) }
    : state;
}

function reconcileLatestPage(
  items: ConversationItem[],
  streamSequence: number,
  previous: AgentConversationProjection,
  options: {
    retainHistoricalPrefix?: boolean;
    retainUnmatchedLive?: boolean;
    consumeUnmatchedLiveGrace?: boolean;
  } = {},
): AgentConversationProjection {
  const seeded = seedAgentConversationProjection(items, streamSequence, previous);
  const seededKeys = new Set(seeded.slots.map((slot) => slot.key));
  const firstSeededPreviousIndex = previous.slots.findIndex((slot) => seededKeys.has(slot.key));
  const lastSeededPreviousIndex = previous.slots.reduce((latest, slot, index) => (
    seededKeys.has(slot.key) ? index : latest
  ), -1);
  const retainedPrefix = options.retainHistoricalPrefix
    ? previous.slots.slice(0, firstSeededPreviousIndex < 0
      ? previous.slots.length : firstSeededPreviousIndex).filter((slot) => !slot.live)
    : [];
  const unmatchedLive = options.retainUnmatchedLive ? previous.slots.flatMap((slot, index) => (
    slot.live && slot.historyGrace !== true
      && index > lastSeededPreviousIndex && !seededKeys.has(slot.key)
      ? [{
        ...slot,
        ...(options.consumeUnmatchedLiveGrace ? { historyGrace: true as const } : {}),
      }]
      : []
  )) : [];
  return trimLatestProjection(retainedPrefix.length || unmatchedLive.length
    ? { ...seeded, slots: [...retainedPrefix, ...seeded.slots, ...unmatchedLive] }
    : seeded);
}

interface PageState {
  viewId: string;
  historyVersion: string;
  previousCursor?: string;
  hasMore: boolean;
}

interface SendAttempt {
  agentId: string;
  sessionId: string;
  text: string;
  delivery: 'prompt' | 'steer' | 'follow_up';
  clientRequestId: string;
}

interface OutgoingAttempt extends SendAttempt {
  owner: 'timeline' | 'queue';
  status: 'sending' | 'accepted' | 'failed' | 'unknown';
  error?: string;
  createdAt: number;
  baselineKeys: string[];
  baselineTailKey?: string;
  occurrenceNotBefore?: number;
  claimedCanonicalKey?: string;
  settledObserved?: true;
  snapshotObserved?: true;
  queueObserved?: true;
  revision?: number;
  actionId?: string;
  baseRevision?: number;
  anchor?: { viewId: string; afterItemId?: string };
}

export class ConversationSendError extends Error {
  constructor(
    message: string,
    readonly deliveryUnknown: boolean,
    readonly publicMessage?: 'sendFailed' | 'sendUnknown',
  ) { super(message); }
}

export function isConversationDeliveryUnknown(error: unknown): boolean {
  return error instanceof ConversationSendError && error.deliveryUnknown;
}

function durableItemId(item: ConversationItem | ConversationItemDraft | undefined): string | undefined {
  return item && 'id' in item && typeof item.id === 'string' ? item.id : undefined;
}

function forgetSendAttempt(attempts: Map<string, SendAttempt>, clientRequestId: string): void {
  for (const [key, attempt] of attempts) {
    if (attempt.clientRequestId === clientRequestId) attempts.delete(key);
  }
}

const FOREGROUND_RECONNECT_NOTICE_DELAY_MS = 5_000;

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Agent Conversation unavailable';
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `agent-send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionOperationKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

function rememberSendAttempt(
  attempts: Map<string, SendAttempt>,
  key: string,
  attempt: SendAttempt,
): void {
  attempts.delete(key);
  attempts.set(key, attempt);
  while (attempts.size > MAX_RETAINED_SEND_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) return;
    attempts.delete(oldest);
  }
}

function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

function staleRun(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.serverError === 'stale agent run';
}

function stalePage(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
    && error.serverError === 'conversation page stale';
}

function retryableConnectionError(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 'conversation_session_unavailable') return true;
  const detail = [
    error instanceof Error ? error.message : '',
    error instanceof ApiError ? error.serverError : '',
    error instanceof ApiError ? error.code : '',
  ].filter(Boolean).join(' ').toLowerCase();
  if (['unsupported', 'no readable conversation', 'invalid descriptor', 'invalid page',
    'invalid response', 'invalid item', 'invalid checkpoint', 'invalid event',
    'invalid envelope', 'unknown envelope', 'different run'].some((value) => detail.includes(value))) {
    return false;
  }
  if (detail.includes('conversation live stream unavailable')) return true;
  if (error instanceof TypeError) return true;
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return detail.includes('timeout')
    || detail.includes('live stream did not become ready')
    || detail.includes('live stream went silent')
    || detail.includes('live stream is unavailable')
    || detail.includes('live stream became unavailable')
    || detail.includes('live stream disconnected')
    || detail.includes('history kept changing');
}

function safeReplacement(stale: AgentRunRef, fresh: AgentRunRef | null): AgentRunRef | null {
  return fresh && fresh.runId !== stale.runId
    && fresh.agentId === stale.agentId && fresh.paneId === stale.paneId
    && fresh.sessionId === stale.sessionId ? fresh : null;
}

async function waitForRetry(signal: AbortSignal, delay = 1_000): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function useAgentConversation(
  run: AgentRunRef | null,
  onAuthFail?: () => void,
  refreshRun?: RefreshAgentRun,
  identity?: AgentConversationIdentity | null,
): AgentConversationController {
  const activeIdentity = identity ?? (run?.sessionId ? {
    agentId: run.agentId, paneId: run.paneId, sessionId: run.sessionId,
  } : null);
  const activeOperationKey = activeIdentity
    ? sessionOperationKey(activeIdentity.agentId, activeIdentity.sessionId) : null;
  const activeIdentityKey = activeIdentity
    ? `${activeIdentity.agentId}\0${activeIdentity.paneId}\0${activeIdentity.sessionId}` : null;
  const [projection, setProjection] = useState(emptyAgentConversationProjection);
  const [descriptor, setDescriptor] = useState<ConversationDescriptor | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [canonicalReady, setCanonicalReady] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const [status, setStatus] = useState<AgentConversationController['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingAttempt[]>([]);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);
  const projectionRef = useRef(emptyAgentConversationProjection());
  const pageRef = useRef<PageState | null>(null);
  const projectionViewIdRef = useRef<string | null>(null);
  const canonicalReadyRef = useRef(false);
  const authRef = useRef(onAuthFail);
  const refreshRunRef = useRef(refreshRun);
  const generationRef = useRef(0);
  const projectionFrameRef = useRef<number | null>(null);
  const latestProjectionRef = useRef(emptyAgentConversationProjection());
  const atLatestRef = useRef(true);
  const loadLatestInFlightRef = useRef<{
    promise: Promise<void>;
    forced: boolean;
    forcedFollowUp?: Promise<void>;
  } | null>(null);
  const connectionRunKeyRef = useRef<string | null>(null);
  const connectionIdentityKeyRef = useRef<string | null>(null);
  const foregroundEpochRef = useRef(0);
  const statusRef = useRef(status);
  const sendAttemptsRef = useRef(new Map<string, SendAttempt>());
  const submissionAbsenceRef = useRef(new Map<string, { revision: number; terminal: boolean }>());
  const sendBusyRef = useRef(new Set<string>());
  const interruptBusyRef = useRef(new Set<string>());
  const activeOperationKeyRef = useRef(activeOperationKey);
  activeOperationKeyRef.current = activeOperationKey;
  statusRef.current = status;
  authRef.current = onAuthFail;
  refreshRunRef.current = refreshRun;

  const recoverRun = useCallback(async (stale: AgentRunRef): Promise<AgentRunRef | null> => {
    try {
      return safeReplacement(stale, await refreshRunRef.current?.(stale) ?? null);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) authRef.current?.();
      return null;
    }
  }, []);

  useEffect(() => {
    if (!run?.sessionId) return undefined;
    let lastWakeAt = 0;
    const wake = (): void => {
      if (document.hidden) return;
      const now = Date.now();
      // iOS commonly emits visibilitychange, pageshow and focus as one burst. Replacing the frozen
      // fetch body once is sufficient and avoids three consecutive history reloads.
      if (now - lastWakeAt < 100) return;
      lastWakeAt = now;
      setForegroundEpoch((value) => value + 1);
    };
    const onVisibility = (): void => { if (!document.hidden) wake(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
    };
  }, [run?.agentId, run?.paneId, run?.runId, run?.sessionId]);

  useEffect(() => {
    const generation = ++generationRef.current;
    loadLatestInFlightRef.current = null;
    const controller = new AbortController();
    const runKey = run?.sessionId
      ? `${run.agentId}\0${run.paneId}\0${run.runId}\0${run.sessionId}` : null;
    const identityKey = activeIdentityKey;
    const sameIdentity = identityKey !== null && connectionIdentityKeyRef.current === identityKey;
    const foregroundReconnect = runKey !== null && connectionRunKeyRef.current === runKey
      && foregroundEpochRef.current !== foregroundEpoch;
    const runTransition = connectionRunKeyRef.current !== runKey;
    const preserveProjection = sameIdentity && (foregroundReconnect || runTransition);
    connectionRunKeyRef.current = runKey;
    connectionIdentityKeyRef.current = identityKey;
    foregroundEpochRef.current = foregroundEpoch;
    const current = (): boolean => generationRef.current === generation && !controller.signal.aborted;
    const silentForegroundReconnect = foregroundReconnect && statusRef.current === 'ready';
    let reconnectNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    const clearReconnectNoticeTimer = (): void => {
      if (reconnectNoticeTimer === null) return;
      clearTimeout(reconnectNoticeTimer);
      reconnectNoticeTimer = null;
    };
    if (!preserveProjection) {
      const empty = emptyAgentConversationProjection();
      projectionRef.current = empty;
      latestProjectionRef.current = empty;
      projectionViewIdRef.current = null;
      atLatestRef.current = true;
      setProjection(empty);
      setAtLatest(true);
      setDescriptor(null);
      pageRef.current = null;
      setPage(null);
      canonicalReadyRef.current = false;
      setCanonicalReady(false);
      setSending(activeOperationKey !== null && sendBusyRef.current.has(activeOperationKey));
      setInterrupting(activeOperationKey !== null && interruptBusyRef.current.has(activeOperationKey));
    } else {
      // Keep the visible durable projection, but do not expose a cursor from the abandoned observation.
      pageRef.current = null;
      setPage(null);
    }
    setError(null);
    setLoadingOlder(false);
    if (!run?.sessionId) {
      setStatus(activeIdentity ? 'reconnecting' : 'idle');
      return () => controller.abort();
    }
    if (silentForegroundReconnect) {
      // Returning from the app switcher proactively replaces the stream because iOS may have frozen its
      // response body. That is routine maintenance, not a connection failure: keep the usable conversation
      // quiet unless the replacement actually takes long enough to matter.
      setStatus('ready');
      reconnectNoticeTimer = setTimeout(() => {
        reconnectNoticeTimer = null;
        if (current()) setStatus('reconnecting');
      }, FOREGROUND_RECONNECT_NOTICE_DELAY_MS);
    } else {
      setStatus(preserveProjection ? 'reconnecting' : 'loading');
    }

    const pendingDeltas: ConversationEvent[] = [];
    const flushPendingDeltas = (): void => {
      if (projectionFrameRef.current !== null) cancelAnimationFrame(projectionFrameRef.current);
      projectionFrameRef.current = null;
      if (!pendingDeltas.length) return;
      let next = atLatestRef.current ? projectionRef.current : latestProjectionRef.current;
      for (const event of pendingDeltas.splice(0)) {
        next = applyAgentConversationEvent(next, event);
      }
      next = trimLatestProjection(next);
      latestProjectionRef.current = next;
      if (atLatestRef.current) {
        projectionRef.current = next;
        if (current()) setProjection(next);
      }
    };
    const queueDelta = (event: Extract<ConversationEvent, { type: 'item.delta' }>): void => {
      const previous = pendingDeltas.at(-1);
      if (previous?.type === 'item.delta'
        && previous.provisionalId === event.provisionalId
        && previous.delta.op === 'text.append' && event.delta.op === 'text.append'
        && previous.delta.target === event.delta.target
        && previous.delta.blockIndex === event.delta.blockIndex) {
        pendingDeltas[pendingDeltas.length - 1] = {
          ...event,
          delta: { ...event.delta, text: previous.delta.text + event.delta.text },
        };
      } else {
        pendingDeltas.push(event);
      }
      if (projectionFrameRef.current !== null) return;
      projectionFrameRef.current = requestAnimationFrame(() => {
        projectionFrameRef.current = null;
        if (!current()) return;
        try {
          flushPendingDeltas();
        } catch {
          void readLatest().catch((cause) => {
            if (!current() || aborted(cause, controller.signal)) return;
            setStatus('reconnecting');
            setError(message(cause));
          });
        }
      });
    };
    const acceptPage = (
      value: ConversationPage,
      streamSequence: number,
      options: { retainUnmatchedLive?: boolean; consumeUnmatchedLiveGrace?: boolean } = {},
    ): void => {
      if (!current()) return;
      const previousPage = pageRef.current;
      const sameView = projectionViewIdRef.current === value.viewId;
      // `streamSequence` belongs to this ready checkpoint only. A reconnect creates a fresh
      // observation epoch, so old live slots and the previous sequence must never leak across it.
      const next = reconcileLatestPage(
        value.items,
        streamSequence,
        latestProjectionRef.current,
        { retainHistoricalPrefix: sameView, ...options },
      );
      projectionViewIdRef.current = value.viewId;
      latestProjectionRef.current = next;
      if (!atLatestRef.current) return;
      projectionRef.current = next;
      setProjection(next);
      const nextPage: PageState = sameView && previousPage ? {
        ...previousPage,
        historyVersion: value.historyVersion,
      } : {
        viewId: value.viewId, historyVersion: value.historyVersion,
        hasMore: value.hasMore,
        ...(value.previousCursor === undefined ? {} : { previousCursor: value.previousCursor }),
      };
      pageRef.current = nextPage;
      setPage(nextPage);
      canonicalReadyRef.current = true;
      setCanonicalReady(true);
    };
    const readLatest = async (
      expectedViewId?: string,
      expectedHistoryVersion?: string,
      streamSequence = 0,
      options: { retainUnmatchedLive?: boolean; consumeUnmatchedLiveGrace?: boolean } = {},
    ): Promise<void> => {
      let result = await readAgentConversationPage(run, {
        limit: 50,
        ...(expectedViewId ? { expectedViewId } : {}),
        ...(expectedHistoryVersion ? { expectedHistoryVersion } : {}),
      });
      if (result.status === 'stale') {
        result = await readAgentConversationPage(run, {
          limit: 50,
          expectedViewId: result.currentViewId,
          expectedHistoryVersion: result.currentHistoryVersion,
        });
      }
      if (result.status !== 'ok') throw new Error('Agent Conversation history kept changing');
      acceptPage(result.page, streamSequence, options);
    };

    const connect = async (): Promise<void> => {
      while (current()) {
        try {
          const discovered = await discoverAgentConversation(run);
          if (!discovered) throw new Error('This Agent has no readable conversation');
          if (!current()) return;
          setDescriptor(discovered);
          if (discovered.capabilities.live === 'poll') {
            await readLatest(discovered.viewId, discovered.historyVersion);
            if (!current()) return;
            clearReconnectNoticeTimer();
            setStatus('ready');
            setError(null);
            await waitForRetry(controller.signal, 1_500);
            continue;
          }
          let sawTerminalGap = false;
          await streamAgentConversation(run, {
            signal: controller.signal,
            expectedViewId: discovered.viewId,
            onReady: async (checkpoint) => {
              await readLatest(
                checkpoint.viewId,
                checkpoint.historyVersion,
                checkpoint.streamSequence,
              );
              if (current()) {
                clearReconnectNoticeTimer();
                setStatus('ready');
                setError(null);
              }
            },
            onEvent: async (event) => {
              if (!current()) return;
              if (!atLatestRef.current) {
                try {
                  latestProjectionRef.current = trimLatestProjection(
                    applyAgentConversationEvent(latestProjectionRef.current, event),
                  );
                  if (event.type === 'history.changed') {
                    await readLatest(event.viewId, event.historyVersion, event.sequence, {
                      retainUnmatchedLive: true,
                      consumeUnmatchedLiveGrace: true,
                    });
                  } else if (event.type === 'stream.gap') {
                    sawTerminalGap = true;
                    await readLatest(undefined, undefined, event.sequence);
                  }
                } catch {
                  await readLatest(undefined, undefined, event.sequence);
                }
                return;
              }
              try {
                if (event.type === 'item.delta') {
                  queueDelta(event);
                  return;
                }
                flushPendingDeltas();
                const next = applyAgentConversationEvent(projectionRef.current, event);
                const bounded = trimLatestProjection(next);
                projectionRef.current = bounded;
                latestProjectionRef.current = bounded;
                setProjection(bounded);
                if (event.type === 'history.changed') {
                  await readLatest(event.viewId, event.historyVersion, event.sequence, {
                    retainUnmatchedLive: true,
                    consumeUnmatchedLiveGrace: true,
                  });
                } else if (event.type === 'stream.gap') {
                  sawTerminalGap = true;
                  await readLatest(undefined, undefined, event.sequence);
                }
              } catch {
                const currentProjection = projectionRef.current;
                // Reset the broken epoch but retain completed slots until the authoritative read can
                // claim them. Drafts cannot be continued safely; unmatched settlements disappear on seed.
                const recovered = {
                  slots: currentProjection.slots.filter((slot) => !slot.provisional),
                  lastSequence: event.sequence,
                };
                projectionRef.current = recovered;
                latestProjectionRef.current = recovered;
                setProjection(recovered);
                await readLatest(undefined, undefined, event.sequence);
              }
            },
          });
          if (!current()) return;
          // A stream gap is terminal and already reconciled above, so resubscribe immediately. Durable
          // history barriers no longer close the observation; a later disconnect is therefore a real
          // transport failure and must take the normal retry backoff instead of spinning here.
          if (sawTerminalGap) continue;
          throw new Error('Agent Conversation live stream disconnected');
        } catch (cause) {
          if (aborted(cause, controller.signal)) return;
          clearReconnectNoticeTimer();
          if (cause instanceof UnauthorizedError) {
            authRef.current?.();
            return;
          }
          if (staleRun(cause)) {
            // A Server restart creates a fresh run lease for the same still-live Agent process. Refresh
            // immediately instead of retrying this obsolete run until App's five-second catalog poll lands.
            // The session equality guard in recoverRun prevents reconnecting this view to a replacement chat.
            await recoverRun(run);
            if (!current()) return;
            setStatus('reconnecting');
            setError(null);
            await waitForRetry(controller.signal, 100);
            continue;
          }
          if (!current()) return;
          if (!retryableConnectionError(cause)) {
            // Protocol, unsupported and missing-conversation failures cannot heal through polling. Keep
            // provider details out of the UI and stop this connection epoch instead of spinning forever.
            setStatus('error');
            setError(null);
            return;
          }
          // Before the first canonical page keep the one loading surface; afterwards retain the timeline
          // and use the compact reconnect treatment. Transport details stay internal while retrying.
          setStatus(canonicalReadyRef.current ? 'reconnecting' : 'loading');
          setError(null);
          await waitForRetry(controller.signal);
        }
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearReconnectNoticeTimer();
      if (projectionFrameRef.current !== null) cancelAnimationFrame(projectionFrameRef.current);
      projectionFrameRef.current = null;
      pendingDeltas.length = 0;
    };
  }, [activeIdentityKey,
    foregroundEpoch, recoverRun, run?.agentId, run?.paneId, run?.runId, run?.sessionId]);

  // React renders the new pane before the passive connection effect clears the previous pane's state.
  // Scope every render-time value to the identity that produced it so the new surface can never receive
  // one frame of the old conversation or its capabilities.
  const stateMatchesIdentity = connectionIdentityKeyRef.current === activeIdentityKey;
  const activeDescriptor = stateMatchesIdentity ? descriptor : null;

  const send = useCallback(async (
    text: string,
    options: { queueHint?: boolean } = {},
  ): Promise<void> => {
    const value = text.trim();
    if (!value) return;
    if (!run?.sessionId || !activeDescriptor) throw new Error('Agent is reconnecting; try again shortly');
    const operationKey = sessionOperationKey(run.agentId, run.sessionId);
    if (sendBusyRef.current.has(operationKey)) throw new Error('A message is already being sent');
    if (!canSendConversation(activeDescriptor.capabilities)) {
      throw new Error('This Agent does not accept messages here');
    }
    const previous = sendAttemptsRef.current.get(operationKey);
    const attempt = previous?.text === value
      ? previous
      : {
        agentId: run.agentId,
        sessionId: run.sessionId,
        text: value,
        delivery: 'prompt' as const,
        clientRequestId: requestId(),
    };
    rememberSendAttempt(sendAttemptsRef.current, operationKey, attempt);
    const baselineSlots = projectionRef.current.slots;
    const baselineTailKey = baselineSlots.at(-1)?.key;
    setOutgoing((items) => {
      const next = [
        ...items.filter((item) => item.clientRequestId !== attempt.clientRequestId),
        {
          ...attempt, status: 'sending' as const, createdAt: Date.now(),
          owner: options.queueHint ? 'queue' as const : 'timeline' as const,
          baselineKeys: baselineSlots.map((slot) => slot.key),
          ...(baselineTailKey ? { baselineTailKey } : {}),
        },
      ];
      return next.length > MAX_LOCAL_SUBMISSIONS ? next.slice(-MAX_LOCAL_SUBMISSIONS) : next;
    });
    sendBusyRef.current.add(operationKey);
    if (activeOperationKeyRef.current === operationKey) setSending(true);
    try {
      // Keep one id across stale-run recovery and a later manual retry of the same unedited text. A phone
      // can lose the HTTP response after the Agent accepted the message; generating a new id on the second
      // tap would execute it twice. Editing the text starts a deliberately new request.
      const request = {
        clientRequestId: attempt.clientRequestId,
        text: attempt.text,
        delivery: attempt.delivery,
      };
      let receipt;
      try {
        receipt = await sendAgentConversationMessage(run, request);
      } catch (cause) {
        if (!staleRun(cause)) throw cause;
        const fresh = await recoverRun(run);
        if (!fresh) throw cause;
        receipt = await sendAgentConversationMessage(fresh, request);
      }
      if (receipt.status === 'rejected') {
        if (receipt.nativeMutation === false) {
          if (sendAttemptsRef.current.get(operationKey) === attempt) {
            sendAttemptsRef.current.delete(operationKey);
          }
          throw new ConversationSendError('Agent rejected the message', false, 'sendFailed');
        }
        throw new ConversationSendError('Message delivery is unknown', true, 'sendUnknown');
      }
      if (receipt.status === 'unknown') {
        const detail = 'Message delivery is unknown';
        setOutgoing((items) => items.map((item) => item.clientRequestId === attempt.clientRequestId
          ? {
            ...item,
            owner: receipt.submission?.dispatchOrigin === 'queue' ? 'queue' : item.owner,
            status: 'unknown', error: detail,
          } : item));
        throw new ConversationSendError(detail, true, 'sendUnknown');
      }
      const submissionQueueOwner = receipt.submission?.state === 'queued'
        || (receipt.submission?.dispatchOrigin === 'queue'
          && receipt.submission.state === 'dispatching');
      if (receipt.status === 'queued' || submissionQueueOwner) {
        setOutgoing((items) => items.map((item) => item.clientRequestId === attempt.clientRequestId
          ? { ...item, owner: 'queue', status: 'accepted' } : item));
        if (sendAttemptsRef.current.get(operationKey) === attempt) {
          sendAttemptsRef.current.delete(operationKey);
        }
        return;
      }
      setOutgoing((items) => items.map((item) => {
        if (item.clientRequestId !== attempt.clientRequestId) return item;
        const { error: _error, ...accepted } = item;
        return { ...accepted, owner: 'timeline', status: 'accepted' };
      }));
      if (sendAttemptsRef.current.get(operationKey) === attempt) {
        sendAttemptsRef.current.delete(operationKey);
      }
    } catch (cause) {
      if (cause instanceof UnauthorizedError) authRef.current?.();
      const unknown = cause instanceof ConversationSendError ? cause.deliveryUnknown : true;
      setOutgoing((items) => unknown
        ? items.map((item) => item.clientRequestId === attempt.clientRequestId
          ? { ...item, status: 'unknown', error: message(cause) } : item)
        : items.filter((item) => item.clientRequestId !== attempt.clientRequestId));
      throw cause instanceof ConversationSendError
        ? cause : new ConversationSendError(message(cause), unknown);
    } finally {
      sendBusyRef.current.delete(operationKey);
      if (activeOperationKeyRef.current === operationKey) setSending(false);
    }
  }, [activeDescriptor, recoverRun, run]);

  const beginQueueSteer = useCallback((item: ConversationQueueItem): {
    submissionId: string;
    actionId: string;
    baseRevision: number;
    anchor: { viewId: string; afterItemId?: string };
  } => {
    const clientRequestId = queueSubmissionId(item);
    const actionId = requestId();
    const baseRevision = item.revision ?? 0;
    const baselineSlots = projectionRef.current.slots;
    const afterItemId = [...baselineSlots].reverse()
      .map((slot) => durableItemId(slot.item)).find((id) => id !== undefined);
    const anchor = {
      viewId: activeDescriptor?.viewId ?? 'current',
      ...(afterItemId === undefined ? {} : { afterItemId }),
    };
    if (!activeIdentity) return { submissionId: clientRequestId, actionId, baseRevision, anchor };
    const baselineTailKey = baselineSlots.at(-1)?.key;
    setOutgoing((items) => {
      const next: OutgoingAttempt = {
        agentId: activeIdentity.agentId,
        sessionId: activeIdentity.sessionId,
        clientRequestId,
        text: item.text,
        delivery: 'steer',
        owner: 'timeline',
        status: 'sending',
        createdAt: Date.now(),
        revision: baseRevision,
        actionId,
        baseRevision,
        anchor,
        baselineKeys: baselineSlots.map((slot) => slot.key),
        ...(baselineTailKey ? { baselineTailKey } : {}),
      };
      const updated = [...items.filter((entry) => entry.clientRequestId !== clientRequestId), next];
      return updated.length > MAX_LOCAL_SUBMISSIONS ? updated.slice(-MAX_LOCAL_SUBMISSIONS) : updated;
    });
    return { submissionId: clientRequestId, actionId, baseRevision, anchor };
  }, [activeDescriptor?.viewId, activeIdentity]);

  const settleQueueSteer = useCallback((
    submissionId: string,
    result: ConversationSubmissionActionResult,
    detail?: string,
  ): void => {
    setOutgoing((items) => items.map((entry) => {
      if (entry.clientRequestId !== submissionId) return entry;
      if (result.actionId && entry.actionId && result.actionId !== entry.actionId) return entry;
      const revision = result.submission?.revision ?? result.revision;
      const floor = Math.max(entry.baseRevision ?? 0, entry.revision ?? 0);
      if (revision !== undefined && revision < floor) return entry;
      if (result.status === 'rejected' && result.nativeMutation === false) {
        const current = result.submission;
        const currentQueueOwner = !current || current.state === 'queued'
          || (current.state === 'dispatching' && current.dispatchOrigin === 'queue');
        const { error: _error, ...rolledBack } = entry;
        return {
          ...rolledBack,
          owner: currentQueueOwner ? 'queue' as const : 'timeline' as const,
          status: currentQueueOwner ? 'accepted' as const : current?.state === 'unknown'
              ? 'unknown' as const : 'sending' as const,
          ...(revision === undefined ? {} : { revision }),
          ...(result.submission?.steerAnchor ? { anchor: result.submission.steerAnchor } : {}),
        };
      }
      const unknown = result.status === 'unknown'
        || (result.status === 'rejected' && result.nativeMutation !== false);
      const { error: _error, ...settled } = entry;
      return {
        ...settled,
        owner: 'timeline' as const,
        status: unknown ? 'unknown' as const : 'accepted' as const,
        ...(revision === undefined ? {} : { revision }),
        ...(result.submission?.steerAnchor ? { anchor: result.submission.steerAnchor } : {}),
        ...(detail ? { error: detail } : {}),
      };
    }));
  }, []);

  const observeQueueSnapshot = useCallback((snapshot: readonly ConversationQueueItem[]): void => {
    setOutgoing((items) => {
      let changed = false;
      const next = items.map((entry) => {
        if (entry.owner !== 'queue') return entry;
        const observed = snapshot.find((item) => queueSubmissionId(item) === entry.clientRequestId);
        if (!observed) return entry;
        const revision = observed.revision;
        if (entry.queueObserved && entry.text === observed.text
          && (revision === undefined || revision === entry.revision)) return entry;
        changed = true;
        return {
          ...entry,
          text: observed.text,
          queueObserved: true as const,
          ...(revision === undefined ? {} : { revision }),
        };
      });
      return changed ? next : items;
    });
  }, []);

  const observeSubmissionSnapshot = useCallback((
    snapshot: readonly ConversationSubmissionSnapshot[],
    options: {
      authoritative?: boolean;
      queue?: readonly ConversationQueueItem[];
      settled?: readonly ConversationSettledReceipt[];
    } = {},
  ): void => {
    if (!activeIdentity) return;
    const scopedKey = (submissionId: string): string => (
      `${activeIdentity.agentId}\0${activeIdentity.sessionId}\0${submissionId}`
    );
    const snapshotIds = new Set(snapshot.map((submission) => submission.id));
    const queueIds = new Set((options.queue ?? []).map(queueSubmissionId));
    const settledIds = new Set((options.settled ?? []).map((receipt) => receipt.id));
    setOutgoing((items) => {
      let next = items;
      let changed = false;
      for (const submission of snapshot) {
        const index = next.findIndex((entry) => entry.clientRequestId === submission.id
          && entry.agentId === activeIdentity.agentId
          && entry.sessionId === activeIdentity.sessionId);
        const existing = index < 0 ? null : next[index]!;
        const absence = submissionAbsenceRef.current.get(scopedKey(submission.id));
        if (absence && (absence.terminal || submission.revision <= absence.revision)) continue;
        if (absence) submissionAbsenceRef.current.delete(scopedKey(submission.id));
        if (existing?.settledObserved) continue;
        if (existing?.revision !== undefined && existing.revision > submission.revision) continue;
        const pendingSteer = existing?.owner === 'timeline' && existing.actionId !== undefined;
        if (pendingSteer && submission.state === 'queued'
          && submission.revision <= Math.max(existing.baseRevision ?? 0, existing.revision ?? 0)) continue;
        const owner = submission.state === 'queued'
          || (submission.dispatchOrigin === 'queue'
            && (submission.state === 'dispatching' || submission.state === 'unknown'))
          ? 'queue' as const : 'timeline' as const;
        const status = submission.state === 'unknown' ? 'unknown' as const : 'sending' as const;
        const currentSlots = projectionRef.current.slots;
        const currentPage = pageRef.current;
        const restoredBaseline: {
          slots: typeof currentSlots;
          tailKey?: string;
          occurrenceNotBefore?: number;
        } = submission.baseline && currentPage
          && submission.baseline.viewId === currentPage.viewId
          ? submission.baseline.tailItemId === undefined
            ? {
              slots: [] as typeof currentSlots,
              occurrenceNotBefore: submission.createdAt - 5_000,
            }
            : (() => {
              const tailIndex = currentSlots.findIndex((slot) => (
                durableItemId(slot.item) === submission.baseline!.tailItemId
              ));
              return tailIndex >= 0
                ? { slots: currentSlots.slice(0, tailIndex + 1), tailKey: currentSlots[tailIndex]!.key }
                : {
                  slots: currentSlots,
                  ...(currentSlots.at(-1)?.key ? { tailKey: currentSlots.at(-1)!.key } : {}),
                };
            })()
          : {
            slots: currentSlots,
            ...(currentSlots.at(-1)?.key ? { tailKey: currentSlots.at(-1)!.key } : {}),
          };
        const replacement: OutgoingAttempt = {
          agentId: activeIdentity.agentId,
          sessionId: activeIdentity.sessionId,
          clientRequestId: submission.id,
          text: submission.text,
          delivery: submission.dispatchOrigin === 'steer' ? 'steer' : 'prompt',
          owner,
          status,
          createdAt: submission.createdAt,
          revision: submission.revision,
          ...(existing?.actionId || submission.steerActionId
            ? { actionId: existing?.actionId ?? submission.steerActionId } : {}),
          ...(existing?.baseRevision !== undefined ? { baseRevision: existing.baseRevision } : {}),
          ...(existing?.anchor || submission.steerAnchor
            ? { anchor: existing?.anchor ?? submission.steerAnchor } : {}),
          baselineKeys: existing?.baselineKeys ?? restoredBaseline.slots.map((slot) => slot.key),
          ...(existing?.baselineTailKey ? { baselineTailKey: existing.baselineTailKey }
            : restoredBaseline.tailKey ? { baselineTailKey: restoredBaseline.tailKey } : {}),
          ...(existing?.occurrenceNotBefore !== undefined
            ? { occurrenceNotBefore: existing.occurrenceNotBefore }
            : restoredBaseline.occurrenceNotBefore !== undefined
              ? { occurrenceNotBefore: restoredBaseline.occurrenceNotBefore } : {}),
          ...(existing?.claimedCanonicalKey
            ? { claimedCanonicalKey: existing.claimedCanonicalKey } : {}),
          ...(existing?.settledObserved ? { settledObserved: true as const } : {}),
          ...(existing?.queueObserved ? { queueObserved: true as const } : {}),
          snapshotObserved: true,
        };
        if (existing && existing.owner === replacement.owner && existing.status === replacement.status
          && existing.revision === replacement.revision && existing.text === replacement.text
          && existing.snapshotObserved) continue;
        next = index < 0 ? [...next, replacement]
          : next.map((entry, itemIndex) => itemIndex === index ? replacement : entry);
        changed = true;
      }
      // A settled receipt is identity-only. It may hand an outgoing already owned by this page from
      // Queue to Timeline, but must never recreate text after a reload or conversation switch.
      if (settledIds.size) {
        next = next.map((entry) => {
          if (entry.agentId !== activeIdentity.agentId || entry.sessionId !== activeIdentity.sessionId
            || !settledIds.has(entry.clientRequestId)) return entry;
          const { error: _error, ...settled } = entry;
          if (entry.owner === 'timeline' && entry.status === 'accepted' && !entry.error) return entry;
          changed = true;
          return {
            ...settled,
            owner: 'timeline' as const,
            status: 'accepted' as const,
            settledObserved: true as const,
          };
        });
      }
      if (options.authoritative) {
        const retained = next.filter((entry) => {
          if (entry.agentId !== activeIdentity.agentId || entry.sessionId !== activeIdentity.sessionId
            || snapshotIds.has(entry.clientRequestId) || queueIds.has(entry.clientRequestId)
            || settledIds.has(entry.clientRequestId)
            || entry.status !== 'accepted'
            || (!entry.snapshotObserved && !entry.queueObserved)) return true;
          submissionAbsenceRef.current.set(scopedKey(entry.clientRequestId), {
            revision: entry.revision ?? 0, terminal: true,
          });
          forgetSendAttempt(sendAttemptsRef.current, entry.clientRequestId);
          changed = true;
          return false;
        });
        next = retained;
      }
      return changed ? next : items;
    });
  }, [activeIdentity]);

  const retryOutgoing = useCallback(async (clientRequestId: string): Promise<void> => {
    const attempt = outgoing.find((item) => item.clientRequestId === clientRequestId);
    if (!attempt || attempt.status !== 'unknown' || !run?.sessionId) return;
    const request = {
      submissionId: attempt.clientRequestId,
      ...(attempt.actionId ? { actionId: attempt.actionId } : {}),
    };
    let receipt;
    try {
      receipt = await queryAgentConversationSubmission(run, request);
      if (receipt.status === 'rejected' && receipt.reason === 'conflict' && attempt.actionId) {
        receipt = await queryAgentConversationSubmission(run, { submissionId: attempt.clientRequestId });
      }
    } catch (cause) {
      if (!staleRun(cause)) throw cause;
      const fresh = await recoverRun(run);
      if (!fresh) throw cause;
      receipt = await queryAgentConversationSubmission(fresh, request);
      if (receipt.status === 'rejected' && receipt.reason === 'conflict' && attempt.actionId) {
        receipt = await queryAgentConversationSubmission(fresh, { submissionId: attempt.clientRequestId });
      }
    }
    if (receipt.submission) observeSubmissionSnapshot([receipt.submission]);
    else if (receipt.status === 'accepted') {
      setOutgoing((items) => items.map((entry) => {
        if (entry.clientRequestId !== clientRequestId) return entry;
        const { error: _error, ...accepted } = entry;
        return { ...accepted, owner: 'timeline' as const, status: 'accepted' as const };
      }));
    }
  }, [observeSubmissionSnapshot, outgoing, recoverRun, run]);

  const removeQueueSubmission = useCallback((submissionId: string): void => {
    setOutgoing((items) => items.filter((entry) => entry.clientRequestId !== submissionId));
  }, []);

  useEffect(() => {
    setOutgoing((items) => {
      if (!items.length) return items;
      const canonical = projection.slots.flatMap((slot): AgentConversationViewItem[] => (
        slot.item ? [{
          key: slot.key, item: slot.item, provisional: slot.provisional, live: slot.live,
        }] : []
      ));
      const reconciled = reconcileConversationSubmissionClaims(canonical, items);
      for (const id of reconciled.claimedSubmissionIds) {
        forgetSendAttempt(sendAttemptsRef.current, id);
        if (activeIdentity) {
          const entry = items.find((candidate) => candidate.clientRequestId === id);
          submissionAbsenceRef.current.set(
            `${activeIdentity.agentId}\0${activeIdentity.sessionId}\0${id}`,
            { revision: entry?.revision ?? 0, terminal: true },
          );
        }
      }
      return reconciled.local.length === items.length
        && reconciled.local.every((entry, index) => entry === items[index])
        ? items : reconciled.local;
    });
  }, [activeIdentity?.agentId, activeIdentity?.sessionId, projection]);

  const interrupt = useCallback(async (): Promise<void> => {
    if (activeDescriptor?.capabilities.interrupt !== true) return;
    if (!run?.sessionId) throw new Error('Agent is reconnecting; try again shortly');
    const operationKey = sessionOperationKey(run.agentId, run.sessionId);
    if (interruptBusyRef.current.has(operationKey)) return;
    interruptBusyRef.current.add(operationKey);
    if (activeOperationKeyRef.current === operationKey) setInterrupting(true);
    try {
      let receipt;
      try {
        receipt = await interruptAgentConversation(run);
      } catch (cause) {
        if (!staleRun(cause)) throw cause;
        const fresh = await recoverRun(run);
        if (!fresh) throw cause;
        receipt = await interruptAgentConversation(fresh);
      }
      if (receipt.status !== 'accepted') throw new Error(receipt.reason || 'Agent did not confirm the interrupt');
    } catch (cause) {
      if (cause instanceof UnauthorizedError) authRef.current?.();
      throw cause;
    } finally {
      interruptBusyRef.current.delete(operationKey);
      if (activeOperationKeyRef.current === operationKey) setInterrupting(false);
    }
  }, [activeDescriptor, recoverRun, run]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!stateMatchesIdentity) return;
    if (!run?.sessionId || !page?.hasMore || !page.previousCursor || loadingOlder) return;
    const generation = generationRef.current;
    const current = (): boolean => generationRef.current === generation;
    setLoadingOlder(true);
    try {
      const result = await readAgentConversationPage(run, {
        before: page.previousCursor, limit: 50,
        expectedViewId: page.viewId, expectedHistoryVersion: page.historyVersion,
      });
      if (!current()) return;
      if (result.status !== 'ok') {
        // A real view replacement invalidates this pagination chain. Keep the reader's current window
        // intact and let the existing "reload latest" action cross that boundary explicitly.
        const staleWindow: PageState = {
          viewId: result.currentViewId,
          historyVersion: result.currentHistoryVersion,
          hasMore: false,
        };
        pageRef.current = staleWindow;
        setPage(staleWindow);
        atLatestRef.current = false;
        setAtLatest(false);
        setError(null);
        return;
      }
      const expanded = prependAgentConversationItems(projectionRef.current, result.page.items);
      const trimmedLatest = expanded.slots.length > MAX_AGENT_CONVERSATION_ITEMS;
      const next = trimmedLatest
        ? { ...expanded, slots: expanded.slots.slice(0, MAX_AGENT_CONVERSATION_ITEMS) }
        : expanded;
      projectionRef.current = next;
      setProjection(next);
      if (trimmedLatest
        || (result.page.hasMore && next.slots.length >= MAX_AGENT_CONVERSATION_ITEMS)) {
        if (atLatestRef.current) {
          latestProjectionRef.current = trimLatestProjection(expanded);
        }
        atLatestRef.current = false;
        setAtLatest(false);
      } else if (atLatestRef.current) {
        latestProjectionRef.current = next;
      }
      const nextPage: PageState = {
        viewId: result.page.viewId, historyVersion: result.page.historyVersion,
        hasMore: result.page.hasMore,
        ...(result.page.previousCursor === undefined ? {} : { previousCursor: result.page.previousCursor }),
      };
      projectionViewIdRef.current = result.page.viewId;
      pageRef.current = nextPage;
      setPage(nextPage);
      canonicalReadyRef.current = true;
      setCanonicalReady(true);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      if (stalePage(cause)) {
        const currentPage = pageRef.current;
        if (currentPage) {
          const staleWindow = { ...currentPage, hasMore: false };
          pageRef.current = staleWindow;
          setPage(staleWindow);
        }
        atLatestRef.current = false;
        setAtLatest(false);
        setError(null);
        return;
      }
      if (staleRun(cause) && await recoverRun(run)) return;
      throw cause;
    } finally {
      // A page request from the previous pane/run must not clear a newer request's spinner.
      if (current()) setLoadingOlder(false);
    }
  }, [loadingOlder, page, recoverRun, run, stateMatchesIdentity]);

  const loadLatest = useCallback((
    options: { force?: boolean } = {},
  ): Promise<void> => {
    const invocationGeneration = generationRef.current;
    const start = (forced: boolean): Promise<void> => {
      if (generationRef.current !== invocationGeneration) {
        return forced
          ? Promise.reject(new Error('Authoritative latest read was not applied'))
          : Promise.resolve();
      }
      const existing = loadLatestInFlightRef.current;
      if (existing) {
        if (!forced) return existing.promise;
        if (!existing.forcedFollowUp) {
          existing.forcedFollowUp = existing.promise.then(
            () => start(true),
            () => start(true),
          );
        }
        return existing.forcedFollowUp;
      }
      if ((!forced && atLatestRef.current) || !run?.sessionId) {
        return forced
          ? Promise.reject(new Error('Authoritative latest read could not start'))
          : Promise.resolve();
      }
      const generation = generationRef.current;
      const current = (): boolean => generationRef.current === generation;
      const flight: {
        promise: Promise<void>;
        forced: boolean;
        forcedFollowUp?: Promise<void>;
      } = { promise: Promise.resolve(), forced };
      flight.promise = (async (): Promise<void> => {
        try {
          let result = await readAgentConversationPage(run, { limit: 50 });
          if (result.status === 'stale') {
            result = await readAgentConversationPage(run, {
              limit: 50,
              expectedViewId: result.currentViewId,
              expectedHistoryVersion: result.currentHistoryVersion,
            });
          }
          if (!current() || result.status !== 'ok') {
            if (forced) throw new Error('Authoritative latest read was not applied');
            return;
          }
          const next = reconcileLatestPage(
            result.page.items,
            latestProjectionRef.current.lastSequence,
            latestProjectionRef.current,
            { retainUnmatchedLive: true },
          );
          atLatestRef.current = true;
          latestProjectionRef.current = next;
          projectionRef.current = next;
          setProjection(next);
          const nextPage: PageState = {
            viewId: result.page.viewId,
            historyVersion: result.page.historyVersion,
            hasMore: result.page.hasMore,
            ...(result.page.previousCursor === undefined
              ? {} : { previousCursor: result.page.previousCursor }),
          };
          projectionViewIdRef.current = result.page.viewId;
          pageRef.current = nextPage;
          setPage(nextPage);
          setAtLatest(true);
          setStatus('ready');
          setError(null);
        } catch (cause) {
          if (!current()) {
            if (forced) throw cause;
            return;
          }
          if (cause instanceof UnauthorizedError) authRef.current?.();
          if (staleRun(cause) && await recoverRun(run)) {
            if (forced) throw new Error('Authoritative latest read was not applied');
            return;
          }
          throw cause;
        } finally {
          if (loadLatestInFlightRef.current === flight) loadLatestInFlightRef.current = null;
        }
      })();
      loadLatestInFlightRef.current = flight;
      return flight.promise;
    };
    return start(options.force === true);
  }, [recoverRun, run]);

  const downloadResource = useCallback(async (
    resource: { resourceId: string; name?: string; mediaType?: string },
  ): Promise<void> => {
    if (!run?.sessionId) throw new Error('This Agent resource has no session owner');
    try {
      await downloadAgentConversationResource(run.agentId, run.sessionId, resource);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) authRef.current?.();
      throw cause;
    }
  }, [run]);

  const items: AgentConversationViewItem[] = (stateMatchesIdentity ? projection.slots : []).flatMap((slot) => (
    slot.item ? [{
      key: slot.key,
      item: slot.item,
      provisional: slot.provisional,
      live: slot.live,
    }] : []
  ));
  const localSubmissions = stateMatchesIdentity ? outgoing.filter((item) => activeIdentity
    && item.agentId === activeIdentity.agentId && item.sessionId === activeIdentity.sessionId) : [];
  const outgoingProjection = projectConversationSubmissions(items, localSubmissions, []);
  const projectedItems = projectConversationTimeline(items, outgoingProjection.timeline);
  const scopedStatus: AgentConversationController['status'] = stateMatchesIdentity
    ? status : run?.sessionId ? 'loading' : activeIdentity ? 'reconnecting' : 'idle';
  return {
    status: scopedStatus,
    error: stateMatchesIdentity ? error : null,
    descriptor: activeDescriptor,
    canonicalReady: stateMatchesIdentity && canonicalReady,
    items: projectedItems,
    canonicalItems: items,
    hasMore: stateMatchesIdentity ? page?.hasMore ?? false : false,
    atLatest: stateMatchesIdentity ? atLatest : true,
    loadingOlder: stateMatchesIdentity && loadingOlder,
    sending: stateMatchesIdentity
      ? sending : activeOperationKey !== null && sendBusyRef.current.has(activeOperationKey),
    interrupting: stateMatchesIdentity
      ? interrupting : activeOperationKey !== null && interruptBusyRef.current.has(activeOperationKey),
    localSubmissions,
    beginQueueSteer,
    observeQueueSnapshot,
    observeSubmissionSnapshot,
    settleQueueSteer,
    removeQueueSubmission,
    send, interrupt, loadOlder, loadLatest, downloadResource, retryOutgoing,
  };
}

export function canSendConversation(capabilities: ConversationCapabilities | undefined): boolean {
  return capabilities?.sendable === true || capabilities?.send?.includes('prompt') === true;
}
