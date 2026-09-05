import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../apiErrors.js';
import {
  activateConversation,
  describeConversationActivation,
} from '../agentConversationActivationApi.js';
import AgentConversationActivationGuide from '../components/AgentConversationActivationGuide.js';
import CodexManagedGuide from '../components/CodexManagedGuide.js';
import { useConversationActivationTarget } from '../conversationActivationTarget.js';
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
    expect(discover).toHaveBeenCalledTimes(75);
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

describe('CodexManagedGuide', () => {
  const readyController = () => ({
    status: 'ready' as const,
    descriptor: { effect: 'replace-process-preserve-session' as const },
    error: null,
    activate: vi.fn(async () => {}),
    retry: vi.fn(),
  });

  it('restores the managed page and requires destructive confirmation', async () => {
    const controller = readyController();
    const onActivationChange = vi.fn();
    render(<CodexManagedGuide run={{ ...run, agentId: 'codex' }} controller={controller}
      onActivationChange={onActivationChange} onTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: '接入 Codex 对话' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    expect(controller.activate).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '开始托管？' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '结束并开始托管' }));
    await waitFor(() => expect(controller.activate).toHaveBeenCalledOnce());
    expect(onActivationChange).toHaveBeenCalledWith({ ...run, agentId: 'codex' }, true);
  });

  it('reveals the Terminal escape only after ten seconds while starting', async () => {
    vi.useFakeTimers();
    const controller = { ...readyController(), status: 'waiting' as const };
    render(<CodexManagedGuide run={{ ...run, agentId: 'codex' }} controller={controller}
      onActivationChange={() => {}} onTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: '正在启动托管' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '前往终端' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(screen.queryByRole('button', { name: '前往终端' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: '前往终端' })).toBeTruthy();
  });

  it('keeps the timeout page pinned but clears the pin on activation failure', async () => {
    const onActivationChange = vi.fn();
    const { rerender } = render(<CodexManagedGuide run={{ ...run, agentId: 'codex' }} controller={{
      ...readyController(), status: 'error', error: 'discovery_timeout',
    }} onActivationChange={onActivationChange} onTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: '托管仍未就绪' })).toBeTruthy();
    expect(onActivationChange).not.toHaveBeenCalled();
    rerender(<CodexManagedGuide run={{ ...run, agentId: 'codex' }} controller={{
      ...readyController(), status: 'error', error: 'activation_failed',
    }} onActivationChange={onActivationChange} onTerminal={() => {}} />);
    await waitFor(() => expect(onActivationChange)
      .toHaveBeenCalledWith({ ...run, agentId: 'codex' }, false));
  });

  it('does not submit twice and exposes explicit Terminal exit', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const controller = { ...readyController(), activate: vi.fn(() => pending) };
    const onTerminal = vi.fn();
    render(<CodexManagedGuide run={{ ...run, agentId: 'codex' }} controller={controller}
      onActivationChange={() => {}} onTerminal={onTerminal} />);
    fireEvent.click(screen.getByRole('button', { name: '前往终端' }));
    expect(onTerminal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    const confirm = screen.getByRole('button', { name: '结束并开始托管' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(controller.activate).toHaveBeenCalledOnce();
    release();
    await act(async () => { await pending; });
  });

  it('keeps a failed takeover page after releasing ownership, then re-pins on retry', async () => {
    const codexRun = { ...run, agentId: 'codex' };
    const controller = {
      ...readyController(), status: 'error' as const, error: 'activation_failed' as const,
    };
    function Harness() {
      const activation = useConversationActivationTarget({
        paneId: '%1', rootView: 'session', lens: 'chat', runs: [],
        isConversationEnabled: () => true,
      });
      return <>
        <button type="button" onClick={() => activation.setPending(codexRun, true)}>begin</button>
        <span data-testid="ownership">{activation.ownershipPin ? 'owned' : 'released'}</span>
        {activation.displayTarget ? <CodexManagedGuide run={activation.displayTarget.run}
          controller={controller} onActivationChange={activation.setPending}
          onTerminal={activation.clear} /> : null}
      </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'begin' }));
    await waitFor(() => expect(screen.getByTestId('ownership').textContent).toBe('released'));
    expect(screen.getByText('托管启动未能完成。你可以重试，或前往终端查看当前状态。'))
      .toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    fireEvent.click(screen.getByRole('button', { name: '结束并开始托管' }));
    await waitFor(() => expect(screen.getByTestId('ownership').textContent).toBe('owned'));
    expect(controller.activate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '前往终端' }));
    await waitFor(() => expect(screen.queryByText('托管启动未能完成。你可以重试，或前往终端查看当前状态。'))
      .toBeNull());
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
