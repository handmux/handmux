import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getConversationRestartRecovery,
  recoverConversationRestart,
  restartConversation,
} from '../agentConversationRestartApi.js';
import { ApiError } from '../apiErrors.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { useConversationRestart } from './useConversationRestart.js';

vi.mock('../agentConversationRestartApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agentConversationRestartApi.js')>()),
  getConversationRestartRecovery: vi.fn(),
  recoverConversationRestart: vi.fn(),
  restartConversation: vi.fn(),
}));

const sessionId = '12345678-1234-1234-1234-123456789abc';
const run: AgentRunRef = { agentId: 'codex', paneId: '%8', runId: 'run-8', sessionId };
const receipt = {
  operationId: 'a'.repeat(64),
  recovery: { kind: 'codex_resume' as const, sessionId, command: `handmux codex resume ${sessionId}` },
  phase: 'stopped' as const,
  state: 'current' as const,
  canResume: true,
};
const readyReceipt = { ...receipt, phase: 'ready' as const, canResume: false };

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('useConversationRestart', () => {
  it('loads a pending operation from the selected pane without automatically resuming it', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(receipt);
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));

    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', receipt }));
    expect(recoverConversationRestart).not.toHaveBeenCalled();
  });

  it('posts the confirmed run once and clears the receipt only after the same-session ready result', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(null);
    vi.mocked(restartConversation).mockResolvedValue(readyReceipt);
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.restart(); });

    expect(restartConversation).toHaveBeenCalledTimes(1);
    expect(restartConversation).toHaveBeenCalledWith(run, expect.any(AbortSignal));
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
  });

  it('keeps the server recovery receipt when restart reports an error after an uncertain stop', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(null);
    vi.mocked(restartConversation).mockRejectedValue(new ApiError(
      'Codex restart could not be completed', 503, 'Codex restart could not be completed',
      'unavailable', null, null, receipt,
    ));
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.restart(); });

    expect(result.current).toMatchObject({ status: 'error', receipt });
  });

  it('keeps the conversation when the server confirms restart never stopped Codex', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(null);
    vi.mocked(restartConversation).mockRejectedValue(new ApiError(
      'The managed Codex process could not be verified', 409,
      'The managed Codex process could not be verified', 'not_started',
    ));
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.restart(); });

    expect(result.current).toMatchObject({
      status: 'error', receipt: null,
      error: 'The managed Codex process could not be verified',
    });
    expect(getConversationRestartRecovery).toHaveBeenCalledTimes(1);
  });

  it.each(['stale_run', 'unsupported'])(
    'keeps the conversation when the route rejects the restart as %s before dispatch', async (code) => {
      vi.mocked(getConversationRestartRecovery).mockResolvedValue(null);
      vi.mocked(restartConversation).mockRejectedValue(new ApiError(
        'The current run cannot restart', 409, 'The current run cannot restart', code,
      ));
      const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      await act(async () => { await result.current.restart(); });

      expect(result.current).toMatchObject({
        status: 'error', receipt: null, error: 'The current run cannot restart',
      });
    },
  );

  it('shows another browser’s pending restart when this browser submits a stale run', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    vi.mocked(restartConversation).mockRejectedValue(new ApiError(
      'stale agent run', 409, 'stale agent run', 'stale_run',
    ));
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => { await result.current.restart(); });

    expect(result.current).toMatchObject({ status: 'error', receipt, error: null });
    expect(getConversationRestartRecovery).toHaveBeenCalledTimes(2);
  });

  it('returns to the conversation after a stale-run lookup failure is later confirmed empty', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationRestartRecovery)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('temporarily offline'))
      .mockResolvedValueOnce(null);
    vi.mocked(restartConversation).mockRejectedValue(new ApiError(
      'stale agent run', 409, 'stale agent run', 'stale_run',
    ));
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.restart(); });
    expect(result.current.receipt).toMatchObject({ state: 'unknown' });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(result.current).toMatchObject({ status: 'error', receipt: null, error: 'stale agent run' });
    expect(getConversationRestartRecovery).toHaveBeenCalledTimes(3);
  });

  it('clears a confirmed pre-stop error before retrying and when changing panes', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(null);
    vi.mocked(restartConversation).mockRejectedValueOnce(new ApiError(
      'Codex identity changed', 409, 'Codex identity changed', 'not_started',
    )).mockResolvedValueOnce(readyReceipt);
    const { result, rerender } = renderHook(({ activePaneId }) => (
      useConversationRestart(run, true, undefined, activePaneId)
    ), { initialProps: { activePaneId: '%8' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.restart(); });
    expect(result.current.error).toBe('Codex identity changed');

    await act(async () => { await result.current.restart(); });
    expect(result.current).toMatchObject({ status: 'ready', receipt: null, error: null });

    vi.mocked(restartConversation).mockRejectedValueOnce(new ApiError(
      'Codex identity changed', 409, 'Codex identity changed', 'not_started',
    ));
    await act(async () => { await result.current.restart(); });
    rerender({ activePaneId: '%9' });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', receipt: null, error: null }));
  });

  it('keeps checking the original pane read-only after a lost restart response', async () => {
    vi.useFakeTimers();
    vi.mocked(getConversationRestartRecovery)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(readyReceipt);
    vi.mocked(restartConversation).mockRejectedValue(new Error('connection lost'));
    const { result } = renderHook(() => useConversationRestart(run, true, undefined, '%8'));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.restart(); });
    expect(result.current).toMatchObject({ status: 'error', receipt });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(getConversationRestartRecovery).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
    expect(recoverConversationRestart).not.toHaveBeenCalled();
  });

  it('does not carry a previous pane receipt across navigation to a pane without a Codex run', async () => {
    let resolveOld!: (value: typeof receipt) => void;
    vi.mocked(getConversationRestartRecovery)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(null);
    const { result, rerender } = renderHook(({ activePaneId }) => (
      useConversationRestart(run, true, undefined, activePaneId)
    ), { initialProps: { activePaneId: '%8' as string | null } });

    rerender({ activePaneId: '%9' });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', receipt: null }));
    await act(async () => { resolveOld(receipt); });
    expect(result.current).toMatchObject({ status: 'ready', receipt: null });
    expect(getConversationRestartRecovery).toHaveBeenCalledWith('%9', expect.any(AbortSignal));
    expect(recoverConversationRestart).not.toHaveBeenCalled();
  });

  it('keeps the old receipt hidden when the user disables the capability', async () => {
    vi.mocked(getConversationRestartRecovery).mockResolvedValue(receipt);
    const { result, rerender } = renderHook(({ enabled }) => (
      useConversationRestart(run, enabled, undefined, '%8')
    ), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.receipt).toEqual(receipt));

    rerender({ enabled: false });
    expect(result.current).toMatchObject({ status: 'idle', receipt: null });
  });
});
