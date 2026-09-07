import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getConversationActivationRecovery,
  recoverConversationActivation,
} from '../agentConversationActivationApi.js';
import { useConversationActivationRecovery } from './useConversationActivationRecovery.js';
import { UnauthorizedError } from '../apiErrors.js';

vi.mock('../agentConversationActivationApi.js', () => ({
  getConversationActivationRecovery: vi.fn(),
  recoverConversationActivation: vi.fn(),
}));

const recovery = {
  kind: 'codex_resume' as const,
  sessionId: '12345678-1234-1234-1234-123456789abc',
  command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
};
const receipt = {
  operationId: 'a'.repeat(64), recovery, phase: 'interrupted' as const,
  state: 'current' as const, canResume: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useConversationActivationRecovery', () => {
  it('retries failed lookups with backoff, stops on success, and never auto-posts recovery', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery)
      .mockRejectedValueOnce(new Error('server restarting'))
      .mockRejectedValueOnce(new Error('still restarting'))
      .mockResolvedValue(receipt);
    const { result } = renderHook(() => useConversationActivationRecovery('%1', true, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('unknown');
    await act(async () => { await vi.advanceTimersByTimeAsync(799); });
    expect(getConversationActivationRecovery).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(401); });
    expect(getConversationActivationRecovery).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    expect(result.current).toMatchObject({ status: 'ready', receipt });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getConversationActivationRecovery).toHaveBeenCalledTimes(3);
    expect(recoverConversationActivation).not.toHaveBeenCalled();
  });

  it.each(['pane switch', 'disabled', 'unmount'] as const)('cleans failed-lookup retries on %s', async (change) => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockRejectedValue(new Error('offline'));
    const { rerender, unmount } = renderHook(({ paneId, enabled }) => (
      useConversationActivationRecovery(paneId, enabled, vi.fn())
    ), { initialProps: { paneId: '%1', enabled: true } });
    await act(async () => { await Promise.resolve(); });
    const signal = vi.mocked(getConversationActivationRecovery).mock.calls[0]?.[1];
    if (change === 'unmount') unmount();
    else if (change === 'disabled') rerender({ paneId: '%1', enabled: false });
    else {
      vi.mocked(getConversationActivationRecovery).mockResolvedValue(null);
      rerender({ paneId: '%2', enabled: true });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(signal?.aborted).toBe(true);
    expect(vi.mocked(getConversationActivationRecovery).mock.calls.filter(([pane]) => pane === '%1'))
      .toHaveLength(1);
  });

  it('stops retries on authentication failure', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockRejectedValue(new UnauthorizedError());
    const onAuthFail = vi.fn();
    const { result } = renderHook(() => useConversationActivationRecovery('%1', true, vi.fn(), onAuthFail));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.status).toBe('unknown');
    expect(onAuthFail).toHaveBeenCalledTimes(1);
    expect(getConversationActivationRecovery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getConversationActivationRecovery).mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('ignores a late old-pane retry result after navigation', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: typeof receipt) => void;
    vi.mocked(getConversationActivationRecovery).mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(null);
    const { result, rerender } = renderHook(({ paneId }) => (
      useConversationActivationRecovery(paneId, true, vi.fn())
    ), { initialProps: { paneId: '%1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(getConversationActivationRecovery).toHaveBeenCalledTimes(2);
    rerender({ paneId: '%2' });
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
    await act(async () => { resolveOld(receipt); });
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
    expect(vi.mocked(getConversationActivationRecovery).mock.calls[1]?.[1]?.aborted).toBe(true);
  });

  it('cancels a pending lookup retry when the user explicitly recovers the retained receipt', async () => {
    vi.useFakeTimers();
    let rejectPost!: (error: Error) => void;
    vi.mocked(getConversationActivationRecovery).mockResolvedValueOnce(receipt)
      .mockRejectedValue(new Error('offline'));
    vi.mocked(recoverConversationActivation).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectPost = reject;
    }));
    const { result, unmount } = renderHook(() => useConversationActivationRecovery('%1', true, vi.fn()));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.retry());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('unknown');
    let operation!: Promise<void>;
    act(() => { operation = result.current.recover(); });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(result.current.status).toBe('recovering');
      expect(getConversationActivationRecovery).toHaveBeenCalledTimes(2);
      expect(recoverConversationActivation).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      rejectPost(new Error('cancelled'));
      await operation;
    }
  });

  it('does not query or preserve recovery UI when Codex Conversation is disabled', () => {
    const { result } = renderHook(() => useConversationActivationRecovery(
      '%1', false, vi.fn(),
    ));
    expect(result.current).toMatchObject({ status: 'idle', receipt: null });
    expect(getConversationActivationRecovery).not.toHaveBeenCalled();
  });

  it('reloads a durable receipt and enters chat only after exact managed discovery', async () => {
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn(async () => ({
      agentId: 'codex', paneId: '%1', runId: 'managed', sessionId: recovery.sessionId,
    }));
    const { result } = renderHook(() => useConversationActivationRecovery(
      '%1', true, discover,
    ));
    expect(result.current).toMatchObject({ status: 'loading', receipt: null });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', receipt }));
    await act(async () => { await result.current.recover(); });
    expect(recoverConversationActivation).toHaveBeenCalledWith(
      '%1', receipt.operationId, expect.any(AbortSignal),
    );
    expect(discover).toHaveBeenCalledWith('%1', recovery.sessionId);
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
  });

  it('keeps copy-only receipts and never submits an unsafe recovery', async () => {
    vi.mocked(getConversationActivationRecovery).mockResolvedValue({
      ...receipt, state: 'stale', canResume: false,
    });
    const { result } = renderHook(() => useConversationActivationRecovery(
      '%1', true, vi.fn(),
    ));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.recover(); });
    expect(recoverConversationActivation).not.toHaveBeenCalled();
    expect(result.current.receipt).toMatchObject({ state: 'stale', canResume: false });
  });

  it('does not finish on a different discovered Agent or session', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn()
      .mockResolvedValueOnce({
        agentId: 'claude', paneId: '%1', runId: 'wrong-agent', sessionId: recovery.sessionId,
      })
      .mockResolvedValueOnce({
        agentId: 'codex', paneId: '%1', runId: 'wrong-session', sessionId: 'other-session',
      })
      .mockResolvedValueOnce({
        agentId: 'codex', paneId: '%1', runId: 'managed', sessionId: recovery.sessionId,
      });
    const { result } = renderHook(() => useConversationActivationRecovery('%1', true, discover));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('ready');
    let operation!: Promise<void>;
    act(() => { operation = result.current.recover(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); await operation; });
    expect(discover).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
  });

  it('keeps recovery discovery bounded to 75 attempts', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn(async () => null);
    const { result } = renderHook(() => useConversationActivationRecovery('%1', true, discover));
    await act(async () => { await Promise.resolve(); });
    let operation!: Promise<void>;
    act(() => { operation = result.current.recover(); });
    await act(async () => { await vi.runAllTimersAsync(); await operation; });
    expect(result.current.status).toBe('error');
    expect(discover).toHaveBeenCalledTimes(75);
  });

  it('preserves the last receipt through a transient recovery lookup failure', async () => {
    vi.mocked(getConversationActivationRecovery)
      .mockResolvedValueOnce(receipt)
      .mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useConversationActivationRecovery(
      '%1', true, vi.fn(),
    ));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('unknown'));
    expect(result.current.receipt).toEqual(receipt);
  });

  it('atomically hides an old receipt on pane switch and cannot post it to the new pane', async () => {
    let resolvePaneTwo!: (value: null) => void;
    vi.mocked(getConversationActivationRecovery)
      .mockResolvedValueOnce(receipt)
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePaneTwo = resolve; }));
    const { result, rerender } = renderHook(({ paneId }) => useConversationActivationRecovery(
      paneId, true, vi.fn(),
    ), { initialProps: { paneId: '%1' } });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', receipt }));

    rerender({ paneId: '%2' });
    expect(result.current).toMatchObject({ status: 'loading', receipt: null });
    await act(async () => { await result.current.recover(); });
    expect(recoverConversationActivation).not.toHaveBeenCalled();
    await act(async () => resolvePaneTwo(null));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', receipt: null }));
  });
});
