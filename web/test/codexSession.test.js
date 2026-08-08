import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { getCodexSession } from '../src/api.js';
import { codexKind, useCodexSession } from '../src/hooks/useCodexSession.js';

vi.mock('../src/api.js', () => ({ getCodexSession: vi.fn() }));

beforeEach(() => { getCodexSession.mockReset(); });
afterEach(cleanup);

describe('codexKind', () => {
  it('uses authoritative App Server wait states', () => {
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: [] } })).toBe('working');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })).toBe('permission');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })).toBe('permission');
  });

  it('does not inherit terminal-derived state for unmanaged sessions', () => {
    expect(codexKind({ managed: false })).toBeNull();
  });
});

describe('useCodexSession', () => {
  it('does not expose the previous pane session while the next pane loads', async () => {
    getCodexSession.mockImplementation((pane) => {
      if (pane === '%plain') return Promise.resolve({ managed: false });
      return new Promise(() => {});
    });
    const renders = [];
    const { result, rerender } = renderHook(
      ({ pane }) => {
        const session = useCodexSession(pane, true);
        renders.push({ pane, loaded: session.loaded, managed: session.managed });
        return session;
      },
      { initialProps: { pane: '%plain' } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    const nextRender = renders.length;
    rerender({ pane: '%managed' });

    expect(renders[nextRender]).toEqual({ pane: '%managed', loaded: false, managed: false });
  });

  it('keeps the last good session through a five-second connection grace period', async () => {
    vi.useFakeTimers();
    try {
      const good = { managed: true, threadId: 'thread-1', status: { type: 'idle' } };
      getCodexSession
        .mockResolvedValueOnce(good)
        .mockRejectedValue(new Error('temporary drop'));
      const { result } = renderHook(() => useCodexSession('%1', true));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toMatchObject({ loaded: true, managed: true, threadId: 'thread-1', error: null });

      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current).toMatchObject({ managed: true, threadId: 'thread-1', error: 'temporary drop' });

      getCodexSession.mockResolvedValue(good);
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the neutral loading state while an initial connection is still retrying', async () => {
    vi.useFakeTimers();
    try {
      getCodexSession.mockRejectedValue(new Error('temporary drop'));
      const { result } = renderHook(() => useCodexSession('%1', true));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toMatchObject({ loaded: false, error: null });

      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(result.current).toMatchObject({ loaded: false, error: null });
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current).toMatchObject({ loaded: true, error: 'temporary drop' });
    } finally {
      vi.useRealTimers();
    }
  });
});
