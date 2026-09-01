import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {
  BridgeLimits,
  BridgePublishRequest,
  BridgeRequestContext,
  BridgeRequestHandler,
  BridgeWriteReceipt,
  LocalAgentBridgeConnection,
} from './bridgeTypes.js';
import { DEFAULT_BRIDGE_LIMITS } from './bridgeTypes.js';
import type { LocalAgentBridge } from './bridge.js';
import type { AgentAttachmentCandidate, AgentRunLease, AgentRunRef } from './run.js';

const PROTOCOL_VERSION = 1;
const NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const WIRE_OVERHEAD_BYTES = 16 * 1024;

type JsonRecord = Record<string, unknown>;

interface WirePeer {
  socket: net.Socket;
  maxBytes: number;
  buffer: Buffer;
  closed: boolean;
  send(value: unknown): void;
  close(): void;
}

interface ServerSession {
  peer: WirePeer;
  lease?: AgentRunLease;
  connection?: LocalAgentBridgeConnection;
  unregister: Map<string, () => void>;
  pending: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    detachAbort: () => void;
  }>;
  handshakeTimer: NodeJS.Timeout | undefined;
  tail: Promise<void>;
}

interface ClientPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validChannelName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value) && !value.startsWith('handmux.');
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

function nonceProof(authToken: string, nonce: string): string {
  return crypto.createHmac('sha256', authToken).update(nonce).digest('base64url');
}

function equalProof(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const first = Buffer.from(actual);
  const second = Buffer.from(expected);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function wirePeer(socket: net.Socket, maxBytes: number, onMessage: (value: unknown) => void): WirePeer {
  const peer: WirePeer = {
    socket,
    maxBytes,
    buffer: Buffer.alloc(0),
    closed: false,
    send(value) {
      if (peer.closed || socket.destroyed) throw new Error('Bridge transport is closed');
      const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
      if (encoded.length > peer.maxBytes) throw new Error('Bridge transport frame exceeds limit');
      socket.write(encoded);
    },
    close() {
      if (peer.closed) return;
      peer.closed = true;
      socket.destroy();
    },
  };
  socket.on('data', (chunk: Buffer) => {
    if (peer.closed) return;
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    if (peer.buffer.length > peer.maxBytes && !peer.buffer.includes(0x0a)) {
      peer.close();
      return;
    }
    while (true) {
      const newline = peer.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = peer.buffer.subarray(0, newline);
      peer.buffer = peer.buffer.subarray(newline + 1);
      if (!frame.length) continue;
      if (frame.length > peer.maxBytes) { peer.close(); return; }
      try { onMessage(JSON.parse(frame.toString('utf8')) as unknown); }
      catch { peer.close(); return; }
    }
  });
  return peer;
}

function validCandidate(value: unknown): value is AgentAttachmentCandidate {
  const candidate = record(value);
  const process = record(candidate?.process);
  if (!candidate || !bounded(candidate.paneId, 256) || !bounded(candidate.attachmentId, 512)
    || (candidate.sessionId !== undefined && !bounded(candidate.sessionId, 1024))
    || (candidate.implementationVersion !== undefined
      && (!Number.isSafeInteger(candidate.implementationVersion)
        || Number(candidate.implementationVersion) <= 0))
    || !process || !Number.isSafeInteger(process.pid) || Number(process.pid) <= 0) return false;
  return (process.startedAt === undefined
      || (typeof process.startedAt === 'number' && Number.isFinite(process.startedAt)))
    && (process.tty === undefined || bounded(process.tty, 1024));
}

function validRun(value: unknown, adapterId: string, paneId: string): value is AgentRunRef {
  const run = record(value);
  return run !== null && run.agentId === adapterId && run.paneId === paneId
    && bounded(run.runId, 256)
    && (run.implementationVersion === undefined
      || (Number.isSafeInteger(run.implementationVersion)
        && Number(run.implementationVersion) > 0))
    && (run.sessionId === undefined || bounded(run.sessionId, 1024));
}

function validLimits(value: unknown): value is BridgeLimits {
  const limits = record(value);
  if (!limits) return false;
  return Object.entries(DEFAULT_BRIDGE_LIMITS).every(([name, maximum]) => {
    const actual = limits[name];
    return typeof actual === 'number' && Number.isFinite(actual) && actual > 0 && actual <= maximum;
  }) && Number(limits.defaultRequestTimeoutMs) <= Number(limits.maxRequestTimeoutMs);
}

function result(peer: WirePeer, id: unknown, value: unknown): void {
  if (bounded(id, 256)) peer.send({ type: 'result', id, ok: true, value });
}

function failure(peer: WirePeer, id: unknown, error: unknown): void {
  if (bounded(id, 256)) peer.send({ type: 'result', id, ok: false, error: errorMessage(error) });
}

async function liveSocket(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
      else finish(false, error);
    });
    socket.setTimeout(500, () => finish(false, new Error('Timed out probing existing Bridge socket')));
  });
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error('Bridge transport directory must be a private directory');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Bridge transport directory must be owned by the current user');
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error('Bridge transport directory could not be created privately');
    }
  }
}

