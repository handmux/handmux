import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiBridgeClient } from '../connectors/pi/bridgeClient.js';
import { PrivateStateStore } from '../src/privateStateStore.js';
import type {
  BridgeTransportClientConnection,
  BridgeTransportClientOptions,
} from '../src/agent-runtime/bridgeTransport.js';
import type { BridgeRequestHandler } from '../src/agent-runtime/bridgeTypes.js';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-connector-'));
  directories.push(value);
  fs.writeFileSync(path.join(value, 'credential.json'), JSON.stringify({
    version: 1, authToken: 'pi-connector-auth-token-that-is-at-least-32-bytes',
  }));
  return value;
}

function connection(operations: string[]) {
  const abort = new AbortController();
  const handlers = new Map<string, BridgeRequestHandler>();
  const value: BridgeTransportClientConnection = {
    run: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
    connectionId: crypto.randomUUID(),
    limits: {
      maxFrameBytes: 256 * 1024, maxSnapshotBytes: 1024 * 1024,
      maxQueuedEventsPerChannel: 256, maxQueuedBytesPerChannel: 4 * 1024 * 1024,
      maxDurableSpoolBytesPerAdapter: 16 * 1024 * 1024,
      maxRequestsPerRun: 32, maxRequestsPerAdapter: 128,
      defaultRequestTimeoutMs: 30_000, maxRequestTimeoutMs: 300_000,
      sustainedEventsPerSecond: 200, burstEvents: 500,
    },
    signal: abort.signal,
    channel(name) {
      return {
        async setSnapshot() {
          operations.push(`snapshot:${name}`);
          return { accepted: true, sequence: operations.length };
        },
        async publish(event, options) {
          operations.push(`${options?.delivery ?? 'ephemeral'}:${name}:${event.eventId ?? 'event'}`);
          return { accepted: true, sequence: operations.length };
        },
        async handle(method, handler) {
          operations.push(`handle:${name}.${method}`);
          handlers.set(`${name}.${method}`, handler);
          return async () => { handlers.delete(`${name}.${method}`); };
        },
      };
    },
    close: () => abort.abort('closed'),
  };
  return { value, abort, handlers };
}

