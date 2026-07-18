// The 对话 lens's read-projection: poll /api/transcript for the pane's Claude session, hash-gated省流.
// A null poll (204 unchanged) keeps the last messages — same discipline as the terminal loop.
//
// Paginated (Task 10): the client NEVER holds/requests the whole transcript. Two independent cursors:
//   - RECENT window (polled, 1500ms): `{since: recentHash, limit: 20}` — hash-gated conditional poll, a
//     204/null keeps the last state. New messages MERGE into `messages` keyed by `k` (the server's stable
//     global ordinal, also the dedup key), kept sorted ascending.
//   - HISTORY page (`loadOlder()`, scroll-up only, never polled): `{before: oldestK, limit: 10}` — fetched
//     on demand, prepended (merged by `k`) ahead of the recent window.
// `oldestK`/`hasMoreOlder` seed from the FIRST successful recent response (its `firstSeq`/`hasMore`) and
// are only ever pushed further back by `loadOlder()` — a later recent poll must not reset them (that would
// re-open "more to load" under a window that's actually already been paged past).
import { useState, useCallback, useEffect, useRef } from 'react';
import { usePollingLoop } from './usePollingLoop.js';
import { fetchTranscript } from '../api.js';

// Merge `incoming` into the current k-keyed message map and return a new ascending-by-k array.
function mergeByK(existing, incoming) {
  const byK = new Map(existing.map((m) => [m.k, m]));
  for (const m of incoming) byK.set(m.k, m);
  return Array.from(byK.values()).sort((a, b) => a.k - b.k);
}

export function useTranscript(pane, enabled) {
  const [messages, setMessages] = useState([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [session, setSession] = useState(null); // the session id `messages` belong to (ChatView's echo dedup)
  const hashRef = useRef('');
  const oldestKRef = useRef(null);
  const seededRef = useRef(false); // has the older-page cursor been seeded from the first recent response?
  const loadingOlderRef = useRef(false);
  const sessionRef = useRef(null); // the session id the current `messages` belong to

  // Reset the省流 cursor + view whenever the pane changes, so switching panes doesn't briefly show the
  // previous session's messages nor skip re-fetching because a stale hash looks "unchanged".
  useEffect(() => {
    hashRef.current = '';
    oldestKRef.current = null;
    seededRef.current = false;
    loadingOlderRef.current = false;
    sessionRef.current = null;
    setMessages([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setSession(null);
  }, [pane]);

  // Initial + polling window: 20 (was 10) so a short first screen still fills — small transcripts / fresh
  // sessions were leaving blank space below with 10. History pages (loadOlder) stay 10 per scroll-up.
  const fetch = useCallback(() => fetchTranscript(pane, { since: hashRef.current, limit: 20 }), [pane]);
  const apply = useCallback((r) => {
    if (!r) return; // 204 / null → keep last
    hashRef.current = r.hash || '';
    const incoming = Array.isArray(r.messages) ? r.messages : [];
    // SESSION SWITCH (e.g. /clear started a new jsonl): REPLACE, never merge. k is a per-file ordinal that
    // restarts at 0 in the new session — merging by k would overwrite the head with the new messages but
    // strand the old session's higher-k tail on screen (the "/clear 没清屏" bug). The server's `session`
    // field is the switch signal; only act on a non-null id different from the one we're showing.
    if (r.session && sessionRef.current && r.session !== sessionRef.current) {
      setMessages(incoming);
      oldestKRef.current = r.firstSeq ?? null;
      setHasMoreOlder(!!r.hasMore);
      seededRef.current = true; // the older-page cursor restarts from the new session's window
    } else {
      setMessages((prev) => mergeByK(prev, incoming));
      // Seed the older-page cursor from the FIRST successful recent response only — once loadOlder has
      // started walking it back, later recent polls (a new hasMore/firstSeq for the tail window) must not
      // clobber it.
      if (!seededRef.current && !loadingOlderRef.current) {
        seededRef.current = true;
        oldestKRef.current = r.firstSeq ?? null;
        setHasMoreOlder(!!r.hasMore);
      }
    }
    if (r.session) { sessionRef.current = r.session; setSession(r.session); }
  }, []);

  usePollingLoop({ fetch, apply, intervalMs: 1500, enabled: enabled && !!pane, deps: [pane] });

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreOlder || oldestKRef.current == null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await fetchTranscript(pane, { before: oldestKRef.current, limit: 10 });
      if (!r) return;
      const incoming = Array.isArray(r.messages) ? r.messages : [];
      setMessages((prev) => mergeByK(prev, incoming));
      oldestKRef.current = r.firstSeq ?? oldestKRef.current;
      setHasMoreOlder(!!r.hasMore);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [pane, hasMoreOlder]);

  return { messages, hasMoreOlder, loadOlder, loadingOlder, session };
}
