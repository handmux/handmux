import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeControlData,
  echoTerminalProbe,
  PaneControlStream,
  startSubscribeDeadline,
} from '../src/terminalStream.js';

class FakeChild extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly writes: string[];
  readonly stdin: { write: (value: string) => void };
  readonly kill: ReturnType<typeof vi.fn>;

  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.stdin = { write: (value) => { this.writes.push(value); } };
    this.kill = vi.fn();
  }

  lines(...lines: string[]): void {
    this.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`));
  }
}

type FakeMessage = Buffer | Record<string, unknown>;
interface FakeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly messages: FakeMessage[];
  send(value: string | Buffer, options?: { binary?: boolean }): void;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(): FakeSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    messages: [] as FakeMessage[],
    send(value: string | Buffer, options?: { binary?: boolean }): void {
      if (options?.binary) {
        this.messages.push(Buffer.from(value));
        return;
      }
      const parsed: unknown = JSON.parse(value.toString());
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected JSON object');
      }
      this.messages.push(parsed as Record<string, unknown>);
    },
    close: vi.fn(),
  };
}

interface FinishResyncOptions {
  capture?: string[];
  info?: string;
  between?: () => void;
}

async function finishResync(child: FakeChild, {
  capture = ['one'],
  info = '80\t24\t4\t3\t1\t0\t0\t0',
  between,
}: FinishResyncOptions = {}): Promise<void> {
  const waitFor = (assertion: () => void | Promise<void>): Promise<void> =>
    vi.waitFor(assertion, { interval: 1 });
  await waitFor(() => expect(child.writes.at(-1)).toContain('capture-pane'));
  child.lines('%begin 1 1 1', ...capture, '%end 1 1 1');
  between?.();
  await waitFor(() => expect(child.writes.at(-1)).toContain('display-message'));
  const firstInfoWriteCount = child.writes.length;
  child.lines('%begin 2 2 1', info, '%end 2 2 1');
  if (info === 'not-pane-info') return;
  await waitFor(() => expect(child.writes.length).toBeGreaterThan(firstInfoWriteCount));
  child.lines('%begin 3 3 1', info, '%end 3 3 1');
}

describe('terminal control data decoder', () => {
  it('decodes octal escapes without corrupting raw UTF-8 bytes', () => {
    const input = Buffer.concat([
      Buffer.from('中文', 'utf8'),
      Buffer.from('\\033[2K'),
    ]);
    expect(decodeControlData(input)).toEqual(Buffer.concat([
      Buffer.from('中文', 'utf8'),
      Buffer.from([0x1b]),
      Buffer.from('[2K'),
    ]));
  });

  it('preserves a literal backslash that is not an octal escape', () => {
    expect(decodeControlData(Buffer.from('a\\\\b'))).toEqual(Buffer.from('a\\b'));
  });
});

describe('terminal stream probe', () => {
  it('echoes only bounded numeric probe identifiers', () => {
    const ws = fakeSocket();
    expect(echoTerminalProbe(ws, { type: 'probe', id: 7 })).toBe(true);
    expect(ws.messages).toEqual([{ type: 'probe', id: 7 }]);
    expect(echoTerminalProbe(ws, { type: 'probe', id: '7' })).toBe(false);
    expect(echoTerminalProbe(ws, { type: 'pause' })).toBe(false);
  });

  it('closes connections that never subscribe', () => {
    vi.useFakeTimers();
    const ws = fakeSocket();
    const cancel = startSubscribeDeadline(ws, 50);
    vi.advanceTimersByTime(49);
    expect(ws.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.close).toHaveBeenCalledWith(4001, 'authentication timeout');
    cancel();
    vi.useRealTimers();
  });
});

describe('PaneControlStream', () => {
  it('buffers output across a seed and then streams on the same tmux connection', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const spawnControl = vi.fn(() => child);
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl,
    });
    const started = stream.start();
    child.lines('%session-changed $1 work');
    await finishResync(child, {
      between: () => child.lines('%output %7 +live\\033[2K'),
    });
    await started;

    expect(spawnControl).toHaveBeenCalledTimes(1);
    expect(child.writes[0]).toContain('capture-pane -p -e -N -S -100 -t %7');
    expect(ws.messages).toEqual([
      expect.objectContaining({ type: 'seed', ansi: 'one\n', width: 80, height: 24 }),
      Buffer.from('+live\x1b[2K'),
      { type: 'ready', cur: { row: 20, col: 4, vis: true } },
    ]);

    child.lines('%output %7 next');
    expect(ws.messages.at(-1)).toEqual(Buffer.from('next'));
    stream.close();
  });

  it('publishes ready before output reported after the pane-info boundary', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl: () => child,
    });
    const started = stream.start();
    child.lines('%session-changed $1 work');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('capture-pane'));
    child.lines('%begin 1 1 1', 'screen', '%end 1 1 1', '%output %7 before');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('display-message'));
    const firstInfoWriteCount = child.writes.length;
    child.lines(
      '%begin 2 2 1',
      '80\t24\t4\t3\t1\t0\t0\t0',
      '%end 2 2 1',
    );
    await vi.waitFor(() => expect(child.writes.length).toBeGreaterThan(firstInfoWriteCount));
    child.lines(
      '%begin 3 3 1',
      '80\t24\t4\t3\t1\t0\t0\t0',
      '%end 3 3 1',
      '%output %7 after',
    );
    await started;

    expect(ws.messages).toEqual([
      expect.objectContaining({ type: 'seed', ansi: 'screen\n' }),
      Buffer.from('before'),
      { type: 'ready', cur: { row: 20, col: 4, vis: true } },
      Buffer.from('after'),
    ]);
    stream.close();
  });

  it('includes normal-screen history but strips main-screen history from alternate screens', async () => {
    const normalChild = new FakeChild();
    const normalSocket = fakeSocket();
    const normal = new PaneControlStream({
      ws: normalSocket,
      pane: '%7',
      session: 'work',
      spawnControl: () => normalChild,
    });
    const normalStarted = normal.start();
    normalChild.lines('%session-changed $1 work');
    await finishResync(normalChild, {
      capture: ['history', 'screen-1', 'screen-2'],
      info: '80\t2\t0\t1\t1\t0\t0\t0',
    });
    await normalStarted;
    expect(normalSocket.messages[0]).toEqual(expect.objectContaining({
      type: 'seed',
      ansi: 'history\nscreen-1\nscreen-2\n',
      historyLines: 1,
    }));
    normal.close();

    const alternateChild = new FakeChild();
    const alternateSocket = fakeSocket();
    const alternate = new PaneControlStream({
      ws: alternateSocket,
      pane: '%8',
      session: 'work',
      spawnControl: () => alternateChild,
    });
    const alternateStarted = alternate.start();
    alternateChild.lines('%session-changed $1 work');
    await finishResync(alternateChild, {
      capture: ['main-history', 'alt-1', 'alt-2'],
      info: '80\t2\t0\t1\t1\t1\t0\t0',
    });
    await alternateStarted;
    expect(alternateSocket.messages[0]).toEqual(expect.objectContaining({
      type: 'seed',
      ansi: 'alt-1\nalt-2\n',
      historyLines: 0,
    }));
    alternate.close();
  });

  it('restores an ambiguous blank row before publishing the live seed', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl: () => child,
    });
    const started = stream.start();
    child.lines('%session-changed $1 work');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('capture-pane'));
    child.lines(
      '%begin 1 1 1',
      '\x1b[48;5;237m❯ hi   ',
      '        ',
      '\x1b[49mreply',
      '%end 1 1 1',
    );
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('display-message'));
    child.lines('%begin 2 2 1', '8\t3\t0\t2\t0\t0\t0\t0', '%end 2 2 1');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('-S 1 -E 1'));
    child.lines('%begin 3 3 1', '        ', '%end 3 3 1');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('display-message'));
    child.lines('%begin 4 4 1', '8\t3\t0\t2\t0\t0\t0\t0', '%end 4 4 1');
    await started;

    const seed = ws.messages[0];
    expect(seed).not.toBeInstanceOf(Buffer);
    const ansi = (seed as Record<string, unknown>).ansi;
    expect(typeof ansi).toBe('string');
    expect((ansi as string).split('\n')[1]).toBe('\x1b[49m        ');
    stream.close();
  });

  it('keeps a pause that arrives during resync and reuses the control connection later', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const spawnControl = vi.fn(() => child);
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl,
    });
    const started = stream.start();
    child.lines('%session-changed $1 work');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('capture-pane'));
    child.lines('%begin 1 1 1', 'old', '%end 1 1 1');
    await vi.waitFor(() => expect(child.writes.at(-1)).toContain('display-message'));
    stream.pause();
    child.lines('%begin 2 2 1', '80\t24\t0\t0\t1\t0\t0\t0', '%end 2 2 1');
    await started;
    expect(ws.messages).toEqual([]);
    expect(stream.phase).toBe('paused');

    const resumed = stream.resync();
    await finishResync(child, { capture: ['new'] });
    await resumed;
    expect(spawnControl).toHaveBeenCalledTimes(1);
    expect(ws.messages[0]).toEqual(expect.objectContaining({ type: 'seed', ansi: 'new\n' }));
    expect(stream.phase).toBe('live');
    stream.close();
  });

  it('reuses one tmux control process across repeated background lifecycle cycles', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const spawnControl = vi.fn(() => child);
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl,
    });
    const started = stream.start();
    child.lines('%session-changed $1 work');
    await finishResync(child, { capture: ['initial'] });
    await started;

    for (let cycle = 0; cycle < 30; cycle += 1) {
      stream.pause();
      child.lines(`%output %7 ignored-${cycle}`);
      const resumed = stream.resync();
      // eslint-disable-next-line no-await-in-loop
      await finishResync(child, { capture: [`cycle-${cycle}`] });
      // eslint-disable-next-line no-await-in-loop
      await resumed;
      expect(stream.phase).toBe('live');
      expect(stream.pendingOutputBytes).toBe(0);
    }

    expect(spawnControl).toHaveBeenCalledTimes(1);
    expect(ws.messages.at(-2)).toEqual(expect.objectContaining({
      type: 'seed',
      ansi: 'cycle-29\n',
    }));
    expect(ws.messages.some((message) => Buffer.isBuffer(message)
      && message.toString().startsWith('ignored-'))).toBe(false);
    stream.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects pending control requests when closed', async () => {
    const child = new FakeChild();
    const stream = new PaneControlStream({
      ws: fakeSocket(),
      pane: '%7',
      session: 'work',
      spawnControl: () => child,
    });
    child.lines('%session-changed $1 work');
    const pending = stream.request('capture-pane -p -t %7');
    stream.close();
    await expect(pending).rejects.toThrow('closed');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid pane-info frame instead of sending unusable dimensions', async () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl: () => child,
    });
    const started = stream.start();
    const rejected = expect(started).rejects.toThrow('invalid tmux pane info');
    child.lines('%session-changed $1 work');
    await finishResync(child, { info: 'not-pane-info' });
    await rejected;
    expect(ws.messages).toEqual([]);
    stream.close();
  });

  it('stops an unbounded output backlog while a resync is running', () => {
    const child = new FakeChild();
    const ws = fakeSocket();
    const stream = new PaneControlStream({
      ws,
      pane: '%7',
      session: 'work',
      spawnControl: () => child,
    });
    stream.phase = 'buffer';
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 5; i += 1) child.lines(`%output %7 ${chunk}`);

    expect(ws.close).toHaveBeenCalledWith(1013, 'stream fell behind');
    expect(stream.phase).toBe('paused');
    expect(stream.pendingOutput).toEqual([]);
    stream.close();
  });
});
