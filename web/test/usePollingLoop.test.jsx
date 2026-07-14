import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { usePollingLoop } from '../src/hooks/usePollingLoop.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Harness(props) { usePollingLoop(props); return null; }
const setHidden = (v) => Object.defineProperty(document, 'hidden', { value: v, configurable: true });

describe('usePollingLoop', () => {
  it('polls immediately then every intervalMs, applying each result', async () => {
    vi.useFakeTimers();
    setHidden(false);
    let n = 0;
    const fetch = vi.fn(async () => ++n);
    const apply = vi.fn();
    render(<Harness fetch={fetch} apply={apply} intervalMs={5000} enabled />);
    await act(async () => {}); // flush the immediate tick's microtasks
    expect(apply).toHaveBeenLastCalledWith(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(apply).toHaveBeenLastCalledWith(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(apply).toHaveBeenLastCalledWith(3);
  });

  it('does not fetch while the tab is hidden', async () => {
    vi.useFakeTimers();
    setHidden(true);
    const fetch = vi.fn(async () => 1);
    render(<Harness fetch={fetch} apply={vi.fn()} intervalMs={5000} enabled />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enabled:false never starts the loop', async () => {
    vi.useFakeTimers();
    setHidden(false);
    const fetch = vi.fn(async () => 1);
    render(<Harness fetch={fetch} apply={vi.fn()} intervalMs={5000} enabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancelled guard: a fetch in flight at unmount does not apply its stale result', async () => {
    vi.useFakeTimers();
    setHidden(false);
    let resolve;
    const fetch = vi.fn(() => new Promise((r) => { resolve = r; }));
    const apply = vi.fn();
    const { unmount } = render(<Harness fetch={fetch} apply={apply} intervalMs={5000} enabled />);
    expect(fetch).toHaveBeenCalledTimes(1); // immediate tick started, awaiting
    unmount();                              // cleanup sets cancelled = true
    await act(async () => { resolve(42); }); // the in-flight fetch resolves AFTER cleanup
    expect(apply).not.toHaveBeenCalled();   // stale result dropped
  });
});
