import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { tokenEquals } from './auth.js';
import { isPaneId } from './tmux/commands.js';
import { restoreCaptureBackgrounds } from './captureBackground.js';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
const START_TIMEOUT_MS = 5000;
const SUBSCRIBE_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const INITIAL_HISTORY_LINES = 100;
const PANE_INFO = '"#{pane_width}\\t#{pane_height}\\t#{cursor_x}\\t#{cursor_y}\\t#{cursor_flag}\\t#{alternate_on}\\t#{mouse_any_flag}\\t#{mouse_sgr_flag}"';

type StreamPhase = 'attach' | 'capture' | 'buffer' | 'paused' | 'live' | 'closed';
type PaneInfoValues = [number, number, number, number, number, number, number, number];
type ControlLines = Buffer[];
type ControlOnEnd = (lines: ControlLines) => void;

interface TerminalSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): unknown;
  send(data: string | Buffer, options: { binary: boolean }): unknown;
  close(code?: number, reason?: string): unknown;
}

interface ControlDataStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface ControlChild {
  readonly stdin: { write(value: string): unknown };
  readonly stdout: ControlDataStream;
  readonly stderr: ControlDataStream;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

type SpawnControl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ControlChild;

interface ControlWaiter {
  resolve(lines: ControlLines): void;
  reject(reason: unknown): void;
  onEnd?: ControlOnEnd;
}

interface ControlResponse { lines: ControlLines; waiter: ControlWaiter | null }
interface PaneControlStreamOptions {
  ws: TerminalSocket;
  pane: string;
  session: string;
  spawnControl?: SpawnControl;
}
interface TerminalCommands { paneSession(pane: string): Promise<string> }
interface TerminalStreamOptions {
  token: string;
  commands: TerminalCommands;
  spawnControl?: SpawnControl;
}
type LiveWebSocket = WebSocket & { isAlive?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultSpawnControl: SpawnControl = (command, args, options) =>
  spawn(command, [...args], options);

export function echoTerminalProbe(ws: TerminalSocket, message: unknown): boolean {
  if (!isRecord(message) || message.type !== 'probe'
    || typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id < 0) return false;
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'probe', id: message.id }));
  return true;
}

export function startSubscribeDeadline(ws: TerminalSocket, timeoutMs = SUBSCRIBE_TIMEOUT_MS): () => void {
  const timer = setTimeout(() => {
    if (ws.readyState < 2) ws.close(4001, 'authentication timeout');
  }, timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function parsePaneInfo(infoLines: ControlLines): PaneInfoValues {
  const values = Buffer.concat(infoLines).toString('utf8').split('\t').map(Number);
  if (!values.every(Number.isFinite) || values.length !== 8 || values[0] < 1 || values[1] < 1) {
    throw new Error('invalid tmux pane info');
  }
  return values as PaneInfoValues;
}

export function decodeControlData(data: Buffer): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < data.length;) {
    if (data[i] === 0x5c && data[i + 1] === 0x5c) {
      bytes.push(0x5c);
      i += 2;
      continue;
    }
    if (data[i] === 0x5c && i + 3 < data.length) {
      const a = data[i + 1];
      const b = data[i + 2];
      const c = data[i + 3];
      if (a >= 0x30 && a <= 0x37 && b >= 0x30 && b <= 0x37 && c >= 0x30 && c <= 0x37) {
        bytes.push(((a - 0x30) << 6) | ((b - 0x30) << 3) | (c - 0x30));
        i += 4;
        continue;
      }
    }
    bytes.push(data[i]);
    i += 1;
  }
  return Buffer.from(bytes);
}

export class PaneControlStream {
  readonly ws: TerminalSocket;
  readonly pane: string;
  buffer: Buffer;
  waiters: ControlWaiter[];
  response: ControlResponse | null;
  phase: StreamPhase;
  wantLive: boolean;
  pendingOutput: Buffer[];
  pendingOutputBytes: number;
  resyncing: Promise<void> | null;
  readonly attached: Promise<void>;
  readonly startTimer: NodeJS.Timeout;
  readonly child: ControlChild;
  resolveAttached!: () => void;
  rejectAttached!: (reason?: unknown) => void;
  lastError?: string;

