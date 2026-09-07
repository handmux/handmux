import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getConversationActivationRecovery,
  recoverConversationActivation,
} from '../agentConversationActivationApi.js';
import { useConversationActivationRecovery } from './useConversationActivationRecovery.js';

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

  it('keeps recovery waiting past 30 seconds, slows polling, and finishes after late discovery', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn()
      .mockRejectedValueOnce(new Error('transient runtime gap'))
      .mockImplementation(async () => (discover.mock.calls.length === 77 ? {
        agentId: 'codex', paneId: '%1', runId: 'managed', sessionId: recovery.sessionId,
      } : null));
    const { result } = renderHook(() => useConversationActivationRecovery('%1', true, discover));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('ready');
    let operation!: Promise<void>;
    act(() => { operation = result.current.recover(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.status).toBe('waiting');
    expect(discover).toHaveBeenCalledTimes(76);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(discover).toHaveBeenCalledTimes(76);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await operation; });
    expect(discover).toHaveBeenCalledTimes(77);
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
  });

  it('stops recovery discovery when the page is left', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn(async () => null);
    const { result, unmount } = renderHook(() => useConversationActivationRecovery(
      '%1', true, discover,
    ));
    await act(async () => { await Promise.resolve(); });
    let operation!: Promise<void>;
    act(() => { operation = result.current.recover(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(32_000); });
    expect(result.current.status).toBe('waiting');
    const calls = discover.mock.calls.length;

    unmount();
    await act(async () => { await operation; await vi.advanceTimersByTimeAsync(10_000); });
    expect(discover).toHaveBeenCalledTimes(calls);
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
