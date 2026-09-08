import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalStream } from '../src/terminalStream.js';

describe('terminal stream authentication boundary', () => {
  it.each([
    [{ type: 'pause' }, 1003, 'bad subscribe message'],
    [{ type: 'subscribe', token: 'secret', pane: 'invalid' }, 1003, 'bad subscribe message'],
    [{ type: 'subscribe', token: 'wrong', pane: '%7' }, 4001, 'unauthorized'],
    [{ type: 'subscribe', pane: '%7' }, 4001, 'unauthorized'],
  ] as const)('classifies the first message %j correctly', async (message, code, reason) => {
    const paneSession = vi.fn(async () => 'work');
    const terminal = createTerminalStream({ token: 'secret', commands: { paneSession } });
    const server = createServer();
    server.on('upgrade', terminal.onUpgrade);
    let socket: WebSocket | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected server port');
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal-stream`);
      await once(socket, 'open');
      const closed = once(socket, 'close');
      socket.send(JSON.stringify(message));
      const [actualCode, actualReason] = await closed;
      expect(actualCode).toBe(code);
      expect(String(actualReason)).toBe(reason);
      expect(paneSession).not.toHaveBeenCalled();
    } finally {
      socket?.terminate();
      terminal.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Respond to the real stream's tmux control commands while retaining real HTTP/WebSocket I/O.
class ResponsiveControl extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: (command: string): void => {
    queueMicrotask(() => {
      const result = command.startsWith('capture-pane') ? 'terminal seed' : '80\t24\t4\t3\t1\t0\t0\t0';
      this.stdout.emit('data', Buffer.from(`%begin 1 1 1\n${result}\n%end 1 1 1\n`));
    });
  } };
  readonly kill = vi.fn();

  constructor() {
    super();
    queueMicrotask(() => this.stdout.emit('data', Buffer.from('%session-changed $1 work\n')));
  }

  output(pane: string, text: string): void {
    this.stdout.emit('data', Buffer.from(`%output ${pane} ${text}\n`));
  }
}

it('keeps three panes live while a fourth times out and successfully resubscribes', async () => {
  const children: ResponsiveControl[] = [];
  const paneSession = vi.fn(async () => 'work');
  const terminal = createTerminalStream({
    token: 'secret', commands: { paneSession },
    spawnControl: () => {
      const child = new ResponsiveControl();
      children.push(child);
      return child;
    },
  });
  const server = createServer();
  server.on('upgrade', terminal.onUpgrade);
  const sockets: WebSocket[] = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected server port');
    const connect = async (): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal-stream`);
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    };
    const subscribe = async (socket: WebSocket, pane: string): Promise<void> => {
      const frames: string[] = [];
      const ready = new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.on('message', (data, binary) => {
          if (binary) return;
          const message = JSON.parse(data.toString()) as { type: string };
          frames.push(message.type);
          if (message.type === 'ready') resolve();
        });
      });
      socket.send(JSON.stringify({ type: 'subscribe', token: 'secret', pane }));
      await ready;
      expect(frames).toEqual(['seed', 'ready']);
    };
    for (let index = 0; index < 3; index += 1) await subscribe(await connect(), `%${index + 1}`);
    const idle = await connect();
    const [code, reason] = await once(idle, 'close');
    expect(code).toBe(4000);
    expect(String(reason)).toBe('subscribe timeout');
    expect(paneSession).toHaveBeenCalledTimes(3);
    const resumed = await connect();
    await subscribe(resumed, '%4');
    expect(paneSession).toHaveBeenCalledTimes(4);
    for (const [index, socket] of [sockets[0], sockets[1], sockets[2], resumed].entries()) {
      if (!socket) throw new Error('expected live socket');
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const output = once(socket, 'message');
      children[index]?.output(`%${index + 1}`, `pane-${index + 1}`);
      const [data, binary] = await output;
      expect(binary).toBe(true);
      expect(String(data)).toBe(`pane-${index + 1}`);
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    terminal.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
