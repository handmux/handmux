import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock('../src/api.js', () => ({ getConfig: api.getConfig }));

import { useServerShortcuts, SHORTCUT_REFRESH_MS } from '../src/hooks/useServerShortcuts.js';

afterEach(() => { cleanup(); vi.useRealTimers(); api.getConfig.mockReset(); });

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('useServerShortcuts', () => {
  it('refreshes a mounted page so a server restart can apply changed presets', async () => {
    vi.useFakeTimers();
    const first = { command: [], chat: [{ type: 'text', text: 'old', enter: true }] };
    const second = { command: [], chat: [{ type: 'text', text: 'new', enter: true }] };
    api.getConfig.mockResolvedValueOnce({ shortcuts: first }).mockResolvedValue({ shortcuts: second });
    const { result } = renderHook(() => useServerShortcuts());
    await flush();
    expect(result.current).toEqual(first);
    await act(async () => { await vi.advanceTimersByTimeAsync(SHORTCUT_REFRESH_MS); });
    await flush();
    expect(result.current).toEqual(second);
  });

  it('uses an injected shortcut set without polling the API', async () => {
    const injected = { command: [], chat: [] };
    const { result } = renderHook(() => useServerShortcuts(injected));
    await flush();
    expect(result.current).toBe(injected);
    expect(api.getConfig).not.toHaveBeenCalled();
  });
});
