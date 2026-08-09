import { getToken } from './storage.js';
import {
  parseTerminalStreamMessage,
  type TerminalReadyMessage,
  type TerminalSeedMessage,
  type TerminalStreamMessage,
} from './terminalStreamProtocol.js';

const RECONNECT_MS = 1000;
const CONNECT_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 8000;
const MAX_FRAME_LAG_MS = 300;
const MAX_PENDING_DATA_BYTES = 256 * 1024;
const PROBE_INTERVAL_MS = 10000;
const PROBE_TIMEOUT_MS = 5000;

export type TerminalStreamStatus = 'connecting' | 'live' | 'paused' | 'reconnecting' | 'error';
export type TerminalProbeResult = { ok: true; rttMs: number } | { ok: false };

type AsyncCallback<Result = void> = Result | Promise<Result>;
type TerminalClientMessage =
  | { type: 'subscribe'; token: string; pane: string }
  | { type: 'resync' }
  | { type: 'pause' }
  | { type: 'probe'; id: number };

interface PendingProbe {
  id: number;
  sentAt: number;
}

interface DataBatch {
  epoch: number;
  queuedAt: number;
  chunks: ArrayBuffer[];
  byteLength: number;
}

export interface TerminalWebSocket {
  readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TerminalWebSocketConstructor {
  readonly OPEN: number;
  new(url: string | URL): TerminalWebSocket;
}

export interface TerminalStreamOptions {
  pane: string;
  onSeed?: (message: TerminalSeedMessage) => AsyncCallback;
  onData?: (data: Uint8Array) => AsyncCallback;
  onReady?: (message: TerminalReadyMessage) => AsyncCallback;
  onStatus?: (status: TerminalStreamStatus) => void;
  onProbe?: (result: TerminalProbeResult) => void;
  onAuthFail?: () => void;
  WebSocketCtor?: TerminalWebSocketConstructor;
  token?: string;
  reconnectMs?: number;
  connectTimeoutMs?: number;
  readyTimeoutMs?: number;
  maxFrameLagMs?: number;
  maxPendingDataBytes?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface TerminalStreamController {
  pause(): void;
  suspend(): Promise<void>;
  resync(): void;
  close(): Promise<void>;
}

export function openTerminalStream({
  pane,
  onSeed,
  onData,
  onReady,
  onStatus,
  onProbe,
  onAuthFail,
  WebSocketCtor = window.WebSocket,
  token = getToken() ?? '',
  reconnectMs = RECONNECT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  maxFrameLagMs = MAX_FRAME_LAG_MS,
  maxPendingDataBytes = MAX_PENDING_DATA_BYTES,
  probeIntervalMs = PROBE_INTERVAL_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  now = () => Date.now(),
}: TerminalStreamOptions): TerminalStreamController {
  let socket: TerminalWebSocket | null = null;
  let subscribedSocket: TerminalWebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let paused = false;
  let writes: Promise<void> = Promise.resolve();
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let messageEpoch = 0;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probeTimeout: ReturnType<typeof setTimeout> | null = null;
  let probeId = 0;
  let pendingProbe: PendingProbe | null = null;
  let pendingDataBytes = 0;
  let awaitingSeed = true;
  let streamReady = false;
  let queuedDataBatch: DataBatch | null = null;
  let hasBeenLive = false;
  let startupFailures = 0;

  const clearProbe = (): void => {
    if (probeTimer) clearInterval(probeTimer);
    if (probeTimeout) clearTimeout(probeTimeout);
    probeTimer = null;
    probeTimeout = null;
    pendingProbe = null;
  };

  const clearConnectTimer = (): void => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };
  const armConnectTimer = (target: TerminalWebSocket, timeoutMs: number): void => {
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      if (socket === target && target.readyState !== 3) target.close(4000, 'stream timeout');
    }, timeoutMs);
  };

  const send = (message: TerminalClientMessage): void => {
    if (socket?.readyState === WebSocketCtor.OPEN) socket.send(JSON.stringify(message));
  };
  const probe = (): void => {
    if (closed || paused || !subscribedSocket || pendingProbe) return;
    const id = ++probeId;
    pendingProbe = { id, sentAt: now() };
    send({ type: 'probe', id });
    probeTimeout = setTimeout(() => {
      if (pendingProbe?.id !== id) return;
      pendingProbe = null;
      probeTimeout = null;
      onProbe?.({ ok: false });
    }, probeTimeoutMs);
  };
  const startProbes = (): void => {
    clearProbe();
    probe();
    probeTimer = setInterval(probe, probeIntervalMs);
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const detachSocket = (): void => {
    const target = socket;
    socket = null;
    if (subscribedSocket === target) subscribedSocket = null;
    pendingDataBytes = 0;
    awaitingSeed = true;
    streamReady = false;
    queuedDataBatch = null;
    clearConnectTimer();
    clearProbe();
    try { target?.close(); } catch { /* already closed */ }
  };

  let connect: () => void;

  const requestFreshSeed = (): void => {
    if (closed || paused || awaitingSeed) return;
    messageEpoch += 1;
    pendingDataBytes = 0;
    awaitingSeed = true;
    streamReady = false;
    queuedDataBatch = null;
    if (socket?.readyState === WebSocketCtor.OPEN) {
      onStatus?.('connecting');
      armConnectTimer(socket, readyTimeoutMs);
      clearProbe();
      if (subscribedSocket === socket) send({ type: 'resync' });
      else {
        subscribedSocket = socket;
        send({ type: 'subscribe', token, pane });
      }
    } else connect();
  };

  connect = (): void => {
    if (closed || paused) return;
    if (socket && (socket.readyState === 0 || socket.readyState === WebSocketCtor.OPEN)) return;
    clearReconnectTimer();
    onStatus?.('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const nextSocket = new WebSocketCtor(`${protocol}//${window.location.host}/api/terminal-stream`);
    socket = nextSocket;
    pendingDataBytes = 0;
    awaitingSeed = true;
    streamReady = false;
    queuedDataBatch = null;
    // The network handshake and the first tmux frame are different operations. Keep a short deadline
    // while WebSocket itself is unavailable, then give the server's cold tmux attach/capture path enough
    // time to finish (the server allows five seconds for attach alone).
    armConnectTimer(nextSocket, connectTimeoutMs);
    nextSocket.binaryType = 'arraybuffer';
    nextSocket.onopen = () => {
      if (socket !== nextSocket || closed || paused) return;
      subscribedSocket = nextSocket;
      armConnectTimer(nextSocket, readyTimeoutMs);
      send({ type: 'subscribe', token, pane });
    };
    nextSocket.onmessage = (event: MessageEvent<unknown>) => {
      if (socket !== nextSocket) return;
      const incoming: unknown = event.data;
      let message: TerminalStreamMessage | null = null;
      let binaryData: ArrayBuffer | null = null;
      if (typeof incoming === 'string') {
        let decoded: unknown;
        try { decoded = JSON.parse(incoming); } catch {
          nextSocket.close(1003, 'bad stream frame');
          return;
        }
        message = parseTerminalStreamMessage(decoded);
        if (!message) {
          nextSocket.close(1003, 'bad stream frame');
          return;
        }
        if (message.type === 'probe') {
          if (pendingProbe?.id === message.id) {
            const rttMs = Math.max(0, now() - pendingProbe.sentAt);
            pendingProbe = null;
            if (probeTimeout) clearTimeout(probeTimeout);
            probeTimeout = null;
            onProbe?.({ ok: true, rttMs });
          }
          return;
        }
        // A protocol frame is an ordering boundary. Binary output received after it must not merge
        // into a batch that will be parsed before it.
        queuedDataBatch = null;
        if (awaitingSeed && message.type !== 'seed') return;
        if (message.type === 'seed') {
          awaitingSeed = false;
          streamReady = false;
        }
      } else {
        if (!(incoming instanceof ArrayBuffer)) {
          nextSocket.close(1003, 'bad stream frame');
          return;
        }
        if (awaitingSeed) return;
        binaryData = incoming;
        pendingDataBytes += binaryData.byteLength;
        if (pendingDataBytes > maxPendingDataBytes) {
          requestFreshSeed();
          return;
        }
        if (queuedDataBatch?.epoch === messageEpoch) {
          queuedDataBatch.chunks.push(binaryData);
          queuedDataBatch.byteLength += binaryData.byteLength;
          return;
        }
      }
      const frameEpoch = messageEpoch;
      const queuedAt = Date.now();
      const dataBatch: DataBatch | null = binaryData ? {
        epoch: frameEpoch,
        queuedAt,
        chunks: [binaryData],
        byteLength: binaryData.byteLength,
      } : null;
      if (dataBatch) queuedDataBatch = dataBatch;
      writes = writes.then(async () => {
        if (dataBatch && queuedDataBatch === dataBatch) queuedDataBatch = null;
        if (closed || paused || frameEpoch !== messageEpoch) return;
        pendingDataBytes = Math.max(0, pendingDataBytes - (dataBatch?.byteLength ?? 0));
        if (streamReady && dataBatch && Date.now() - dataBatch.queuedAt > maxFrameLagMs) {
          requestFreshSeed();
          return;
        }
        if (dataBatch) {
          if (dataBatch.chunks.length === 1) {
            await onData?.(new Uint8Array(dataBatch.chunks[0]));
            return;
          }
          const joined = new Uint8Array(dataBatch.byteLength);
          let offset = 0;
          for (const chunk of dataBatch.chunks) {
            const bytes = new Uint8Array(chunk);
            joined.set(bytes, offset);
            offset += bytes.byteLength;
          }
          await onData?.(joined);
          return;
        }
        if (!message) return;
        if (message.type === 'seed') await onSeed?.(message);
        else if (message.type === 'ready') {
          await onReady?.(message);
          streamReady = true;
          hasBeenLive = true;
          startupFailures = 0;
          clearConnectTimer();
          onStatus?.('live');
          startProbes();
        }
      }).catch(() => {
        onStatus?.('error');
        if (socket === nextSocket) nextSocket.close(1003, 'bad stream frame');
      });
    };
    nextSocket.onclose = (event) => {
      if (socket !== nextSocket) return;
      socket = null;
      if (subscribedSocket === nextSocket) subscribedSocket = null;
      clearConnectTimer();
      clearProbe();
      if (closed) return;
      if (event.code === 4001) {
        onAuthFail?.();
        return;
      }
      // A cold app launch can lose its first stream while the tunnel and tmux control path warm up.
      // Complete one fresh connection attempt before telling Terminal to fall back to snapshots. Once a
      // stream has been live, preserve the existing fast-fallback behaviour for real network drops.
      const retryColdStart = !hasBeenLive && startupFailures === 0;
      if (!hasBeenLive) startupFailures += 1;
      onStatus?.(retryColdStart ? 'connecting' : 'reconnecting');
      if (!paused) reconnectTimer = setTimeout(connect, reconnectMs);
    };
    nextSocket.onerror = () => {
      if (socket === nextSocket) nextSocket.close();
    };
  };

  connect();
  return {
    pause() {
      if (closed || paused) return;
      paused = true;
      messageEpoch += 1;
      pendingDataBytes = 0;
      awaitingSeed = true;
      streamReady = false;
      queuedDataBatch = null;
      clearReconnectTimer();
      clearConnectTimer();
      clearProbe();
      send({ type: 'pause' });
      onStatus?.('paused');
    },
    suspend() {
      if (closed) return writes;
      paused = true;
      messageEpoch += 1;
      clearReconnectTimer();
      detachSocket();
      onStatus?.('paused');
      return writes;
    },
    resync() {
      if (closed) return;
      paused = false;
      messageEpoch += 1;
      pendingDataBytes = 0;
      awaitingSeed = true;
      streamReady = false;
      queuedDataBatch = null;
      if (socket?.readyState === WebSocketCtor.OPEN) {
        onStatus?.('connecting');
        armConnectTimer(socket, readyTimeoutMs);
        clearProbe();
        if (subscribedSocket === socket) send({ type: 'resync' });
        else {
          subscribedSocket = socket;
          send({ type: 'subscribe', token, pane });
        }
      } else connect();
    },
    close() {
      closed = true;
      messageEpoch += 1;
      pendingDataBytes = 0;
      streamReady = false;
      queuedDataBatch = null;
      clearReconnectTimer();
      detachSocket();
      return writes;
    },
  };
}
