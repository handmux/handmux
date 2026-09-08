import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentBridge } from '../src/agent-runtime/bridge.js';
import {
  connectBridgeTransport,
  LocalAgentBridgeTransportServer,
} from '../src/agent-runtime/bridgeTransport.js';
import type { BridgeTransportServerOptions } from '../src/agent-runtime/bridgeTransport.js';
import type { BridgeHostEvent } from '../src/agent-runtime/bridgeTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

const directories: string[] = [];
const servers: LocalAgentBridgeTransportServer[] = [];
const bridges: LocalAgentBridge[] = [];
const AUTH_TOKEN = 'test-bridge-auth-token-that-is-at-least-32-bytes';

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function setup({
  handshakeTimeoutMs,
  authorizeDelayMs = 0,
  connected,
}: {
  handshakeTimeoutMs?: number;
  authorizeDelayMs?: number;
  connected?: BridgeTransportServerOptions['connected'];
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-bridge-transport-'));
  directories.push(directory);
  const socketPath = path.join(directory, 'bridge.sock');
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const controller = runtime.controller('pi', async () => true);
  const bridge = new LocalAgentBridge({
    runs: runtime, adapterIds: ['pi'], newConnectionId: () => `connection-${Date.now()}`,
  });
  bridges.push(bridge);
  const authorize = vi.fn(async (
    agentId: string,
    candidate: Parameters<typeof controller.attach>[0],
  ) => {
    if (agentId !== 'pi') throw new Error('wrong adapter');
    if (authorizeDelayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, authorizeDelayMs));
    }
    return controller.attach(candidate);
  });
  let nonce = 0;
  const server = new LocalAgentBridgeTransportServer({
    socketPath, authToken: AUTH_TOKEN, bridge, authorize, newNonce: () => `nonce-${++nonce}`,
    ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
    ...(connected === undefined ? {} : { connected }),
  });
  servers.push(server);
  await server.start();
  const candidate = {
    paneId: '%1', attachmentId: 'pi-extension', sessionId: 'session-1',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
  };
  return { directory, socketPath, runtime, controller, bridge, authorize, server, candidate };
}

