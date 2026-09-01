import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationQueueAction,
  readConversationControls,
} from '../agentConversationControlsApi.js';
import { useAgentConversationControls } from './useAgentConversationControls.js';

vi.mock('../agentConversationControlsApi.js', () => ({
  readConversationControls: vi.fn(),
  conversationContextAction: vi.fn(),
  conversationGoalAction: vi.fn(),
  conversationQueueAction: vi.fn(),
  executeConversationCommand: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useAgentConversationControls', () => {
  it('refreshes the snapshot immediately after a mutation completes', async () => {
    vi.useFakeTimers();
    vi.mocked(readConversationControls)
      .mockResolvedValueOnce({
        queue: { items: [{ id: 'q1', text: 'before', createdAt: 1 }],
          canSteer: true, canEdit: false, canRemove: true },
      })
      .mockResolvedValueOnce({
        queue: { items: [{ id: 'q2', text: 'after', createdAt: 2 }],
          canSteer: true, canEdit: false, canRemove: true },
      });
    vi.mocked(conversationQueueAction).mockResolvedValue(null);
    const run = { agentId: 'future-agent', paneId: '%1', runId: 'run-1', sessionId: 's1' };
    const { result } = renderHook(() => useAgentConversationControls(run, true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('q1');

    await act(async () => { await result.current.queueAction('remove', 'q1'); });

    expect(readConversationControls).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('q2');
  });

  it('does not refresh the previous run when its mutation settles after a run switch', async () => {
    vi.useFakeTimers();
    let finishMutation!: () => void;
    vi.mocked(conversationQueueAction).mockImplementation(() => new Promise((resolve) => {
      finishMutation = () => resolve(null);
    }));
    vi.mocked(readConversationControls).mockImplementation(async (active) => ({
      queue: { items: [{ id: active.runId, text: active.runId, createdAt: 1 }],
        canSteer: true, canEdit: false, canRemove: true },
    }));
    const first = { agentId: 'future-agent', paneId: '%1', runId: 'run-1', sessionId: 's1' };
    const second = { ...first, paneId: '%2', runId: 'run-2', sessionId: 's2' };
    const { result, rerender } = renderHook(
      ({ run }) => useAgentConversationControls(run, true),
      { initialProps: { run: first } },
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('run-1');

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.queueAction('remove', 'run-1'); });
    rerender({ run: second });
    expect(result.current.snapshot).toBeNull();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('run-2');

    finishMutation();
    await act(async () => { await pending; });
    expect(readConversationControls).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('run-2');
  });

  it('keeps the last good failed slot while healthy slots continue updating', async () => {
    vi.useFakeTimers();
    vi.mocked(readConversationControls)
      .mockResolvedValueOnce({
        queue: { items: [], canSteer: true, canEdit: false, canRemove: false },
        plan: { steps: [{ step: 'first', status: 'inProgress' }] },
        context: { activity: 'working', branch: 'main' },
      })
      .mockResolvedValueOnce({
        queue: { items: [{ id: 'q2', text: 'next', createdAt: 2 }], canSteer: true,
          canEdit: false, canRemove: false },
        context: { activity: 'working', branch: 'feature' },
        slotErrors: { plan: 'temporarily unavailable' },
      });
    const run = { agentId: 'future-agent', paneId: '%1', runId: 'run-1', sessionId: 's1' };
    const { result } = renderHook(() => useAgentConversationControls(run, true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.snapshot?.plan?.steps[0]?.step).toBe('first');
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(result.current.status).toBe('degraded');
    expect(result.current.snapshot?.plan?.steps[0]?.step).toBe('first');
    expect(result.current.snapshot?.queue?.items[0]?.id).toBe('q2');
    expect(result.current.snapshot?.context?.branch).toBe('feature');
  });
});
