import { describe, expect, it, vi } from 'vitest';
import { createTerminalInputQueue } from '../src/terminalInputQueue.js';

interface SendResult { ok: boolean }
type Send = (pane: string, hex: string) => Promise<SendResult>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('terminal input queue', () => {
  it('keeps one request in flight and preserves pane/data order', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true });
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', 'a');
    queue.enqueue('%1', 'b');
    queue.enqueue('%2', '你');

    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls).toEqual([
      ['%1', '6162'],
      ['%2', 'e4bda0'],
    ]);
  });

  it('preserves raw binary input without UTF-8 re-encoding', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ ok: true });
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', Uint8Array.from([0x1b, 0x5b, 0xff, 0x00]));

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith('%1', '1b5bff00');
  });

  it('preserves ASCII, named-key, and committed UTF-8 input order', async () => {
    const events: string[] = [];
    const send = vi.fn<Send>(async (_pane, hex) => {
      events.push(`input:${hex}`);
      return { ok: true };
    });
    const sendKeys = vi.fn(async (_pane: string, keys: readonly string[]) => {
      events.push(`keys:${keys.join(',')}`);
      return { ok: true };
    });
    const queue = createTerminalInputQueue({ send, sendKeys });

    queue.enqueue('%1', 'a');
    queue.enqueueKeys('%1', ['Left']);
    queue.enqueue('%1', '你');

    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      'input:61',
      'keys:Left',
      'input:e4bda0',
    ]);
  });

  it('does not retry an ambiguous failed batch', async () => {
    const onError = vi.fn<(error: unknown, pane: string) => void>();
    const send = vi.fn<Send>().mockRejectedValue(new Error('network'));
    const queue = createTerminalInputQueue({ send, onError });

    queue.enqueue('%1', 'x');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), '%1');
  });

  it('drains data appended while the first request is in flight', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true });
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', 'a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue('%1', 'b');

    first.resolve({ ok: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(['%1', '62']);
  });

  it('splits a same-pane batch at the server byte limit without reordering', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true });
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', `${'a'.repeat(16384)}你`);

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0]).toEqual(['%1', '61'.repeat(16384)]);
    first.resolve({ ok: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(['%1', 'e4bda0']);
  });

  it('drops only queued data for the requested pane', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true });
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', 'a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue('%1', 'b');
    queue.enqueue('%2', 'c');
    await Promise.resolve();
    queue.drop('%1');

    first.resolve({ ok: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(['%2', '63']);
  });

  it('reports delivery for the pane bound to each batch', async () => {
    const onDelivered = vi.fn<(pane: string) => void>();
    const send = vi.fn<Send>().mockResolvedValue({ ok: true });
    const queue = createTerminalInputQueue({ send, onDelivered });

    queue.enqueue('%1', 'a');
    queue.enqueue('%2', 'b');

    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(2));
    expect(onDelivered.mock.calls).toEqual([['%1'], ['%2']]);
  });

  it('keeps draining confirmed sends when onDelivered throws', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true });
    const onDelivered = vi.fn<(pane: string) => void>(() => { throw new Error('observer failed'); });
    const onError = vi.fn<(error: unknown, pane: string) => void>();
    const queue = createTerminalInputQueue({ send, onDelivered, onError });

    queue.enqueue('%1', 'a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue('%1', 'b');
    first.resolve({ ok: true });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls).toEqual([
      ['%1', '61'],
      ['%1', '62'],
    ]);
    expect(onDelivered).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps draining other panes when onError throws', async () => {
    const send = vi.fn<Send>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true });
    const onError = vi.fn<(error: unknown, pane: string) => void>(() => { throw new Error('observer failed'); });
    const queue = createTerminalInputQueue({ send, onError });

    queue.enqueue('%1', 'a');
    queue.enqueue('%2', 'b');

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls).toEqual([
      ['%1', '61'],
      ['%2', '62'],
    ]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('stops accepting and draining queued data after disposal', async () => {
    const first = deferred<SendResult>();
    const send = vi.fn<Send>().mockReturnValueOnce(first.promise);
    const queue = createTerminalInputQueue({ send });

    queue.enqueue('%1', 'a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue('%2', 'b');
    await Promise.resolve();
    queue.dispose();
    queue.enqueue('%3', 'c');
    first.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
  });
});