describe('LocalAgentBridge Unix transport', () => {
  it('authenticates one run and multiplexes snapshot and event channels over a private socket', async () => {
    const h = await setup();
    expect(fs.statSync(h.socketPath).mode & 0o777).toBe(0o600);
    const client = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
      newRequestId: (() => { let id = 0; return () => `wire-${++id}`; })(),
    });
    expect(client.run).toMatchObject({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    });
    const channel = client.channel('conversation');
    expect(await channel.setSnapshot({ view: 'main' })).toEqual({ accepted: true, sequence: 1 });
    const events: BridgeHostEvent[] = [];
    const lease = h.runtime.resolve(client.run)!;
    const opened = await h.bridge.hostFor('pi').openChannel(lease, 'conversation', (event) => {
      events.push(event);
    });
    expect(opened).toMatchObject({ snapshot: { view: 'main' }, streamSequence: 1 });
    expect(await channel.publish({ payload: { delta: 'hello' } })).toEqual({
      accepted: true, sequence: 2,
    });
    await vi.waitFor(() => expect(events).toEqual([{
      type: 'event', event: { sequence: 2, payload: { delta: 'hello' } },
    }]));
    expect(h.authorize).toHaveBeenCalledOnce();
    client.close();
  });

  it('forwards bounded host requests to client handlers and propagates cancellation', async () => {
    const h = await setup();
    const client = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
    });
    const channel = client.channel('conversation');
    const handler = vi.fn(async (payload: unknown) => ({ status: 'accepted', payload }));
    const unhandle = await channel.handle('send', handler);
    const lease = h.runtime.resolve(client.run)!;
    await expect(h.bridge.hostFor('pi').request(
      lease, 'conversation', 'send', { text: 'hello' }, { timeoutMs: 1_000 },
    )).resolves.toEqual({ status: 'accepted', payload: { text: 'hello' } });
    expect(handler).toHaveBeenCalledOnce();
    await unhandle();
    await expect(h.bridge.hostFor('pi').request(
      lease, 'conversation', 'send', { text: 'again' }, { timeoutMs: 100 },
    )).rejects.toThrow(/unavailable/i);

    let cancelled!: AbortSignal;
    await channel.handle('interrupt', async (_payload, context) => {
      cancelled = context.signal;
      return new Promise(() => {});
    });
    const abort = new AbortController();
    const request = h.bridge.hostFor('pi').request(
      lease, 'conversation', 'interrupt', {}, { signal: abort.signal },
    );
    await vi.waitFor(() => expect(cancelled).toBeInstanceOf(AbortSignal));
    abort.abort();
    await expect(request).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(cancelled.aborted).toBe(true));
    client.close();
  });

  it('keeps concurrent frames ordered and applies negotiated post-handshake size limits', async () => {
    const h = await setup();
    const client = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
      newRequestId: (() => { let id = 0; return () => `ordered-${++id}`; })(),
    });
    const channel = client.channel('conversation');
    const [snapshot, event] = await Promise.all([
      channel.setSnapshot({ text: 'x'.repeat(100 * 1024) }),
      channel.publish({ payload: { delta: 'after' } }),
    ]);
    expect(snapshot).toEqual({ accepted: true, sequence: 1 });
    expect(event).toEqual({ accepted: true, sequence: 2 });
    const lease = h.runtime.resolve(client.run)!;
    await expect(h.bridge.hostFor('pi').openChannel(lease, 'conversation', () => {}))
      .resolves.toMatchObject({ streamSequence: 1 });
    client.close();
  });

  it('rotates the transport connection without replacing the logical run', async () => {
    const h = await setup();
    const first = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
    });
    const second = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
    });
    expect(second.run.runId).toBe(first.run.runId);
    await vi.waitFor(() => expect(first.signal.aborted).toBe(true));
    expect(h.runtime.resolve(second.run)?.signal.aborted).toBe(false);
    second.close();
  });

  it('rejects a stale nonce before authorization', async () => {
    const h = await setup();
    const socket = net.createConnection(h.socketPath);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      socket.write(`${JSON.stringify({
        type: 'hello', protocolVersion: 1, proof: 'stale', adapterId: 'pi', candidate: h.candidate,
      })}\n`);
    });
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('times out an incomplete handshake on both peers', async () => {
    const h = await setup({ handshakeTimeoutMs: 20 });
    const idle = net.createConnection(h.socketPath);
    idle.resume();
    const idleClosed = new Promise<void>((resolve) => idle.once('close', resolve));
    await new Promise<void>((resolve) => idle.once('connect', resolve));
    await within(idleClosed, 'server handshake close');

    let silentSocket: net.Socket | undefined;
    const silentServer = net.createServer((socket) => {
      silentSocket = socket;
      socket.resume();
    });
    const silentPath = path.join(h.directory, 'silent.sock');
    await new Promise<void>((resolve) => silentServer.listen(silentPath, resolve));
    await expect(within(connectBridgeTransport({
      socketPath: silentPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: h.candidate,
      handshakeTimeoutMs: 20,
    }), 'client handshake timeout')).rejects.toThrow(/timed out/i);
    silentSocket?.destroy();
    await within(
      new Promise<void>((resolve) => silentServer.close(() => resolve())),
      'silent server close',
    );
  });

  it('does not create a Bridge connection when authorization outlives the handshake', async () => {
    const h = await setup({ handshakeTimeoutMs: 20, authorizeDelayMs: 60 });
    const connect = vi.spyOn(h.bridge, 'connect');
    await expect(connectBridgeTransport({
      socketPath: h.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: h.candidate,
    })).rejects.toThrow(/closed during handshake/i);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(connect).not.toHaveBeenCalled();
  });

  it('bounds connection activation without revoking the logical run', async () => {
    let connectionSignal: AbortSignal | undefined;
    const h = await setup({
      handshakeTimeoutMs: 20,
      connected: (_lease, connection) => {
        connectionSignal = connection.signal;
        return new Promise(() => {});
      },
    });
    await expect(within(connectBridgeTransport({
      socketPath: h.socketPath,
      authToken: AUTH_TOKEN,
      adapterId: 'pi',
      candidate: h.candidate,
    }), 'connection activation timeout')).rejects.toThrow(/closed during handshake/i);
    expect(connectionSignal?.aborted).toBe(true);
    expect(h.runtime.currentForPane('%1')?.signal.aborted).toBe(false);
  });

  it('refuses a shared parent directory without changing its permissions', async () => {
    const h = await setup();
    const sharedDirectory = path.join(h.directory, 'shared');
    fs.mkdirSync(sharedDirectory, { mode: 0o755 });
    const transport = new LocalAgentBridgeTransportServer({
      socketPath: path.join(sharedDirectory, 'bridge.sock'),
      authToken: AUTH_TOKEN,
      bridge: h.bridge,
      authorize: h.authorize,
    });
    await expect(transport.start()).rejects.toThrow(/private directory/i);
    expect(fs.statSync(sharedDirectory).mode & 0o777).toBe(0o755);
  });

  it('does not unlink a socket owned by another live server', async () => {
    const h = await setup();
    const duplicate = new LocalAgentBridgeTransportServer({
      socketPath: h.socketPath,
      authToken: AUTH_TOKEN,
      bridge: h.bridge,
      authorize: h.authorize,
    });
    await expect(duplicate.start()).rejects.toThrow(/live server/i);
    const client = await connectBridgeTransport({
      socketPath: h.socketPath, adapterId: 'pi', candidate: h.candidate,
      authToken: AUTH_TOKEN,
    });
    expect(client.run.runId).toBe('run-1');
    client.close();
  });
});
