import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { renderHook, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock('../src/api.js', () => ({ getConfig: api.getConfig }));

import { parseServerConfig, useServerConfig } from '../src/hooks/useServerConfig.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  api.getConfig.mockReset();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const setHidden = (hidden) => {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useServerConfig', () => {
  it('validates config capabilities and shortcut entries at the network boundary', () => {
    expect(parseServerConfig(null)).toBeNull();
    expect(parseServerConfig({
      asr: 'yes', browserProxy: true, claudeHooks: 'unknown',
      shortcuts: {
        command: [{ type: 'key', key: 'C-c', label: 'Ctrl+C' }, { type: 'key', key: 7 }],
        chat: [{ type: 'text', text: 'ok', enter: true }, null],
      },
    })).toEqual({
      browserProxy: true,
      shortcuts: {
        command: [{ type: 'key', key: 'C-c', label: 'Ctrl+C' }],
        chat: [{ type: 'text', text: 'ok', enter: true }],
      },
    });
    expect(parseServerConfig({
      asr: true, asrProvider: 'tencent', asrMode: 'sentence', shortcuts: { command: [], chat: [] },
    })).toMatchObject({ asr: true, asrProvider: 'tencent', asrMode: 'sentence' });
  });

  it('fetches at launch and whenever the app returns to the foreground, without polling', async () => {
    vi.useFakeTimers();
    const first = { command: [], chat: [{ type: 'text', text: 'old', enter: true }] };
    const second = { command: [], chat: [{ type: 'text', text: 'new', enter: true }] };
    const initial = { shortcuts: first, asr: true, claudeHooks: 'absent' };
    const refreshed = { shortcuts: second, asr: false, claudeHooks: 'installed' };
    api.getConfig.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => useServerConfig());
    await flush();
    expect(result.current).toEqual(initial);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    setHidden(true);
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    setHidden(false);
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(refreshed);
  });

  it('does not start a duplicate request when the app returns while one is in flight', async () => {
    let resolveInitial;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    api.getConfig.mockReturnValueOnce(initial).mockResolvedValue({ shortcuts: { command: [], chat: [] } });
    renderHook(() => useServerConfig());
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    setHidden(true);
    setHidden(false);
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    await act(async () => { resolveInitial({ shortcuts: { command: [], chat: [] } }); await initial; });
    setHidden(true);
    setHidden(false);
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
  });

  it('does not request through a stale visibility listener after authentication is disabled', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    api.getConfig.mockResolvedValue({ shortcuts: { command: [], chat: [] } });
    const { rerender } = renderHook(
      ({ enabled }) => useServerConfig({ enabled }),
      { initialProps: { enabled: true } },
    );
    await flush();
    const onVisibility = addListener.mock.calls.find(([type]) => type === 'visibilitychange')[1];
    rerender({ enabled: false });
    onVisibility();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it('does not request through a stale visibility listener after unmount', async () => {
    const addListener = vi.spyOn(document, 'addEventListener');
    api.getConfig.mockResolvedValue({ shortcuts: { command: [], chat: [] } });
    const { unmount } = renderHook(() => useServerConfig());
    await flush();
    const onVisibility = addListener.mock.calls.find(([type]) => type === 'visibilitychange')[1];
    unmount();
    onVisibility();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it('discards a response from an earlier authentication cycle', async () => {
    let resolveInitial;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    api.getConfig.mockReturnValue(initial);
    const { result, rerender } = renderHook(
      ({ enabled }) => useServerConfig({ enabled }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {
      resolveInitial({ shortcuts: { command: [], chat: [] }, asr: true });
      await initial;
    });
    expect(result.current).toBeNull();
  });

  it('does not duplicate the startup request under StrictMode', async () => {
    api.getConfig.mockResolvedValue({ shortcuts: { command: [], chat: [] } });
    renderHook(() => useServerConfig(), { wrapper: StrictMode });
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it('waits for authentication before making its initial request', async () => {
    const config = { shortcuts: { command: [], chat: [] }, asr: false, claudeHooks: 'installed' };
    api.getConfig.mockResolvedValue(config);
    const { result, rerender } = renderHook(
      ({ enabled }) => useServerConfig({ enabled }),
      { initialProps: { enabled: false } },
    );
    await flush();
    expect(api.getConfig).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(config);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps startup defaults after failure and retries on the next foreground return', async () => {
    const recovered = { shortcuts: { command: [], chat: [] }, asr: true };
    api.getConfig.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(recovered);
    const { result, rerender } = renderHook(
      ({ enabled }) => useServerConfig({ enabled }),
      { initialProps: { enabled: true } },
    );
    await flush();
    rerender({ enabled: false });
    rerender({ enabled: true });
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
    setHidden(true);
    setHidden(false);
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(recovered);
  });

  it('keeps the last good config when a foreground refresh fails', async () => {
    const initial = { shortcuts: { command: [], chat: [] }, asr: true };
    api.getConfig.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useServerConfig());
    await flush();
    setHidden(true);
    setHidden(false);
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(initial);
  });
});