describe('PiBridgeClient', () => {
  it('does not send or accept a durable event whose local spool write failed', async () => {
    const root = directory();
    const operations: string[] = [];
    const live = connection(operations);
    const connect = vi.fn(async () => live.value);
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile: path.join(root, 'state.json'),
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
      connect,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    client.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    vi.spyOn(PrivateStateStore.prototype, 'write').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(client.publishDurable('inbox', 'done-write-failed', {
      kind: 'set', state: 'done', eventId: 'done-write-failed',
    })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(operations).not.toContain('durable:inbox:done-write-failed');
    await expect(client.waitForDurableAck('inbox', 'done-write-failed')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(root, 'state.json'))).toBe(false);
    client.close();
  });

  it('keeps an acknowledged durable event queued until local ack deletion is persisted', async () => {
    const root = directory();
    const stateFile = path.join(root, 'state.json');
    const operations: string[] = [];
    const first = connection(operations);
    const second = connection(operations);
    const connect = vi.fn(async () => connect.mock.calls.length === 1 ? first.value : second.value);
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile,
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
      connect,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    const write = vi.spyOn(PrivateStateStore.prototype, 'write');
    client.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(client.publishDurable('inbox', 'done-delete-failed', {
      kind: 'set', state: 'done', eventId: 'done-delete-failed',
    })).toBe(true);
    const acknowledged = client.waitForDurableAck('inbox', 'done-delete-failed');
    let resolved = false;
    void acknowledged.then(() => { resolved = true; });
    write.mockImplementationOnce(() => { throw new Error('disk full during ack'); });

    await vi.waitFor(() => expect(operations.filter(
      (operation) => operation === 'durable:inbox:done-delete-failed',
    )).toHaveLength(2));
    await expect(acknowledged).resolves.toBeUndefined();

    expect(resolved).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).durable).toEqual([]);
    client.close();
  });

  it('does not resend an unchanged snapshot after it has been persisted and accepted', async () => {
    const root = directory();
    const operations: string[] = [];
    const live = connection(operations);
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile: path.join(root, 'state.json'),
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
      connect: vi.fn(async () => live.value),
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    const snapshot = { availability: 'ready', current: { state: 'waiting', eventId: 'permission-1' } };
    expect(client.setSnapshot('inbox', snapshot)).toBe(true);
    client.start();
    await vi.waitFor(() => expect(operations).toContain('snapshot:inbox'));

    expect(client.setSnapshot('inbox', structuredClone(snapshot))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operations.filter((operation) => operation === 'snapshot:inbox')).toHaveLength(1);
    client.close();
  });

  it('flushes a queued snapshot before its ephemeral event', async () => {
    const root = directory();
    const operations: string[] = [];
    const live = connection(operations);
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile: path.join(root, 'state.json'),
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
      connect: vi.fn(async () => live.value),
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    client.setSnapshot('conversation', {
      sessionId: 'session-1', leafId: 'entry001', viewId: 'view-1',
      pendingItems: [{ id: 'pending-user' }],
    });
    client.publishEphemeral('conversation', {
      type: 'item.opened', provisionalId: 'pending-user',
    });
    client.start();

    await vi.waitFor(() => expect(operations).toEqual([
      'snapshot:conversation', 'ephemeral:conversation:event',
    ]));
    client.close();
  });

  it('retries local persistence for an unchanged snapshot after the first write failed', () => {
    const root = directory();
    const stateFile = path.join(root, 'state.json');
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile,
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
    });
    const write = vi.spyOn(PrivateStateStore.prototype, 'write')
      .mockImplementationOnce(() => { throw new Error('disk full'); });
    const snapshot = { availability: 'ready', current: { state: 'working' } };

    expect(client.setSnapshot('inbox', snapshot)).toBe(false);
    expect(client.setSnapshot('inbox', structuredClone(snapshot))).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).snapshots.inbox).toEqual(snapshot);
    client.close();
  });

  it('restores durable writes before snapshots and registers request handlers after reconnect', async () => {
    const root = directory();
    const stateFile = path.join(root, 'state.json');
    const base = {
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile,
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
    };
    const offline = new PiBridgeClient(base);
    offline.publishDurable('inbox', 'done-1', {
      kind: 'set', state: 'done', eventId: 'done-1', reason: 'agent_settled',
    });
    offline.setSnapshot('inbox', { availability: 'ready', current: { state: 'done' } });
    offline.close();

    const operations: string[] = [];
    const live = connection(operations);
    const connect = vi.fn(async (_options: BridgeTransportClientOptions) => live.value);
    const restored = new PiBridgeClient({ ...base, connect, retryDelayMs: 5, maxRetryDelayMs: 10 });
    restored.handle('conversation', 'send', () => ({ status: 'accepted' }));
    restored.start();
    const acknowledged = restored.waitForDurableAck('inbox', 'done-1');

    await vi.waitFor(() => expect(operations).toEqual([
      'handle:conversation.send', 'durable:inbox:done-1', 'snapshot:inbox',
    ]));
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).durable).toEqual([]);
    await expect(acknowledged).resolves.toBeUndefined();
    restored.close();
  });

  it('waits for the current durable boundary before removing a retired generation', async () => {
    const root = directory();
    const stateFile = path.join(root, 'state.json');
    const operations: string[] = [];
    const live = connection(operations);
    let release!: () => void;
    const accepted = new Promise<void>((resolve) => { release = resolve; });
    const publish = live.value.channel('inbox').publish;
    live.value.channel = (name) => ({
      ...connection([]).value.channel(name),
      async publish(event, options) {
        await accepted;
        return publish(event, options);
      },
    });
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile,
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-1', process: { pid: 101 },
      },
      connect: vi.fn(async () => live.value),
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    expect(client.publishDurable('inbox', 'done-before-replacement', {
      kind: 'set', state: 'done', eventId: 'done-before-replacement',
    })).toBe(true);
    client.start();
    const drained = client.waitForDurableDrain();

    expect(client.closeAndRemoveIfDrained()).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(true);
    release();
    await drained;

    expect(client.closeAndRemoveIfDrained()).toBe(true);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('uses a replacement generation only until the first successful authorization', async () => {
    const root = directory();
    const operations: string[] = [];
    const first = connection(operations);
    const second = connection(operations);
    const options: BridgeTransportClientOptions[] = [];
    const connect = vi.fn(async (value: BridgeTransportClientOptions) => {
      options.push(value);
      return options.length === 1 ? first.value : second.value;
    });
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'agent.sock'),
      credentialFile: path.join(root, 'credential.json'),
      stateFile: path.join(root, 'state.json'),
      candidate: {
        paneId: '%1', attachmentId: 'attachment-1', sessionId: 'session-2', process: { pid: 101 },
      },
      generation: { id: 'generation-2', replace: true },
      connect,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    client.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    first.abort.abort('network_lost');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(options[0]?.generation).toEqual({ id: 'generation-2', replace: true });
    expect(options[1]?.generation).toBeUndefined();
    client.close();
  });
});