export interface BridgeTransportServerOptions {
  socketPath: string;
  authToken: string;
  bridge: LocalAgentBridge;
  authorize(
    adapterId: string,
    candidate: AgentAttachmentCandidate,
    generation?: { id: string; replace: true },
  ): Promise<AgentRunLease>;
  connected?(lease: AgentRunLease, connection: LocalAgentBridgeConnection): void | Promise<void>;
  newNonce?: () => string;
  handshakeTimeoutMs?: number;
}

export class LocalAgentBridgeTransportServer {
  readonly socketPath: string;
  readonly #bridge: LocalAgentBridge;
  readonly #authToken: string;
  readonly #authorize: BridgeTransportServerOptions['authorize'];
  readonly #connected: BridgeTransportServerOptions['connected'];
  readonly #newNonce: () => string;
  readonly #handshakeTimeoutMs: number;
  readonly #sessions = new Set<ServerSession>();
  #server: net.Server | undefined;

  constructor({
    socketPath,
    authToken,
    bridge,
    authorize,
    connected,
    newNonce = () => crypto.randomBytes(32).toString('base64url'),
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  }:
  BridgeTransportServerOptions) {
    if (!path.isAbsolute(socketPath) || !bounded(authToken, 1024) || authToken.length < 32
      || !bridge || typeof authorize !== 'function' || !Number.isSafeInteger(handshakeTimeoutMs)
      || handshakeTimeoutMs <= 0 || (connected !== undefined && typeof connected !== 'function')) {
      throw new TypeError('Bridge transport requires an absolute socket path, Bridge, and authorizer');
    }
    this.socketPath = socketPath;
    this.#authToken = authToken;
    this.#bridge = bridge;
    this.#authorize = authorize;
    this.#connected = connected;
    this.#newNonce = newNonce;
    this.#handshakeTimeoutMs = handshakeTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    ensurePrivateDirectory(path.dirname(this.socketPath));
    if (await liveSocket(this.socketPath)) {
      throw new Error('Bridge transport socket is already owned by a live server');
    }
    try { fs.unlinkSync(this.socketPath); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (this.#server === server) this.#server = undefined;
      throw error;
    }
    try { fs.chmodSync(this.socketPath, 0o600); }
    catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const session of [...this.#sessions]) this.#closeSession(session);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(this.socketPath); } catch { /* already removed */ }
  }

  #accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    const nonce = this.#newNonce();
    const session = {} as ServerSession;
    const peer = wirePeer(socket, MAX_HANDSHAKE_BYTES, (value) => {
      const operation = session.tail.then(() => this.#message(session, nonce, value));
      session.tail = operation.catch((error) => {
        try { failure(peer, record(value)?.id, error); } catch { /* closing */ }
        if (!session.connection) this.#closeSession(session);
      });
    });
    const handshakeTimer = setTimeout(() => this.#closeSession(session), this.#handshakeTimeoutMs);
    handshakeTimer.unref?.();
    Object.assign(session, {
      peer, unregister: new Map(), pending: new Map(), handshakeTimer, tail: Promise.resolve(),
    } satisfies ServerSession);
    this.#sessions.add(session);
    socket.once('close', () => this.#closeSession(session));
    socket.once('error', () => this.#closeSession(session));
    peer.send({ type: 'challenge', protocolVersion: PROTOCOL_VERSION, nonce });
  }

  async #message(session: ServerSession, nonce: string, raw: unknown): Promise<void> {
    const value = record(raw);
    if (!value || typeof value.type !== 'string') throw new Error('Invalid Bridge transport frame');
    if (!session.connection) {
      if (value.type !== 'hello' || value.protocolVersion !== PROTOCOL_VERSION
        || !equalProof(value.proof, nonceProof(this.#authToken, nonce))
        || !bounded(value.adapterId, 64) || !NAME_RE.test(value.adapterId)
        || !validCandidate(value.candidate)) throw new Error('Invalid Bridge transport handshake');
      const replacing = value.newGeneration === true;
      if ((value.newGeneration !== undefined && typeof value.newGeneration !== 'boolean')
        || (replacing && !bounded(value.generationId, 256))
        || (!replacing && value.generationId !== undefined)) {
        throw new Error('Invalid Bridge transport generation');
      }
      const lease = await this.#authorize(
        value.adapterId,
        structuredClone(value.candidate),
        replacing ? { id: value.generationId as string, replace: true } : undefined,
      );
      if (lease.ref.agentId !== value.adapterId) throw new Error('Bridge transport authorization mismatch');
      if (!this.#sessions.has(session) || session.peer.closed) {
        throw new Error('Bridge transport closed during authorization');
      }
      session.lease = lease;
      session.connection = this.#bridge.connect(lease);
      session.connection.signal.addEventListener('abort', () => this.#closeSession(session), { once: true });
      await this.#connected?.(lease, session.connection);
      if (!this.#sessions.has(session) || session.peer.closed || session.connection.signal.aborted) {
        throw new Error('Bridge transport closed while activating connection');
      }
      if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
      session.handshakeTimer = undefined;
      session.peer.maxBytes = Math.max(
        session.connection.limits.maxFrameBytes,
        session.connection.limits.maxSnapshotBytes,
      ) + WIRE_OVERHEAD_BYTES;
      session.peer.send({
        type: 'ready', protocolVersion: PROTOCOL_VERSION,
        connectionId: session.connection.connectionId,
        run: lease.ref,
        limits: session.connection.limits,
      });
      return;
    }
    const connection = session.connection;
    const id = value.id;
    if (value.type === 'response') {
      if (!bounded(value.requestId, 256)) throw new Error('Invalid Bridge response id');
      const pending = session.pending.get(value.requestId);
      if (!pending) return;
      session.pending.delete(value.requestId);
      pending.detachAbort();
      if (value.ok === true) pending.resolve(value.value);
      else pending.reject(new Error(typeof value.error === 'string' ? value.error : 'Bridge handler failed'));
      return;
    }
    if (value.type === 'snapshot') {
      if (!bounded(id, 256) || !validChannelName(value.channel)) throw new Error('Invalid snapshot frame');
      result(session.peer, id, await connection.channel(value.channel).setSnapshot(value.value));
      return;
    }
    if (value.type === 'publish') {
      if (!bounded(id, 256) || !validChannelName(value.channel) || !record(value.event)
        || (value.delivery !== undefined && value.delivery !== 'ephemeral' && value.delivery !== 'durable')) {
        throw new Error('Invalid publish frame');
      }
      result(session.peer, id, await connection.channel(value.channel).publish(
        value.event as unknown as BridgePublishRequest,
        value.delivery === undefined ? undefined : { delivery: value.delivery },
      ));
      return;
    }
    if (value.type === 'handle') {
      if (!bounded(id, 256) || !validChannelName(value.channel) || !validChannelName(value.method)) {
        throw new Error('Invalid handler frame');
      }
      const key = `${value.channel}\0${value.method}`;
      if (session.unregister.has(key)) throw new Error('Bridge handler is already registered');
      const unregister = connection.channel(value.channel).handle(value.method, (payload, context) => (
        this.#requestClient(session, value.channel as string, value.method as string, payload, context)
      ));
      session.unregister.set(key, unregister);
      result(session.peer, id, { registered: true });
      return;
    }
    if (value.type === 'unhandle') {
      if (!bounded(id, 256) || !validChannelName(value.channel) || !validChannelName(value.method)) {
        throw new Error('Invalid unhandle frame');
      }
      const key = `${value.channel}\0${value.method}`;
      session.unregister.get(key)?.();
      session.unregister.delete(key);
      result(session.peer, id, { registered: false });
      return;
    }
    throw new Error('Unsupported Bridge transport frame');
  }

  #requestClient(
    session: ServerSession,
    channel: string,
    method: string,
    payload: unknown,
    context: BridgeRequestContext,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        if (!session.pending.delete(context.requestId)) return;
        try { session.peer.send({ type: 'cancel', requestId: context.requestId }); } catch { /* closed */ }
        reject(context.signal.reason instanceof Error ? context.signal.reason : new Error('Bridge request cancelled'));
      };
      context.signal.addEventListener('abort', cancel, { once: true });
      session.pending.set(context.requestId, {
        resolve, reject,
        detachAbort: () => context.signal.removeEventListener('abort', cancel),
      });
      try {
        session.peer.send({
          type: 'request', requestId: context.requestId, channel, method, payload,
          deadlineAt: context.deadlineAt,
        });
      } catch (error) {
        session.pending.delete(context.requestId);
        context.signal.removeEventListener('abort', cancel);
        reject(error);
      }
    });
  }

  #closeSession(session: ServerSession): void {
    if (!this.#sessions.delete(session)) return;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.handshakeTimer = undefined;
    for (const unregister of session.unregister.values()) unregister();
    session.unregister.clear();
    for (const pending of session.pending.values()) {
      pending.detachAbort();
      pending.reject(new Error('Bridge transport closed'));
    }
    session.pending.clear();
    session.connection?.close();
    session.peer.close();
  }
}

export interface BridgeTransportClientOptions {
  socketPath: string;
  authToken: string;
  adapterId: string;
  candidate: AgentAttachmentCandidate;
  generation?: { id: string; replace: true };
  connect?: typeof net.createConnection;
  newRequestId?: () => string;
  handshakeTimeoutMs?: number;
}

export interface BridgeTransportClientConnection {
  readonly run: AgentRunRef;
  readonly connectionId: string;
  readonly limits: BridgeLimits;
  readonly signal: AbortSignal;
  channel(name: string): {
    setSnapshot(value: unknown): Promise<BridgeWriteReceipt>;
    publish(event: BridgePublishRequest, options?: { delivery?: 'ephemeral' | 'durable' }):
      Promise<BridgeWriteReceipt>;
    handle(method: string, handler: BridgeRequestHandler): Promise<() => Promise<void>>;
  };
  close(): void;
}

export async function connectBridgeTransport({
  socketPath,
  authToken,
  adapterId,
  candidate,
  generation,
  connect = net.createConnection,
  newRequestId = crypto.randomUUID,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
}: BridgeTransportClientOptions): Promise<BridgeTransportClientConnection> {
  if (!path.isAbsolute(socketPath) || !bounded(authToken, 1024) || authToken.length < 32
    || !NAME_RE.test(adapterId) || !validCandidate(candidate)
    || (generation !== undefined && (!bounded(generation.id, 256) || generation.replace !== true))
    || !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new TypeError('Invalid Bridge transport client options');
  }
  const socket = connect(socketPath);
  const abort = new AbortController();
  const pending = new Map<string, ClientPending>();
  const handlers = new Map<string, BridgeRequestHandler>();
  const handlerAborts = new Map<string, AbortController>();
  let peer!: WirePeer;
  const nextId = (): string => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = newRequestId();
      if (bounded(id, 256) && !pending.has(id)) return id;
    }
    throw new Error('Unable to allocate Bridge wire request id');
  };
  const request = (value: JsonRecord): Promise<unknown> => new Promise((resolve, reject) => {
    const id = nextId();
    pending.set(id, { resolve, reject });
    try { peer.send({ ...value, id }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  let handshakeTimer: NodeJS.Timeout | undefined;
  let onHandshakeError!: (error: Error) => void;
  let onHandshakeClose!: () => void;
  const opened = new Promise<JsonRecord>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: JsonRecord } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
      if ('error' in outcome) reject(outcome.error); else resolve(outcome.value);
    };
    onHandshakeError = (error) => finish({ error });
    onHandshakeClose = () => finish({ error: new Error('Bridge transport closed during handshake') });
    socket.once('error', onHandshakeError);
    socket.once('close', onHandshakeClose);
    peer = wirePeer(socket, MAX_HANDSHAKE_BYTES, (raw) => {
      const value = record(raw);
      if (!value || typeof value.type !== 'string') { peer.close(); return; }
      if (value.type === 'challenge' && value.protocolVersion === PROTOCOL_VERSION
        && bounded(value.nonce, 256)) {
        peer.send({
          type: 'hello', protocolVersion: PROTOCOL_VERSION,
          proof: nonceProof(authToken, value.nonce),
          adapterId, candidate,
          ...(generation === undefined ? {} : {
            newGeneration: true,
            generationId: generation.id,
          }),
        });
        return;
      }
      if (value.type === 'ready') { finish({ value }); return; }
      if (value.type === 'result' && bounded(value.id, 256)) {
        const waiter = pending.get(value.id);
        if (!waiter) return;
        pending.delete(value.id);
        if (value.ok === true) waiter.resolve(value.value);
        else waiter.reject(new Error(typeof value.error === 'string' ? value.error : 'Bridge operation failed'));
        return;
      }
      if (value.type === 'cancel' && bounded(value.requestId, 256)) {
        handlerAborts.get(value.requestId)?.abort('server_cancelled');
        handlerAborts.delete(value.requestId);
        return;
      }
      if (value.type === 'request' && bounded(value.requestId, 256)
        && validChannelName(value.channel) && validChannelName(value.method)
        && typeof value.deadlineAt === 'number') {
        const handler = handlers.get(`${value.channel}\0${value.method}`);
        if (!handler) {
          peer.send({ type: 'response', requestId: value.requestId, ok: false, error: 'handler unavailable' });
          return;
        }
        const controller = new AbortController();
        handlerAborts.set(value.requestId, controller);
        Promise.resolve(handler(value.payload, {
          requestId: value.requestId,
          deadlineAt: value.deadlineAt,
          signal: controller.signal,
        })).then(
          (response) => {
            try { peer.send({ type: 'response', requestId: value.requestId, ok: true, value: response }); }
            catch { /* request was cancelled or transport closed */ }
          },
          (error: unknown) => {
            try {
              peer.send({
                type: 'response', requestId: value.requestId, ok: false, error: errorMessage(error),
              });
            } catch { /* request was cancelled or transport closed */ }
          },
        ).finally(() => handlerAborts.delete(value.requestId as string)).catch(() => {});
      }
    });
    handshakeTimer = setTimeout(() => {
      finish({ error: new Error('Bridge transport handshake timed out') });
      peer.close();
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();
  });
  const close = (): void => {
    if (abort.signal.aborted) return;
    abort.abort('transport_closed');
    peer.close();
    for (const waiter of pending.values()) waiter.reject(new Error('Bridge transport closed'));
    pending.clear();
    for (const controller of handlerAborts.values()) controller.abort('transport_closed');
    handlerAborts.clear();
  };
  socket.once('close', close);
  let handshake: JsonRecord;
  try { handshake = await opened; } catch (error) { close(); throw error; }
  socket.removeListener('error', onHandshakeError);
  socket.removeListener('close', onHandshakeClose);
  socket.on('error', close);
  if (handshake.protocolVersion !== PROTOCOL_VERSION
    || !validRun(handshake.run, adapterId, candidate.paneId)
    || !bounded(handshake.connectionId, 256) || !validLimits(handshake.limits)) {
    close();
    throw new Error('Invalid Bridge transport ready frame');
  }
  const limits = handshake.limits as unknown as BridgeLimits;
  peer.maxBytes = Math.max(limits.maxFrameBytes, limits.maxSnapshotBytes) + WIRE_OVERHEAD_BYTES;
  const channels = new Map<string, ReturnType<BridgeTransportClientConnection['channel']>>();
  return Object.freeze({
    run: structuredClone(handshake.run) as unknown as AgentRunRef,
    connectionId: handshake.connectionId,
    limits: structuredClone(limits),
    signal: abort.signal,
    channel(name: string) {
      if (!validChannelName(name) || abort.signal.aborted) throw new Error('Invalid or closed Bridge channel');
      const existing = channels.get(name);
      if (existing) return existing;
      const channel = Object.freeze({
        setSnapshot: (value: unknown) => (
          request({ type: 'snapshot', channel: name, value }) as Promise<BridgeWriteReceipt>
        ),
        publish: (event: BridgePublishRequest, options?: { delivery?: 'ephemeral' | 'durable' }) => (request({
          type: 'publish', channel: name, event,
          ...(options?.delivery === undefined ? {} : { delivery: options.delivery }),
        }) as Promise<BridgeWriteReceipt>),
        async handle(method: string, handler: BridgeRequestHandler) {
          if (!validChannelName(method) || typeof handler !== 'function') {
            throw new Error('Invalid Bridge handler');
          }
          const key = `${name}\0${method}`;
          if (handlers.has(key)) throw new Error('Bridge handler is already registered');
          handlers.set(key, handler);
          try { await request({ type: 'handle', channel: name, method }); }
          catch (error) { handlers.delete(key); throw error; }
          return async (): Promise<void> => {
            if (handlers.get(key) !== handler) return;
            handlers.delete(key);
            await request({ type: 'unhandle', channel: name, method });
          };
        },
      });
      channels.set(name, channel);
      return channel;
    },
    close,
  });
}
