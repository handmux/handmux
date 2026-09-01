import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enableAgentIntegration,
  readAgentIntegrations,
} from '../agentIntegrationApi.js';
import { useAgentIntegrations } from './useAgentIntegrations.js';

vi.mock('../agentIntegrationApi.js', () => ({
  enableAgentIntegration: vi.fn(),
  readAgentIntegrations: vi.fn(),
}));

const disabled = [
  { name: 'claude' as const, status: 'not-enabled' as const },
  { name: 'pi' as const, status: 'ready' as const },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useAgentIntegrations', () => {
  it('keeps a mutation result when an older refresh completes later', async () => {
    vi.mocked(readAgentIntegrations).mockResolvedValueOnce(disabled);
    vi.mocked(enableAgentIntegration).mockResolvedValue({
      name: 'claude', status: 'ready', changed: true,
    });
    const { result } = renderHook(() => useAgentIntegrations());
    await waitFor(() => expect(result.current.items).toEqual(disabled));

    let finishRefresh!: () => void;
    vi.mocked(readAgentIntegrations).mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = () => resolve(disabled);
    }));
    let pendingRefresh!: Promise<void>;
    act(() => { pendingRefresh = result.current.refresh(); });
    await act(async () => { await result.current.enable('claude'); });
    expect(result.current.items[0]).toMatchObject({ name: 'claude', status: 'ready' });

    finishRefresh();
    await act(async () => { await pendingRefresh; });
    expect(result.current.items[0]).toMatchObject({ name: 'claude', status: 'ready' });
  });

  it('uses a valid non-ready mutation result without reporting a transport error', async () => {
    vi.mocked(readAgentIntegrations).mockResolvedValue(disabled);
    vi.mocked(enableAgentIntegration).mockResolvedValue({
      name: 'claude', status: 'conflict', changed: false,
    });
    const { result } = renderHook(() => useAgentIntegrations());
    await waitFor(() => expect(result.current.items).toEqual(disabled));

    await act(async () => { await result.current.enable('claude'); });

    expect(result.current.items[0]).toMatchObject({ name: 'claude', status: 'conflict' });
    expect(result.current.error).toBeNull();
  });
});
