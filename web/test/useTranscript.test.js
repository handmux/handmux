import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { useTranscript } from '../src/hooks/useTranscript.js';
import * as api from '../src/api.js';

beforeEach(() => { vi.restoreAllMocks(); });
// This repo doesn't run vitest with globals:true — without manual cleanup each renderHook's hook stays
// MOUNTED into the next test, and its live poll loop keeps calling fetchTranscript… which then steals the
// NEXT test's mockResolvedValueOnce chain (the response chain is shared per spy, across all callers).
afterEach(cleanup);

function makeMsgs(startK, count) {
  return Array.from({ length: count }, (_, idx) => ({
    k: startK + idx, i: startK + idx, role: idx % 2 === 0 ? 'user' : 'assistant', type: 'text', text: `m${startK + idx}`,
  }));
}

describe('useTranscript', () => {
  it('polls the recent window and returns messages; keeps last on a null (204) poll', async () => {
    const recent = makeMsgs(10, 10); // k=10..19
    const spy = vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: recent, hash: 'h1', session: 's', hasMore: true, firstSeq: 10 })
      .mockResolvedValue(null); // subsequent polls: unchanged
    const { result } = renderHook(() => useTranscript('%0', true));
    await waitFor(() => expect(result.current.messages.length).toBe(10));
    expect(result.current.messages[0].text).toBe('m10');
    expect(result.current.hasMoreOlder).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('does not poll when disabled', async () => {
    const spy = vi.spyOn(api, 'fetchTranscript').mockResolvedValue(null);
    renderHook(() => useTranscript('%0', false));
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('loadOlder() prepends an older page, deduped/sorted by k', async () => {
    const recent = makeMsgs(10, 10); // k=10..19
    const older = makeMsgs(5, 5); // k=5..9
    const spy = vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: recent, hash: 'h1', session: 's', hasMore: true, firstSeq: 10 })
      .mockResolvedValue(null); // steady-state recent polls: unchanged
    const { result } = renderHook(() => useTranscript('%0', true));
    await waitFor(() => expect(result.current.messages.length).toBe(10));

    spy.mockResolvedValueOnce({ messages: older, session: 's', hasMore: false, firstSeq: 5 });
    await act(async () => { await result.current.loadOlder(); });

    await waitFor(() => expect(result.current.messages.length).toBe(15));
    expect(result.current.messages.map((m) => m.k)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(result.current.hasMoreOlder).toBe(false);

    // the loadOlder call itself must have asked for `before: oldestK` (=10), limit 10
    expect(spy).toHaveBeenCalledWith('%0', expect.objectContaining({ before: 10, limit: 10 }));
  });

  it('a session switch (e.g. /clear → new jsonl) REPLACES messages — k restarts at 0, so merging would strand the old tail', async () => {
    const oldMsgs = makeMsgs(30, 10); // old session's window, k=30..39
    const newMsgs = makeMsgs(0, 2);   // new session starts over at k=0..1
    vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: oldMsgs, hash: 'h1', session: 'sess-old', hasMore: true, firstSeq: 30 })
      .mockResolvedValueOnce({ messages: newMsgs, hash: 'h2', session: 'sess-new', hasMore: false, firstSeq: 0 })
      .mockResolvedValue(null);
    const { result } = renderHook(() => useTranscript('%0', true));
    await waitFor(() => expect(result.current.messages.length).toBe(10));
    // the session switch lands on the SECOND poll tick (1.5s) — give waitFor room beyond the default 1s
    await waitFor(() => expect(result.current.messages.map((m) => m.text)).toEqual(['m0', 'm1']), { timeout: 3000 });
    expect(result.current.messages.some((m) => m.text === 'm39')).toBe(false); // no stale tail survives
    expect(result.current.hasMoreOlder).toBe(false); // older-page cursor restarted from the new session
  });

  it('same-session polls keep merging by k (no spurious replace)', async () => {
    const w1 = makeMsgs(10, 10);
    const w2 = makeMsgs(12, 10); // window slid forward, overlapping k
    vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: w1, hash: 'h1', session: 's', hasMore: true, firstSeq: 10 })
      .mockResolvedValueOnce({ messages: w2, hash: 'h2', session: 's', hasMore: true, firstSeq: 12 })
      .mockResolvedValue(null);
    const { result } = renderHook(() => useTranscript('%0', true));
    await waitFor(() => expect(result.current.messages.length).toBe(10));
    await waitFor(() => expect(result.current.messages.length).toBe(12), { timeout: 3000 }); // second poll tick (1.5s): k=10..21 merged, deduped
    expect(result.current.messages[0].text).toBe('m10');
  });
});
