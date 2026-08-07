// The 对话 lens's read-projection: poll /api/transcript for the pane's agent session, hash-gated省流.
// A null poll (204 unchanged) keeps the last messages — same discipline as the terminal loop.
//
// Paginated (Task 10): the client NEVER holds/requests the whole transcript. Two independent cursors:
//   - RECENT window (polled, 1500ms): `{since: recentHash, limit: 20}` — hash-gated conditional poll, a
//     204/null keeps the last state. Both Claude and Codex use their append-only durable logs, so each
//     normalized message keeps a stable ordinal identity.
//   - HISTORY page (`loadOlder()`, scroll-up only, never polled): `{before: oldestK, limit: 20}` — fetched
//     on demand, prepended and deduped by message identity. Resident messages are capped at
//     MAX_TRANSCRIPT_MESSAGES so leaving the lens open cannot grow phone memory without bound.
// `oldestK`/`hasMoreOlder` seed from the FIRST successful recent response (its `firstSeq`/`hasMore`) and
// are only ever pushed further back by `loadOlder()` — a later recent poll must not reset them (that would
// re-open "more to load" under a window that's actually already been paged past).
import { useState, useCallback, useEffect, useRef } from 'react';
import { usePollingLoop } from './usePollingLoop.js';
import { fetchTranscript } from '../api.js';

export const MAX_TRANSCRIPT_MESSAGES = 500;
export const TRANSCRIPT_PAGE_SIZE = 20;

// `k` is the stable normalized-log order/cursor. A source-provided id wins when present; otherwise the
// append-only ordinal is the render, dedup, and detail-sheet identity.
export function messageIdentity(message) {
  if (message?.id != null) return String(message.id);
  if (message?.k != null) return `k:${message.k}`;
  return `i:${message?.i ?? ''}`;
}

export function mergeTranscriptMessages(existing, incoming) {
  const byId = new Map(existing.map((message) => [messageIdentity(message), message]));
  for (const message of incoming) byId.set(messageIdentity(message), message);
  const merged = Array.from(byId.values()).sort((a, b) => (a.k ?? a.i ?? 0) - (b.k ?? b.i ?? 0));
  return merged.length > MAX_TRANSCRIPT_MESSAGES ? merged.slice(-MAX_TRANSCRIPT_MESSAGES) : merged;
}

export function useTranscript(pane, enabled, agent = 'claude', refreshToken = null) {
  const [messages, setMessages] = useState([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [session, setSession] = useState(null); // the session id `messages` belong to (ChatView's echo dedup)
  const [loaded, setLoaded] = useState(false); // has the FIRST response landed? (loading vs genuinely empty)
  const [unavailable, setUnavailable] = useState(null); // safe refusal, e.g. a Codex pane without exact hook binding
  const [unavailableDetail, setUnavailableDetail] = useState(null);
  const hashRef = useRef('');
  const oldestKRef = useRef(null);
  const seededRef = useRef(false); // has the older-page cursor been seeded from the first recent response?
  const loadingOlderRef = useRef(false);
  const sessionRef = useRef(null); // the session id the current `messages` belong to
  const messagesRef = useRef([]); // synchronous count/bound checks across poll + loadOlder callbacks
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
  const fetch = useCallback(() => fetchTranscript(pane, { since: hashRef.current, limit: TRANSCRIPT_PAGE_SIZE, agent }), [pane, agent]);
  const apply = useCallback((r) => {
    if (!r) return; // 204 / null → keep last
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
    } else {
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
    if (r.session) { sessionRef.current = r.session; setSession(r.session); }
  }, [agent]);

  usePollingLoop({
    fetch,
    apply,
    // A successful composer send starts a bounded retry burst because UserPromptSubmit may land just after
    // the send request returns. The steady cadence stays low-cost even if an unbound gate is left open.
    intervalMs: 1500,
    burstKey: refreshToken,
    burstIntervalMs: 500,
    burstCount: 3,
    enabled: enabled && !!pane,
    deps: [pane, agent],
  });

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreOlder || oldestKRef.current == null) return;
    if (messagesRef.current.length >= MAX_TRANSCRIPT_MESSAGES) { setHasMoreOlder(false); return; }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const epoch = epochRef.current;
    const requestedSession = sessionRef.current;
    try {
      const limit = Math.min(TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_MESSAGES - messagesRef.current.length);
      const r = await fetchTranscript(pane, { before: oldestKRef.current, limit, agent });
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

  return { messages, hasMoreOlder, loadOlder, loadingOlder, session, loaded, unavailable, unavailableDetail };
}
