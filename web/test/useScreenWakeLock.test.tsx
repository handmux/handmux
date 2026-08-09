import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScreenWakeLock } from '../src/hooks/useScreenWakeLock.js';

interface MutableWakeNavigator {
  wakeLock?: {
    request(type: 'screen'): Promise<{ release(): Promise<void> | void }>;
  };
}
const wakeNavigator = navigator as unknown as MutableWakeNavigator;

afterEach(() => { delete wakeNavigator.wakeLock; });

describe('useScreenWakeLock', () => {
  it('requests a screen lock when active, releases it when inactive', async () => {
    const release = vi.fn();
    const request = vi.fn(async () => ({ release }));
    wakeNavigator.wakeLock = { request };

    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: false } });
    expect(request).not.toHaveBeenCalled();          // 不激活:不申请

    rerender({ active: true });
    await Promise.resolve();                          // 等 acquire 的微任务
    expect(request).toHaveBeenCalledWith('screen');   // 激活:申请屏幕常亮

    rerender({ active: false });
    expect(release).toHaveBeenCalledTimes(1);          // 关掉:释放
  });

  it('re-acquires on return to foreground while still active (lock auto-drops when hidden)', async () => {
    const request = vi.fn(async () => ({ release: vi.fn() }));
    wakeNavigator.wakeLock = { request };

    renderHook(() => useScreenWakeLock(true));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);          // 回前台再申请一次
  });

  it('no-op (no throw) where the API is unsupported', () => {
    expect(wakeNavigator.wakeLock).toBeUndefined();
    expect(() => renderHook(() => useScreenWakeLock(true))).not.toThrow();
  });
});
