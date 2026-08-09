// The 对话 lens's durable read-projection. Claude continuously polls /api/transcript with hash-gated省流.
// Codex loads one initial page, then its unified SSE snapshot/mutations own current state; completion,
// cursor reset, thread replacement, foreground return, or an explicit refresh token performs one HTTP
// calibration. A null response (204 unchanged) keeps the last messages.
//
// Paginated (Task 10): the client NEVER holds/requests the whole transcript. Two independent cursors:
//   - RECENT window: `{since: recentHash, limit: 20}` — Claude polls every 1500ms; Codex fetches only on
//     the explicit calibration triggers above. Both append-only logs keep stable ordinal identity.
//   - HISTORY page (`loadOlder()`, scroll-up only, never polled): `{before: oldestK, limit: 20}` — fetched
//     on demand, prepended and deduped by message identity. Resident messages are capped at
//     MAX_TRANSCRIPT_MESSAGES so leaving the lens open cannot grow phone memory without bound.
// `oldestK`/`hasMoreOlder` seed from the FIRST successful recent response (its `firstSeq`/`hasMore`) and
// are only ever pushed further back by `loadOlder()` — a later recent poll must not reset them (that would
// re-open "more to load" under a window that's actually already been paged past).
import { useState, useCallback, useEffect, useRef } from 'react';
import { usePollingLoop } from './usePollingLoop.js';
import { fetchTranscript } from '../api.js';
import { applyCodexConversationEvent } from '../codexConversationState.js';
import { parseCodexToolProjection } from '../../../server/src/codexToolProtocol.js';
import type { CodexToolProjection } from '../../../server/src/codexToolProtocol.js';
import type { CodexGoal, CodexGoalEvent } from '../../../server/src/codexStreamProtocol.js';
import type { CodexPlanStep } from '../../../server/src/codexPlan.js';
import type { CodexConversationEventLike } from '../codexConversationState.js';

export interface TranscriptMessage {
  [key: string]: unknown;
  id?: string;
  k?: number | string;
  i?: number | string;
  turnId?: string | null;
  itemId?: string | null;
  role?: string;
  type: string;
  text?: string;
  ts?: string;
  streaming?: boolean;
  completed?: boolean;
  tool?: CodexToolProjection;
  goal?: CodexGoal;
  event?: CodexGoalEvent;
  name?: string;
  args?: string;
  result?: string;
  plan?: CodexPlanStep[];
  steps?: CodexPlanStep[];
  explanation?: string;
}

interface TranscriptResponse {
  messages: TranscriptMessage[];
  hash: string;
  session: string | null;
  hasMore: boolean;
  firstSeq: number | null;
  unavailable: string | null;
  detail: string | null;
}

export interface TranscriptState {
  messages: TranscriptMessage[];
  hasMoreOlder: boolean;
  loadOlder: () => Promise<void>;
  loadingOlder: boolean;
  session: string | null;
  loaded: boolean;
  unavailable: string | null;
  unavailableDetail: string | null;
  applyCodexEvent: (event: CodexConversationEventLike & { messages?: TranscriptMessage[] }) => void;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const optionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value ? value : undefined
);

function parseTranscriptMessage(value: unknown): TranscriptMessage | null {
  const message = recordOf(value);
  if (!message || typeof message.type !== 'string' || !message.type) return null;
  const numberField = (key: 'k' | 'i'): number | undefined => (
    typeof message[key] === 'number' && Number.isFinite(message[key])
      ? message[key] as number : undefined
  );
  const tool = message.tool == null ? undefined : parseCodexToolProjection(message.tool);
  if (message.tool != null && !tool) return null;
  return {
    ...message,
    type: message.type,
    ...(optionalString(message.id) ? { id: optionalString(message.id) } : {}),
    ...(numberField('k') !== undefined ? { k: numberField('k') } : {}),
    ...(numberField('i') !== undefined ? { i: numberField('i') } : {}),
    ...(tool ? { tool } : {}),
  } as TranscriptMessage;
}

function parseTranscriptResponse(value: unknown): TranscriptResponse | null {
  if (value == null) return null;
  const response = recordOf(value);
  if (!response || !Array.isArray(response.messages)) throw new Error('Invalid transcript response');
  const messages = response.messages.map(parseTranscriptMessage)
    .filter((message): message is TranscriptMessage => message !== null);
  return {
    messages,
    hash: optionalString(response.hash) || '',
    session: optionalString(response.session) || null,
    hasMore: response.hasMore === true,
    firstSeq: typeof response.firstSeq === 'number' && Number.isFinite(response.firstSeq)
      ? response.firstSeq : null,
    unavailable: optionalString(response.unavailable) || null,
    detail: optionalString(response.detail) || null,
  };
}

