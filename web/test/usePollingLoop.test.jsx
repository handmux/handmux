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

  it('runs once without a timer when repeat is false and refreshes on an explicit key change', async () => {
    vi.useFakeTimers();
    setHidden(false);
    const fetch = vi.fn(async () => fetch.mock.calls.length);
    const apply = vi.fn();
    const { rerender } = render(
      <Harness fetch={fetch} apply={apply} intervalMs={1500} repeat={false} burstKey={0} enabled />,
    );
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(1);

    rerender(<Harness fetch={fetch} apply={apply} intervalMs={1500} repeat={false} burstKey={1} enabled />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('restarts immediately and briefly uses the burst cadence when burstKey changes', async () => {
    vi.useFakeTimers();
    setHidden(false);
    const fetch = vi.fn(async () => fetch.mock.calls.length);
    const apply = vi.fn();
    const { rerender } = render(
      <Harness fetch={fetch} apply={apply} intervalMs={1500} burstKey={null} burstIntervalMs={500} burstCount={2} enabled />,
    );
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);

    rerender(<Harness fetch={fetch} apply={apply} intervalMs={1500} burstKey={1} burstIntervalMs={500} burstCount={2} enabled />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2); // wake -> immediate
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetch).toHaveBeenCalledTimes(4); // two 500ms follow-ups
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(5); // normal cadence restored
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

  it('never overlaps polls when a request is slower than the cadence or visibility wakes it', async () => {
    vi.useFakeTimers();
    setHidden(false);
    let resolveFirst;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(2);
    const apply = vi.fn();
    render(<Harness fetch={fetch} apply={apply} intervalMs={100} enabled />);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(1);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apply).toHaveBeenCalledWith(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('abandons a request frozen by backgrounding and refreshes immediately on return', async () => {
    vi.useFakeTimers();
    setHidden(false);
    let resolveFrozen;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFrozen = resolve; }))
      .mockResolvedValue(2);
    const apply = vi.fn();
    render(<Harness fetch={fetch} apply={apply} intervalMs={1500} enabled />);
    expect(fetch).toHaveBeenCalledTimes(1);

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(2);

    await act(async () => { resolveFrozen(1); });
    expect(apply).not.toHaveBeenCalledWith(1);
  });

  it.each(['pageshow', 'focus'])(
    'abandons a frozen request when a mobile app returns through %s without visibilitychange',
    async (eventName) => {
      vi.useFakeTimers();
      setHidden(false);
      let resolveFrozen;
      const fetch = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFrozen = resolve; }))
        .mockResolvedValue(2);
      const apply = vi.fn();
      render(<Harness fetch={fetch} apply={apply} intervalMs={1500} enabled />);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Some installed mobile WebViews suspend the page without delivering a complete hidden -> visible
      // visibilitychange pair. The old request then remains logically in flight forever.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      const event = new Event(eventName);
      if (eventName === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);

      await act(async () => {});
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenCalledWith(2);

      await act(async () => { resolveFrozen(1); });
      expect(apply).not.toHaveBeenCalledWith(1);
    },
  );
});
