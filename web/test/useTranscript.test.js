import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { useTranscript, mergeTranscriptMessages, MAX_TRANSCRIPT_MESSAGES } from '../src/hooks/useTranscript.js';
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
  it('bounds the resident message window while keeping the newest messages', () => {
    const existing = makeMsgs(0, MAX_TRANSCRIPT_MESSAGES);
    const merged = mergeTranscriptMessages(existing, makeMsgs(MAX_TRANSCRIPT_MESSAGES, 10));
    expect(merged).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    expect(merged[0].k).toBe(10);
    expect(merged.at(-1).k).toBe(MAX_TRANSCRIPT_MESSAGES + 9);
  });

  it('updates a completed tool in place when its rollout result arrives', () => {
    const existing = [
      { k: 9, type: 'text', text: '需求' },
      { k: 10, type: 'tool', tool: { name: 'exec_command', result: null } },
    ];
    const incoming = [
      { k: 10, type: 'tool', tool: { name: 'exec_command', result: 'done' } },
    ];
    const merged = mergeTranscriptMessages(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[1].tool.result).toBe('done');
  });

  it('merges a unified stream snapshot into the same resident message state', async () => {
    vi.spyOn(api, 'fetchTranscript').mockResolvedValueOnce({
      messages: [{ id: 'user-1', k: 0, role: 'user', type: 'text', text: '开始' }],
      hash: 'h', session: 'thread-1', hasMore: false, firstSeq: 0,
    });
    const { result } = renderHook(() => useTranscript('%0', true, 'codex'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => result.current.applyCodexEvent({
      type: 'conversationSnapshot', cursor: 2,
      messages: [
        { id: 'user-1', k: 0, role: 'user', type: 'text', text: '开始' },
        { id: 'codex:turn-1:agent-1', k: 1, role: 'assistant', type: 'text', text: '完成' },
      ],
    }));
    expect(result.current.messages.map((message) => message.text)).toEqual(['开始', '完成']);
  });
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

  it('passes the selected agent to recent transcript polling', async () => {
    const spy = vi.spyOn(api, 'fetchTranscript').mockResolvedValue({ messages: [], hash: 'h', session: 'cx', hasMore: false, firstSeq: null });
    renderHook(() => useTranscript('%0', true, 'codex'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith('%0', expect.objectContaining({ agent: 'codex' }));
  });

  it('triggers rollout reconciliation on refresh but applies current state only from SSE', async () => {
    const spy = vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: makeMsgs(0, 1), hash: 'h1', session: 's', hasMore: false, firstSeq: 0 })
      .mockResolvedValueOnce({ messages: makeMsgs(0, 2), hash: 'h2', session: 's', hasMore: false, firstSeq: 0 })
      .mockResolvedValue(null);
    const { result, rerender } = renderHook(
      ({ refreshToken }) => useTranscript('%0', true, 'codex', refreshToken),
      { initialProps: { refreshToken: null } },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    rerender({ refreshToken: 1 });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(result.current.messages).toHaveLength(1);
    act(() => result.current.applyCodexEvent({
      type: 'conversationSnapshot', cursor: 2, messages: makeMsgs(0, 2),
    }));
    expect(result.current.messages).toHaveLength(2);
  });

  it('clears previously loaded content when the server refuses an unbound Codex session', async () => {
    vi.spyOn(api, 'fetchTranscript')
      .mockResolvedValueOnce({ messages: makeMsgs(0, 2), hash: 'h1', session: 'old', hasMore: false, firstSeq: 0 })
      .mockResolvedValueOnce({ messages: [], hash: '', session: null, hasMore: false, firstSeq: null, unavailable: 'session-unbound' })
      .mockResolvedValue(null);
    const { result, rerender } = renderHook(
      ({ refreshToken }) => useTranscript('%0', true, 'codex', refreshToken),
      { initialProps: { refreshToken: 0 } },
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    rerender({ refreshToken: 1 });
    await waitFor(() => expect(result.current.unavailable).toBe('session-unbound'));
    expect(result.current.messages).toEqual([]);
    expect(result.current.session).toBeNull();
  });

  it('keeps the last transcript through a five-second App Server grace period', async () => {
    vi.useFakeTimers();
    try {
      const unavailable = {
        messages: [], hash: '', session: null, hasMore: false, firstSeq: null,
        unavailable: 'app-server-unavailable', detail: 'temporary disconnect',
      };
      vi.spyOn(api, 'fetchTranscript')
        .mockResolvedValueOnce({ messages: makeMsgs(0, 2), hash: 'h1', session: 'thread-1', hasMore: false, firstSeq: 0 })
        .mockResolvedValue(unavailable);
      const { result, rerender } = renderHook(
        ({ refreshToken }) => useTranscript('%0', true, 'codex', refreshToken),
        { initialProps: { refreshToken: 0 } },
      );
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.messages).toHaveLength(2);

      rerender({ refreshToken: 1 });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.unavailable).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
      expect(result.current.unavailable).toBeNull();
      rerender({ refreshToken: 2 });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toMatchObject({
        unavailable: 'app-server-unavailable', unavailableDetail: 'temporary disconnect',
        session: 'thread-1',
      });
      expect(result.current.messages).toHaveLength(2);

      api.fetchTranscript.mockResolvedValue(null);
      rerender({ refreshToken: 3 });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.unavailable).toBeNull();
      expect(result.current.messages).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadOlder() prepends an older page, deduped by identity and sorted by k', async () => {
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

    // recent and history pages use the same 20-message batch size
    expect(spy).toHaveBeenCalledWith('%0', expect.objectContaining({ before: 10, limit: 20 }));
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

  it('drops an older-page response that finishes after the session has switched', async () => {
    vi.useFakeTimers();
    try {
      let resolveOlder;
      const spy = vi.spyOn(api, 'fetchTranscript')
        .mockResolvedValueOnce({ messages: makeMsgs(20, 2), hash: 'old', session: 'sess-old', hasMore: true, firstSeq: 20 })
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
        .mockResolvedValueOnce({ messages: makeMsgs(0, 1), hash: 'new', session: 'sess-new', hasMore: false, firstSeq: 0 })
        .mockResolvedValue(null);
      const { result, rerender } = renderHook(
        ({ refreshToken }) => useTranscript('%0', true, 'codex', refreshToken),
        { initialProps: { refreshToken: 0 } },
      );
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.session).toBe('sess-old');

      let olderPromise;
      act(() => { olderPromise = result.current.loadOlder(); });
      rerender({ refreshToken: 1 });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.session).toBe('sess-new');

      await act(async () => {
        resolveOlder({ messages: makeMsgs(10, 10), session: 'sess-old', hasMore: false, firstSeq: 10 });
        await olderPromise;
      });
      expect(result.current.messages.map((message) => message.text)).toEqual(['m0']);
      expect(result.current.loadingOlder).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('same-session Claude polls keep merging their append-only windows', async () => {
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
