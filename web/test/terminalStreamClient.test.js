import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTerminalStream } from '../src/terminalStreamClient.js';
import { terminalStreamEnabled } from '../src/terminalTransport.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data) {
    this.onmessage?.({ data });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closeReason = reason;
    this.onclose?.({ code });
  }
}

const seedFrame = (overrides = {}) => JSON.stringify({
  type: 'seed',
  ansi: '',
  width: 80,
  height: 24,
  historyLines: 0,
  alt: false,
  mouseAware: false,
  mouseSgr: false,
  ...overrides,
});
const readyFrame = (overrides = {}) => JSON.stringify({
  type: 'ready',
  cur: { row: 0, col: 0, vis: true },
  ...overrides,
});

describe('terminalStreamEnabled', () => {
  it('is enabled by default and supports an emergency query override', () => {
    expect(terminalStreamEnabled({ search: '?terminalStream=1' })).toBe(true);
    expect(terminalStreamEnabled({ search: '' })).toBe(true);
    expect(terminalStreamEnabled({ search: '?terminalStream=0' })).toBe(false);
    expect(terminalStreamEnabled({ search: '' }, 'snapshot')).toBe(false);
    expect(terminalStreamEnabled({ search: '?terminalStream=1' }, 'snapshot')).toBe(false);
  });
});