  constructor({ ws, pane, session, spawnControl = defaultSpawnControl }: PaneControlStreamOptions) {
    this.ws = ws;
    this.pane = pane;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.response = null;
    this.phase = 'attach';
    this.wantLive = true;
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    this.resyncing = null;
    this.attached = new Promise((resolve, reject) => {
      this.resolveAttached = resolve;
      this.rejectAttached = reject;
    });
    this.startTimer = setTimeout(
      () => this.rejectAttached(new Error('tmux control mode attach timed out')),
      START_TIMEOUT_MS,
    );
    this.child = spawnControl('tmux', ['-C', 'attach-session', '-t', session], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.onChunk(chunk));
    this.child.stderr.on('data', (chunk) => { this.lastError = chunk.toString('utf8'); });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => {
      if (this.phase !== 'closed') this.fail(new Error(this.lastError || `tmux control mode exited (${code})`));
    });
  }

  onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.onLine(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
    }
  }

  onLine(line: Buffer): void {
    if (line.subarray(0, 8).toString('ascii') === '%output ') {
      const split = line.indexOf(0x20, 8);
      if (split < 0 || line.subarray(8, split).toString('ascii') !== this.pane) return;
      // Paused/capturing output is intentionally discarded. Avoid decoding and allocating a second
      // byte buffer for data that no client will consume.
      if (this.phase !== 'buffer' && this.phase !== 'live') return;
      const output = decodeControlData(line.subarray(split + 1));
      if (this.phase === 'buffer') {
        if (this.pendingOutputBytes + output.length > MAX_BUFFERED_BYTES) {
          this.wantLive = false;
          this.phase = 'paused';
          this.pendingOutput = [];
          this.pendingOutputBytes = 0;
          if (this.ws.readyState < 2) this.ws.close(1013, 'stream fell behind');
        } else {
          this.pendingOutput.push(output);
          this.pendingOutputBytes += output.length;
        }
      }
      else if (this.phase === 'live') this.sendOutput(output);
      return;
    }
    if (line.subarray(0, 7).toString('ascii') === '%begin ') {
      this.response = { lines: [], waiter: this.waiters.shift() ?? null };
      return;
    }
    const end = line.subarray(0, 5).toString('ascii') === '%end ';
    const error = line.subarray(0, 7).toString('ascii') === '%error ';
    if (end || error) {
      const response = this.response;
      this.response = null;
      if (response?.waiter) {
        if (error) {
          response.waiter.reject(new Error(Buffer.concat(response.lines).toString('utf8')));
        } else {
          try {
            // Run the boundary callback synchronously, before onChunk can consume any notification
            // following this %end in the same stdout chunk. Resync uses this to publish ready before
            // later %output, so an older cursor snapshot can never overwrite newer streamed movement.
            response.waiter.onEnd?.(response.lines);
            response.waiter.resolve(response.lines);
          } catch (callbackError) {
            response.waiter.reject(callbackError);
          }
        }
      }
      return;
    }
    if (this.response) {
      this.response.lines.push(Buffer.from(line));
      return;
    }
    if (line.subarray(0, 17).toString('ascii') === '%session-changed ') {
      clearTimeout(this.startTimer);
      this.resolveAttached();
    }
  }

  request(command: string, onEnd?: ControlOnEnd): Promise<ControlLines> {
    return new Promise<ControlLines>((resolve, reject) => {
      if (this.phase === 'closed') {
        reject(new Error('tmux control stream closed'));
        return;
      }
      this.waiters.push({ resolve, reject, ...(onEnd ? { onEnd } : {}) });
      this.child.stdin.write(`${command}\n`);
    });
  }

  sendOutput(output: Buffer): void {
    if (this.ws.readyState !== 1) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.close(1013, 'stream fell behind');
      return;
    }
    this.ws.send(output, { binary: true });
  }

  sendJson(message: Record<string, unknown>): boolean {
    if (this.ws.readyState !== 1) return false;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.close(1013, 'stream fell behind');
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }

  async start(): Promise<void> {
    await this.attached;
    await this.resync();
  }

  pause(): void {
    if (this.phase !== 'closed') {
      this.wantLive = false;
      this.phase = 'paused';
      this.pendingOutput = [];
      this.pendingOutputBytes = 0;
    }
  }

  private setPhase(phase: StreamPhase): void {
    this.phase = phase;
  }

  resync(): Promise<void> {
    this.wantLive = true;
    if (this.resyncing) return this.resyncing;
    this.resyncing = this.runResync().finally(() => { this.resyncing = null; });
    return this.resyncing;
  }

  async runResync(): Promise<void> {
    await this.attached;
    this.setPhase('capture');
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    const captureLines = await this.request(
      `capture-pane -p -e -N -S -${INITIAL_HISTORY_LINES} -t ${this.pane}`,
      () => { this.phase = this.wantLive ? 'buffer' : 'paused'; },
    );
    const preliminaryInfo = await this.request(
      `display-message -p -t ${this.pane} ${PANE_INFO}`,
    );
    const [, height, , , , alternateOn] = parsePaneInfo(preliminaryInfo);
    if (!this.wantLive || this.phase === 'closed') {
      this.pendingOutput = [];
      this.pendingOutputBytes = 0;
      if (this.phase !== 'closed') this.phase = 'paused';
      return;
    }
    const sourceLines = alternateOn === 1 ? captureLines.slice(-height) : captureLines;
    const captured = Buffer.concat(sourceLines.flatMap((line) => [line, Buffer.from('\n')]))
      .toString('utf8');
    const restored = await restoreCaptureBackgrounds(captured, height, async (row) => {
      const exact = await this.request(
        `capture-pane -p -e -N -S ${row} -E ${row} -t ${this.pane}`,
      );
      return `${Buffer.concat(exact).toString('utf8')}\n`;
    });
    const restoredLines: Buffer[] = restored.ansi.endsWith('\n')
      ? restored.ansi.slice(0, -1).split('\n').map((line) => Buffer.from(line))
      : restored.ansi.split('\n').map((line) => Buffer.from(line));
    // Re-read size/cursor after the targeted row checks. Output produced while those checks ran is
    // buffered; the synchronous onEnd handoff below publishes seed → buffered output → fresh cursor
    // before any later %output from the same control chunk can overtake it.
    await this.request(
      `display-message -p -t ${this.pane} ${PANE_INFO}`,
      (infoLines) => this.finishResync(restoredLines, infoLines),
    );
  }

  finishResync(captureLines: ControlLines, infoLines: ControlLines): void {
    const [width, height, cursorX, cursorY, cursorFlag, alternateOn, mouseAny, mouseSgr] =
      parsePaneInfo(infoLines);
    if (!this.wantLive || this.phase === 'closed') {
      this.pendingOutput = [];
      this.pendingOutputBytes = 0;
      if (this.phase !== 'closed') this.phase = 'paused';
      return;
    }
    // Alternate-screen apps have no history of their own. tmux's -S capture may prepend the main
    // screen's scrollback, so keep only the alternate screen's real grid there.
    const visibleCapture = alternateOn === 1 ? captureLines.slice(-height) : captureLines;
    const historyLines = Math.max(0, visibleCapture.length - height);
    const ansi = Buffer.concat(visibleCapture.flatMap((line) => [line, Buffer.from('\n')])).toString('utf8');
    if (!this.sendJson({
      type: 'seed',
      ansi,
      width,
      height,
      historyLines,
      alt: alternateOn === 1,
      mouseAware: mouseAny === 1,
      mouseSgr: mouseSgr === 1,
    })) return;
    for (const output of this.pendingOutput) this.sendOutput(output);
    if (!this.sendJson({
      type: 'ready',
      cur: { row: height - 1 - cursorY, col: cursorX, vis: cursorFlag === 1 },
    })) return;
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    this.phase = this.wantLive ? 'live' : 'paused';
  }

  fail(error: unknown): void {
    clearTimeout(this.startTimer);
    this.rejectAttached(error);
    this.response?.waiter?.reject(error);
    this.response = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    if (this.ws.readyState < 2) this.ws.close(1011, 'tmux stream failed');
  }

  close(): void {
    clearTimeout(this.startTimer);
    this.phase = 'closed';
    this.wantLive = false;
    const error = new Error('tmux control stream closed');
    this.response?.waiter?.reject(error);
    this.response = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.pendingOutput = [];
    this.pendingOutputBytes = 0;
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

export function createTerminalStream({
  token,
  commands,
  spawnControl,
}: TerminalStreamOptions): {
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
} {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  const streams = new Set<PaneControlStream>();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const ws = socket as LiveWebSocket;
      if (ws.readyState !== 1) continue;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('connection', (socket) => {
    const ws = socket as LiveWebSocket;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const cancelSubscribeDeadline = startSubscribeDeadline(ws);
    let authenticating = false;
    let stream: PaneControlStream | null = null;
    ws.on('message', async (raw, binary) => {
      if (binary) return;
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(1003, 'bad message'); return; }
      if (!isRecord(message)) { ws.close(1003, 'bad message'); return; }
      if (stream) {
        if (echoTerminalProbe(ws, message)) return;
        if (message.type === 'pause') stream.pause();
        else if (message.type === 'resync') {
          try { await stream.resync(); } catch {
            if (ws.readyState < 2) ws.close(1011, 'stream resync failed');
          }
        }
        return;
      }
      if (authenticating) return;
      if (message.type !== 'subscribe'
        || !tokenEquals(message.token ?? '', token)
        || !isPaneId(message.pane)) {
        ws.close(4001, 'unauthorized');
        return;
      }
      authenticating = true;
      cancelSubscribeDeadline();
      try {
        const session = await commands.paneSession(message.pane);
        if (ws.readyState !== 1) return;
        stream = new PaneControlStream({
          ws, pane: message.pane, session,
          ...(spawnControl ? { spawnControl } : {}),
        });
        streams.add(stream);
        await stream.start();
      } catch {
        if (ws.readyState < 2) ws.close(1011, 'stream setup failed');
      }
    });
    ws.on('close', () => {
      cancelSubscribeDeadline();
      if (stream) {
        stream.close();
        streams.delete(stream);
      }
    });
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '', 'http://handmux.local').pathname; } catch { return false; }
    if (pathname !== '/api/terminal-stream') return false;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return true;
  };

  const close = (): void => {
    clearInterval(heartbeat);
    for (const stream of streams) stream.close();
    streams.clear();
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    wss.close();
  };

  return { onUpgrade, close };
}
