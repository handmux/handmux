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
  vi.clearAllMocks();
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