describe('openTerminalStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    window.history.replaceState({}, '', '/');
  });

  it('subscribes, serializes seed/output/ready, and resyncs on the same socket', async () => {
    const events = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onSeed: async () => events.push('seed'),
      onData: async () => events.push('data'),
      onReady: async () => events.push('ready'),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(ws.sent).toEqual([{ type: 'subscribe', token: 'secret', pane: '%7' }]);
    ws.message(seedFrame());
    ws.message(new Uint8Array([1, 2]).buffer);
    ws.message(readyFrame());
    await vi.waitFor(() => expect(events).toEqual(['seed', 'data', 'ready']));

    stream.resync();
    expect(ws.sent.at(-1)).toEqual({ type: 'resync' });
    stream.close();
  });

  it('closes the socket when a protocol frame is structurally incomplete', async () => {
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(JSON.stringify({ type: 'seed' }));

    expect(ws.readyState).toBe(3);
    expect(ws.closeReason).toBe('bad stream frame');
    await stream.close();
  });

  it('measures application RTT on the live socket', async () => {
    vi.useFakeTimers();
    let now = 1000;
    const onProbe = vi.fn();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      now: () => now,
      onProbe,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    const ready = readyFrame();
    ws.message(ready);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(ws.sent.at(-1)).toEqual({ type: 'probe', id: 1 });

    now = 1086;
    ws.message(JSON.stringify({ type: 'probe', id: 1 }));
    expect(onProbe).toHaveBeenCalledWith({ ok: true, rttMs: 86 });

    stream.close();
    vi.useRealTimers();
  });

  it('reports a timed-out application probe without closing a healthy stream', async () => {
    vi.useFakeTimers();
    const onProbe = vi.fn();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      probeTimeoutMs: 20,
      onProbe,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(readyFrame());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    vi.advanceTimersByTime(20);
    expect(onProbe).toHaveBeenCalledWith({ ok: false });
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    stream.close();
    vi.useRealTimers();
  });

  it('pauses without reconnecting and reconnects only when resuming', () => {
    vi.useFakeTimers();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      reconnectMs: 10,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    stream.pause();
    expect(ws.sent.at(-1)).toEqual({ type: 'pause' });
    ws.close(1006);
    vi.advanceTimersByTime(20);
    expect(FakeWebSocket.instances).toHaveLength(1);

    stream.resync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    stream.close();
    vi.useRealTimers();
  });

  it('suspends the socket and starts from a fresh connection when resumed', () => {
    const statuses = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onStatus: (status) => statuses.push(status),
    });
    const first = FakeWebSocket.instances[0];
    first.open();

    stream.pause();
    stream.suspend();
    expect(first.readyState).toBe(3);
    expect(statuses.at(-1)).toBe('paused');

    stream.resync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.open();
    expect(second.sent).toEqual([{ type: 'subscribe', token: 'secret', pane: '%7' }]);
    stream.close();
  });

  it('survives repeated background pause/resync cycles on one socket without mixing generations', async () => {
    vi.useFakeTimers();
    const delivered = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onData: (data) => delivered.push(data[0]),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();

    for (let cycle = 0; cycle < 100; cycle += 1) {
      stream.pause();
      stream.resync();
      ws.message(seedFrame());
      ws.message(new Uint8Array([cycle]).buffer);
      ws.message(readyFrame());
      // Drain the serialized parser callbacks before the next lifecycle boundary.
      // eslint-disable-next-line no-await-in-loop
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    }

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(delivered).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(ws.sent.filter(({ type }) => type === 'resync')).toHaveLength(100);
    await stream.close();
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  it('keeps one reconnect chain through a prolonged weak-network failure storm', () => {
    vi.useFakeTimers();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      reconnectMs: 10,
    });

    for (let failure = 0; failure < 100; failure += 1) {
      const ws = FakeWebSocket.instances.at(-1);
      ws.open();
      ws.close(1006);
      // A stale duplicate close must not create a parallel reconnect timer.
      ws.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(10);
      expect(FakeWebSocket.instances).toHaveLength(failure + 2);
    }

    const current = FakeWebSocket.instances.at(-1);
    current.open();
    stream.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(101);
    vi.useRealTimers();
  });

  it('does not subscribe in the background when the socket opens after pausing', () => {
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];

    stream.pause();
    ws.open();
    expect(ws.sent).toEqual([]);

    stream.resync();
    expect(ws.sent).toEqual([{ type: 'subscribe', token: 'secret', pane: '%7' }]);
    stream.close();
  });

  it('drops queued frames across a pause and resync boundary', async () => {
    const seed = {};
    seed.promise = new Promise((resolve) => { seed.resolve = resolve; });
    const events = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onSeed: async () => {
        events.push('seed');
        await seed.promise;
      },
      onData: async () => events.push('stale-data'),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(new Uint8Array([1]).buffer);
    await vi.waitFor(() => expect(events).toEqual(['seed']));

    stream.pause();
    stream.resync();
    seed.resolve();
    await stream.close();
    expect(events).toEqual(['seed']);
  });

  it('resyncs on the same socket instead of painting frames queued for over 300ms', async () => {
    vi.useFakeTimers();
    const blockedData = {};
    blockedData.promise = new Promise((resolve) => { blockedData.resolve = resolve; });
    let dataCount = 0;
    const onData = vi.fn(() => {
      dataCount += 1;
      return dataCount === 1 ? blockedData.promise : undefined;
    });
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      connectTimeoutMs: 30000,
      maxFrameLagMs: 300,
      onData,
    });
    const first = FakeWebSocket.instances[0];
    first.open();
    first.message(seedFrame());
    first.message(readyFrame());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    first.message(new Uint8Array([1]).buffer);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(onData).toHaveBeenCalledTimes(1);
    first.message(new Uint8Array([2]).buffer);

    vi.advanceTimersByTime(301);
    blockedData.resolve();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(onData).toHaveBeenCalledTimes(1);
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first.sent.at(-1)).toEqual({ type: 'resync' });

    first.message(new Uint8Array([9]).buffer);
    first.message(readyFrame());
    await Promise.resolve();
    expect(onData).toHaveBeenCalledTimes(1);

    first.message(seedFrame());
    first.message(new Uint8Array([3]).buffer);
    first.message(readyFrame());
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(onData).toHaveBeenCalledTimes(2);
    expect([...onData.mock.calls[1][0]]).toEqual([3]);
    stream.close();
    vi.useRealTimers();
  });

  it('coalesces adjacent output queued behind an in-flight parser write', async () => {
    const blocked = {};
    blocked.promise = new Promise((resolve) => { blocked.resolve = resolve; });
    let dataCount = 0;
    const onData = vi.fn(() => {
      dataCount += 1;
      return dataCount === 1 ? blocked.promise : undefined;
    });
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onData,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(readyFrame());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    ws.message(new Uint8Array([1]).buffer);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(onData).toHaveBeenCalledTimes(1);
    ws.message(new Uint8Array([2]).buffer);
    ws.message(new Uint8Array([3, 4]).buffer);
    ws.message(new Uint8Array([5]).buffer);

    blocked.resolve();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledTimes(2));
    expect([...onData.mock.calls[0][0]]).toEqual([1]);
    expect([...onData.mock.calls[1][0]]).toEqual([2, 3, 4, 5]);
    stream.close();
  });

  it('never coalesces output across a ready protocol boundary', async () => {
    const seed = {};
    seed.promise = new Promise((resolve) => { seed.resolve = resolve; });
    const events = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onSeed: () => seed.promise,
      onData: (data) => events.push([...data]),
      onReady: () => events.push('ready'),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    await Promise.resolve();
    ws.message(new Uint8Array([1]).buffer);
    ws.message(new Uint8Array([2]).buffer);
    ws.message(readyFrame());
    ws.message(new Uint8Array([3]).buffer);

    seed.resolve();
    await vi.waitFor(() => expect(events).toEqual([[1, 2], 'ready', [3]]));
    stream.close();
  });

  it('resyncs on the same socket when queued output exceeds the byte limit', async () => {
    const seed = {};
    seed.promise = new Promise((resolve) => { seed.resolve = resolve; });
    const onData = vi.fn();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      maxPendingDataBytes: 3,
      onSeed: () => seed.promise,
      onData,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(new Uint8Array([1, 2]).buffer);
    ws.message(new Uint8Array([3, 4]).buffer);

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent.at(-1)).toEqual({ type: 'resync' });

    seed.resolve();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();
    stream.close();
  });

  it('does not let stale queued frames reduce the next resync generation byte count', async () => {
    const firstSeed = {};
    firstSeed.promise = new Promise((resolve) => { firstSeed.resolve = resolve; });
    const freshSeed = {};
    freshSeed.promise = new Promise((resolve) => { freshSeed.resolve = resolve; });
    let seedCount = 0;
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      maxPendingDataBytes: 3,
      onSeed: () => {
        seedCount += 1;
        return seedCount === 1 ? firstSeed.promise : freshSeed.promise;
      },
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    await vi.waitFor(() => expect(seedCount).toBe(1));
    ws.message(new Uint8Array([1, 2]).buffer);
    ws.message(new Uint8Array([3, 4]).buffer);
    expect(ws.sent.filter(({ type }) => type === 'resync')).toHaveLength(1);

    ws.message(seedFrame());
    ws.message(new Uint8Array([5, 6]).buffer);
    firstSeed.resolve();
    await vi.waitFor(() => expect(seedCount).toBe(2));

    ws.message(new Uint8Array([7, 8]).buffer);
    expect(ws.sent.filter(({ type }) => type === 'resync')).toHaveLength(2);

    freshSeed.resolve();
    await stream.close();
  });

  it('does not treat a slow initial seed as an overloaded output queue', async () => {
    vi.useFakeTimers();
    const seed = {};
    seed.promise = new Promise((resolve) => { seed.resolve = resolve; });
    const onReady = vi.fn();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      maxFrameLagMs: 300,
      onSeed: () => seed.promise,
      onReady,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(readyFrame());

    vi.advanceTimersByTime(301);
    seed.resolve();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(onReady).toHaveBeenCalledOnce();
    expect(ws.sent).not.toContainEqual({ type: 'resync' });
    stream.close();
    vi.useRealTimers();
  });

  it('keeps resync catch-up output queued behind a slow seed', async () => {
    vi.useFakeTimers();
    const seed = {};
    seed.promise = new Promise((resolve) => { seed.resolve = resolve; });
    const onSeed = vi.fn(() => seed.promise);
    const onData = vi.fn();
    const onReady = vi.fn();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      maxFrameLagMs: 300,
      onSeed,
      onData,
      onReady,
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    await Promise.resolve();
    expect(onSeed).toHaveBeenCalledOnce();

    ws.message(new Uint8Array([1, 2, 3]).buffer);
    ws.message(readyFrame());
    vi.advanceTimersByTime(301);
    seed.resolve();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    expect(onData).toHaveBeenCalledOnce();
    expect([...onData.mock.calls[0][0]]).toEqual([1, 2, 3]);
    expect(onReady).toHaveBeenCalledOnce();
    expect(ws.sent).not.toContainEqual({ type: 'resync' });
    stream.close();
    vi.useRealTimers();
  });

  it('does not open a second socket when resync is requested while connecting', () => {
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
    });
    stream.resync();
    stream.resync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    stream.close();
  });

  it('ignores a stale socket close after a newer connection exists', () => {
    vi.useFakeTimers();
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      reconnectMs: 10,
    });
    const first = FakeWebSocket.instances[0];
    first.open();
    first.close(1006);
    vi.advanceTimersByTime(10);
    const second = FakeWebSocket.instances[1];
    second.open();
    first.onclose?.({ code: 1006 });
    stream.resync();
    expect(second.sent.at(-1)).toEqual({ type: 'resync' });
    expect(FakeWebSocket.instances).toHaveLength(2);
    stream.close();
    vi.useRealTimers();
  });

  it('uses a separate longer deadline after the WebSocket handshake opens', async () => {
    vi.useFakeTimers();
    const statuses = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      reconnectMs: 10,
      connectTimeoutMs: 20,
      readyTimeoutMs: 50,
      onStatus: (status) => statuses.push(status),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    vi.advanceTimersByTime(20);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    vi.advanceTimersByTime(30);
    expect(ws.readyState).toBe(3);
    expect(statuses).not.toContain('reconnecting');

    vi.advanceTimersByTime(10);
    const retry = FakeWebSocket.instances[1];
    retry.open();
    retry.message(seedFrame());
    retry.message(readyFrame());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(statuses).toContain('live');
    expect(statuses).not.toContain('reconnecting');
    stream.close();
    vi.useRealTimers();
  });

  it('reports reconnecting only after two complete cold-start attempts fail', () => {
    vi.useFakeTimers();
    const statuses = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      reconnectMs: 10,
      connectTimeoutMs: 20,
      readyTimeoutMs: 50,
      onStatus: (status) => statuses.push(status),
    });

    vi.advanceTimersByTime(20); // first handshake never opens
    expect(statuses).not.toContain('reconnecting');
    vi.advanceTimersByTime(10); // start the complete retry
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(20); // retry handshake also fails
    expect(statuses).toContain('reconnecting');

    stream.close();
    vi.useRealTimers();
  });

  it('reports a drop immediately after the stream has already been live', async () => {
    const statuses = [];
    const stream = openTerminalStream({
      pane: '%7',
      token: 'secret',
      WebSocketCtor: FakeWebSocket,
      onStatus: (status) => statuses.push(status),
    });
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(seedFrame());
    ws.message(readyFrame());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    ws.close(1006);
    expect(statuses.at(-1)).toBe('reconnecting');
    stream.close();
  });
});
