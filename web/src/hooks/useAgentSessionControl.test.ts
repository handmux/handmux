import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readAgentModelControl,
  updateAgentModelControl,
} from '../agentSessionControlApi.js';
import type { AgentModelControlSnapshot } from '../agentSessionControlApi.js';
import { useAgentSessionControl } from './useAgentSessionControl.js';

vi.mock('../agentSessionControlApi.js', () => ({
  readAgentModelControl: vi.fn(),
  updateAgentModelControl: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const run = { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' };
const first: AgentModelControlSnapshot = {
  canUpdate: true,
  models: [{ id: 'p/one', label: 'One', efforts: [{ id: 'low' }] }],
  selected: { model: 'p/one', effort: 'low' },
};
const updated: AgentModelControlSnapshot = {
  canUpdate: true,
  models: [{ id: 'p/two', label: 'Two', efforts: [{ id: 'high' }] }],
  selected: { model: 'p/two', effort: 'high' },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useAgentSessionControl', () => {
  it('exposes no control for a legacy Connector without affecting the run', async () => {
    vi.mocked(readAgentModelControl).mockResolvedValue(null);
    const { result } = renderHook(() => useAgentSessionControl(run));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.modelControl).toBeNull();
  });

  it('keeps a read-only control visible and rejects writes without calling the API', async () => {
    vi.mocked(readAgentModelControl).mockResolvedValue({ ...first, canUpdate: false });
    const { result } = renderHook(() => useAgentSessionControl(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await expect(result.current.update({ effort: 'high' }))
      .rejects.toThrow('session_control_read_only');
    expect(result.current.modelControl).toEqual({ ...first, canUpdate: false });
    expect(updateAgentModelControl).not.toHaveBeenCalled();
  });

  it('serializes writes so a double activation cannot dispatch twice', async () => {
    vi.mocked(readAgentModelControl).mockResolvedValue(first);
    const pending = deferred<AgentModelControlSnapshot>();
    vi.mocked(updateAgentModelControl).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useAgentSessionControl(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let one!: Promise<void>;
    let two!: Promise<void>;
    act(() => {
      one = result.current.update({ effort: 'high' });
      two = result.current.update({ effort: 'high' });
    });
    expect(updateAgentModelControl).toHaveBeenCalledTimes(1);
    pending.resolve(updated);
    await act(async () => { await Promise.all([one, two]); });
    expect(result.current.modelControl).toEqual(updated);
  });

  it('does not let an older read overwrite the authoritative update response', async () => {
    const staleRead = deferred<AgentModelControlSnapshot | null>();
    vi.mocked(readAgentModelControl)
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(staleRead.promise);
    vi.mocked(updateAgentModelControl).mockResolvedValue(updated);
    const { result } = renderHook(() => useAgentSessionControl(run));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(readAgentModelControl).toHaveBeenCalledTimes(2));
    await act(async () => { await result.current.update({ model: 'p/two', effort: 'high' }); });
    expect(result.current.modelControl).toEqual(updated);
    staleRead.resolve(first);
    await act(async () => { await staleRead.promise; });
    expect(result.current.modelControl).toEqual(updated);
  });

  it('ignores a late update after switching to a replacement run', async () => {
    vi.mocked(readAgentModelControl).mockResolvedValue(first);
    const pending = deferred<AgentModelControlSnapshot>();
    vi.mocked(updateAgentModelControl).mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ active }) => useAgentSessionControl(active),
      { initialProps: { active: run } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let write!: Promise<void>;
    act(() => { write = result.current.update({ effort: 'high' }); });
    rerender({ active: { ...run, runId: 'run-2' } });
    await waitFor(() => expect(readAgentModelControl).toHaveBeenCalledTimes(2));
    pending.resolve(updated);
    await act(async () => { await write; });
    expect(result.current.modelControl).toEqual(first);
  });
});