function fetchTranscriptResponse(
  pane: string,
  options: { since?: string; before?: number; limit: number; agent: string },
): Promise<unknown> {
  const request = fetchTranscript as (
    targetPane: string,
    requestOptions: { since?: string; before?: number; limit: number; agent: string },
  ) => Promise<unknown>;
  return request(pane, options);
}

export const MAX_TRANSCRIPT_MESSAGES = 500;
export const TRANSCRIPT_PAGE_SIZE = 20;
// Match the session-status policy: transient App Server refusals stay behind the current/loading view.
const APP_SERVER_FAILURE_GRACE_MS = 5_000;

// `k` is the stable normalized-log order/cursor. A source-provided id wins when present; otherwise the
// append-only ordinal is the render, dedup, and detail-sheet identity.
export function messageIdentity(message: TranscriptMessage): string {
  if (message?.id != null) return String(message.id);
  if (message?.k != null) return `k:${message.k}`;
  return `i:${message?.i ?? ''}`;
}

export function mergeTranscriptMessages(
  existing: TranscriptMessage[],
  incoming: TranscriptMessage[],
): TranscriptMessage[] {
  const byId = new Map(existing.map((message) => [messageIdentity(message), message]));
  for (const message of incoming) byId.set(messageIdentity(message), message);
  const merged = Array.from(byId.values()).sort((a, b) => (
    Number(a.k ?? a.i ?? 0) - Number(b.k ?? b.i ?? 0)
  ));
  return merged.length > MAX_TRANSCRIPT_MESSAGES ? merged.slice(-MAX_TRANSCRIPT_MESSAGES) : merged;
}

