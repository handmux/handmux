import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../apiErrors.js';
import {
  activateConversation,
  describeConversationActivation,
} from '../agentConversationActivationApi.js';
import AgentConversationActivationGuide from '../components/AgentConversationActivationGuide.js';
import { useAgentConversationActivation } from './useAgentConversationActivation.js';

vi.mock('../agentConversationActivationApi.js', () => ({
  activateConversation: vi.fn(),
  describeConversationActivation: vi.fn(),
}));

const run = { agentId: 'future-agent', paneId: '%1', runId: 'run-1' };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useAgentConversationActivation', () => {
  it('confirms activation and waits until discovery publishes a managed session', async () => {
    vi.mocked(describeConversationActivation).mockResolvedValue({ effect: 'replace-process-preserve-session' });
    vi.mocked(activateConversation).mockResolvedValue();
    const discover = vi.fn(async () => ({ ...run, runId: 'run-2', sessionId: 'session-1' }));
    const { result } = renderHook(() => useAgentConversationActivation(run, true, discover));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.activate(); });
    expect(activateConversation).toHaveBeenCalledWith(run, expect.any(AbortSignal));
    expect(discover).toHaveBeenCalledWith(run);
  });

  it('maps a stale run to a retryable friendly state', async () => {
    vi.mocked(describeConversationActivation).mockResolvedValue({ effect: 'replace-process-preserve-session' });
    vi.mocked(activateConversation).mockRejectedValue(new ApiError(
      'stale agent run', 409, 'stale agent run', 'stale_run',
    ));
    const { result } = renderHook(() => useAgentConversationActivation(run, true, vi.fn()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.activate(); });
    expect(result.current).toMatchObject({ status: 'error', error: 'stale_run' });
  });

  it('times out discovery without exposing a provider response', async () => {
    vi.useFakeTimers();
    vi.mocked(describeConversationActivation).mockResolvedValue({ effect: 'replace-process-preserve-session' });
    vi.mocked(activateConversation).mockResolvedValue();
    const discover = vi.fn(async () => null);
    const { result } = renderHook(() => useAgentConversationActivation(run, true, discover));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('ready');
    let activation!: Promise<void>;
    act(() => { activation = result.current.activate(); });
    await act(async () => { await vi.runAllTimersAsync(); await activation; });
    expect(result.current).toMatchObject({ status: 'error', error: 'discovery_timeout' });
  });

  it('aborts an in-flight activation when the selected run is left', async () => {
    vi.mocked(describeConversationActivation).mockResolvedValue({
      effect: 'replace-process-preserve-session',
    });
    let signal: AbortSignal | undefined;
    vi.mocked(activateConversation).mockImplementation(async (_run, nextSignal) => {
      signal = nextSignal;
      await new Promise<void>((_resolve, reject) => {
        nextSignal?.addEventListener('abort', () => reject(nextSignal.reason), { once: true });
      });
    });
    const { result, unmount } = renderHook(() => useAgentConversationActivation(run, true, vi.fn()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => { void result.current.activate(); });
    await waitFor(() => expect(signal).toBeTruthy());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('AgentConversationActivationGuide', () => {
  it('keeps Terminal escape available and requires explicit confirmation', () => {
    const activate = vi.fn(async () => {});
    const onCancel = vi.fn();
    const controller = {
      status: 'ready' as const, descriptor: { effect: 'replace-process-preserve-session' as const },
      error: null, activate, retry: vi.fn(),
    };
    const { rerender } = render(<AgentConversationActivationGuide controller={controller}
      onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(activate).toHaveBeenCalledOnce();
    rerender(<AgentConversationActivationGuide controller={{ ...controller, status: 'waiting' }}
      onCancel={onCancel} />);
    const terminal = screen.getByRole('button', { name: '留在终端' });
    expect((terminal as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(terminal);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('offers retry after failure without rendering a private provider message', () => {
    const retry = vi.fn();
    const { container } = render(<AgentConversationActivationGuide controller={{
      status: 'error', descriptor: null, error: 'activation_failed', activate: vi.fn(), retry,
    }} onCancel={() => {}} />);
    expect(container.textContent).not.toContain('/Users/private');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