export function useTranscript(
  pane: string,
  enabled: boolean,
  agent = 'claude',
  refreshToken: unknown = null,
): TranscriptState {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); // has the FIRST response landed? (loading vs genuinely empty)
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [unavailableDetail, setUnavailableDetail] = useState<string | null>(null);
  const hashRef = useRef('');
  const oldestKRef = useRef<number | null>(null);
  const seededRef = useRef(false); // has the older-page cursor been seeded from the first recent response?
  const loadingOlderRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const loadedRef = useRef(false);
  const appServerFailureSinceRef = useRef<number | null>(null);
  const epochRef = useRef(0); // invalidates an older-page request across pane/agent/session replacement

  // Reset the省流 cursor + view whenever the pane changes, so switching panes doesn't briefly show the
  // previous session's messages nor skip re-fetching because a stale hash looks "unchanged".
  useEffect(() => {
    epochRef.current += 1;
    hashRef.current = '';
    oldestKRef.current = null;
    seededRef.current = false;
    loadingOlderRef.current = false;
    sessionRef.current = null;
    messagesRef.current = [];
    loadedRef.current = false;
    appServerFailureSinceRef.current = null;
    setMessages([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setSession(null);
    setLoaded(false);
    setUnavailable(null);
    setUnavailableDetail(null);
  }, [pane, agent]);

  // Recent polling and scroll-up history use the same 20-message page size. Auto-fill in ChatView pulls
  // additional history pages when even 20 compact messages do not fill the phone viewport.
  const fetch = useCallback(() => fetchTranscriptResponse(
    pane, { since: hashRef.current, limit: TRANSCRIPT_PAGE_SIZE, agent },
  ), [pane, agent]);
  const apply = useCallback((value: unknown): void => {
    const r = parseTranscriptResponse(value);
    if (!r) {
      // A 204 is still a successful App Server check. It proves a previous connection refusal recovered
      // even though the transcript hash itself did not change.
      appServerFailureSinceRef.current = null;
      setUnavailable(null);
      setUnavailableDetail(null);
      return; // 204 / null → keep last
    }
    if (r.unavailable === 'app-server-unavailable') {
      const now = Date.now();
      if (appServerFailureSinceRef.current == null) appServerFailureSinceRef.current = now;
      if (now - appServerFailureSinceRef.current < APP_SERVER_FAILURE_GRACE_MS) return;
      // This is a capability outage, not a session identity change. Keep the last verified transcript
      // behind the connection gate so a short reconnect never destroys and rebuilds the visible chat.
      setLoaded(true);
      setUnavailable(r.unavailable);
      setUnavailableDetail(r.detail || null);
      return;
    }
    appServerFailureSinceRef.current = null;
    const alreadyLoaded = loadedRef.current;
    loadedRef.current = true;
    setLoaded(true); // first real response: from now on an empty list means an empty SESSION, not loading
    hashRef.current = r.hash || '';
    if (r.unavailable) {
      // Never leave a previously loaded pane/session behind a new refusal response: stale content would
      // look like it belongs to the current pane, defeating the server's safety boundary.
      messagesRef.current = [];
      epochRef.current += 1;
      loadingOlderRef.current = false;
      sessionRef.current = null;
      oldestKRef.current = null;
      seededRef.current = false;
      setMessages([]);
      setLoadingOlder(false);
      setSession(null);
      setHasMoreOlder(false);
      setUnavailable(r.unavailable);
      setUnavailableDetail(r.detail || null);
      return;
    }
    setUnavailable(null);
    setUnavailableDetail(null);
    const incoming = Array.isArray(r.messages) ? r.messages : [];
    // SESSION SWITCH (e.g. /clear started a new thread/file): REPLACE, never reconcile. The server's `session`
    // field is the switch signal; only act on a non-null id different from the one we're showing.
    if (r.session && sessionRef.current && r.session !== sessionRef.current) {
      epochRef.current += 1;
      loadingOlderRef.current = false;
      messagesRef.current = incoming.slice(-MAX_TRANSCRIPT_MESSAGES);
      setMessages(messagesRef.current);
      setLoadingOlder(false);
      oldestKRef.current = r.firstSeq ?? null;
      setHasMoreOlder(!!r.hasMore);
      seededRef.current = true; // the older-page cursor restarts from the new session's window
    } else if (agent !== 'codex' || !alreadyLoaded) {
      messagesRef.current = mergeTranscriptMessages(messagesRef.current, incoming);
      setMessages(messagesRef.current);
      // Seed the older-page cursor from the FIRST successful recent response only — once loadOlder has
      // started walking it back, later recent polls (a new hasMore/firstSeq for the tail window) must not
      // clobber it.
      if (!seededRef.current && !loadingOlderRef.current) {
        seededRef.current = true;
        oldestKRef.current = r.firstSeq ?? null;
        setHasMoreOlder(!!r.hasMore);
      }
      if (messagesRef.current.length >= MAX_TRANSCRIPT_MESSAGES) setHasMoreOlder(false);
    }
    // After the initial Codex bootstrap, this HTTP request only asks Server to reconcile rollout. The
    // resulting conversationSnapshot arrives through the ordered SSE stream and is the sole current-state
    // mutation; applying the response here as well would recreate the two-channel projection race.
    if (r.session) { sessionRef.current = r.session; setSession(r.session); }
  }, [agent]);

  const applyCodexEvent = useCallback((event: CodexConversationEventLike & {
    messages?: TranscriptMessage[];
  }): void => {
    const projected = event?.type === 'conversationSnapshot' && Array.isArray(event.messages)
      ? mergeTranscriptMessages(messagesRef.current, event.messages)
      : applyCodexConversationEvent(messagesRef.current, event);
    if (projected === messagesRef.current) return;
    const next = projected.map(parseTranscriptMessage)
      .filter((message): message is TranscriptMessage => message !== null);
    messagesRef.current = next.length > MAX_TRANSCRIPT_MESSAGES
      ? next.slice(-MAX_TRANSCRIPT_MESSAGES)
      : next;
    setMessages(messagesRef.current);
  }, []);

  usePollingLoop({
    fetch,
    apply,
    // A successful composer send starts a bounded retry burst because UserPromptSubmit may land just after
    // the send request returns. The steady cadence stays low-cost even if an unbound gate is left open.
    intervalMs: 1500,
    burstKey: refreshToken,
    burstIntervalMs: 500,
    burstCount: 3,
    repeat: agent !== 'codex',
    enabled: enabled && !!pane,
    deps: [pane, agent],
  });

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current || !hasMoreOlder || oldestKRef.current == null) return;
    if (messagesRef.current.length >= MAX_TRANSCRIPT_MESSAGES) { setHasMoreOlder(false); return; }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const epoch = epochRef.current;
    const requestedSession = sessionRef.current;
    try {
      const limit = Math.min(TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_MESSAGES - messagesRef.current.length);
      const r = parseTranscriptResponse(await fetchTranscriptResponse(
        pane, { before: oldestKRef.current, limit, agent },
      ));
      if (!r) return;
      if (epoch !== epochRef.current || requestedSession !== sessionRef.current
        || (r.session && requestedSession && r.session !== requestedSession)) return;
      const incoming = Array.isArray(r.messages) ? r.messages : [];
      messagesRef.current = mergeTranscriptMessages(messagesRef.current, incoming);
      setMessages(messagesRef.current);
      oldestKRef.current = r.firstSeq ?? oldestKRef.current;
      setHasMoreOlder(!!r.hasMore && messagesRef.current.length < MAX_TRANSCRIPT_MESSAGES);
    } finally {
      if (epoch === epochRef.current) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [pane, agent, hasMoreOlder]);

  return {
    messages, hasMoreOlder, loadOlder, loadingOlder, session, loaded, unavailable, unavailableDetail,
    applyCodexEvent,
  };
}
