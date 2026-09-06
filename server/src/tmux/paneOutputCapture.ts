import { spawn } from 'node:child_process';
import { decodeControlData } from './controlProtocol.js';

const START_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

interface ControlDataStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface ControlChild {
  readonly stdin: {
    write(value: string, callback?: (error?: Error | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
  };
  readonly stdout: ControlDataStream;
  readonly stderr: ControlDataStream;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export type SpawnControl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => ControlChild;

interface BoundaryWaiter {
  resolve(): void;
  reject(reason: unknown): void;
}

interface TmuxPaneOutputCaptureOptions {
  pane: string;
  session: string;
  maxBytes?: number;
  spawnControl?: SpawnControl;
}

const defaultSpawnControl: SpawnControl = (command, args, options) => (
  spawn(command, [...args], options)
);

export class TmuxPaneOutputCapture {
  readonly #pane: string;
  readonly #maxBytes: number;
  readonly #child: ControlChild;
  readonly #attached: Promise<void>;
  readonly #startTimer: NodeJS.Timeout;
  #resolveAttached!: () => void;
  #rejectAttached!: (reason: unknown) => void;
  #buffer = Buffer.alloc(0);
  #response: BoundaryWaiter | null | undefined;
  #pending: BoundaryWaiter | null = null;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #armed = false;
  #overflow = false;
  #failed = false;
  #closed = false;
  #lastError = '';

  constructor({
    pane, session, maxBytes = DEFAULT_MAX_BYTES, spawnControl = defaultSpawnControl,
  }: TmuxPaneOutputCaptureOptions) {
    if (!/^%\d+$/.test(pane) || !/^\$\d+$/.test(session)) {
      throw new TypeError('invalid tmux pane output capture target');
    }
    this.#pane = pane;
    this.#maxBytes = Math.max(1, Math.trunc(maxBytes));
    this.#attached = new Promise((resolve, reject) => {
      this.#resolveAttached = resolve;
      this.#rejectAttached = reject;
    });
    this.#startTimer = setTimeout(
      () => this.#fail(new Error('tmux control mode attach timed out')),
      START_TIMEOUT_MS,
    );
    this.#startTimer.unref?.();
    this.#child = spawnControl('tmux', ['-C', 'attach-session', '-E', '-t', session], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', (chunk) => this.#onChunk(chunk));
    this.#child.stderr.on('data', (chunk) => { this.#lastError += chunk.toString('utf8'); });
    this.#child.stdin.on('error', (error) => this.#fail(error));
    this.#child.on('error', (error) => this.#fail(error));
    this.#child.on('exit', (code) => {
      if (!this.#closed) this.#fail(new Error(
        this.#lastError || `tmux control mode exited (${code ?? 'unknown'})`,
      ));
    });
  }

  async start(): Promise<void> {
    await this.#attached;
  }

  async sendKey(key: string): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new TypeError('invalid tmux key');
    await this.#attached;
    await this.#request(`send-keys -t ${this.#pane} ${key}`);
  }

  output(): Buffer | null {
    if (!this.#armed || this.#failed || this.#overflow) return null;
    return Buffer.concat(this.#chunks, this.#bytes);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#startTimer);
    const error = new Error('tmux control output capture closed');
    this.#rejectAttached(error);
    this.#pending?.reject(error);
    this.#response?.reject(error);
    this.#pending = null;
    this.#response = undefined;
    try { this.#child.kill(); } catch { /* already gone */ }
  }

  #onChunk(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
    }
  }

  #onLine(line: Buffer): void {
    if (line.subarray(0, 8).toString('ascii') === '%output ') {
      const split = line.indexOf(0x20, 8);
      if (!this.#armed || split < 0
        || line.subarray(8, split).toString('ascii') !== this.#pane) return;
      const output = decodeControlData(line.subarray(split + 1));
      if (this.#bytes + output.length > this.#maxBytes) {
        this.#overflow = true;
        this.#chunks = [];
        this.#bytes = 0;
        return;
      }
      if (!this.#overflow) {
        this.#chunks.push(output);
        this.#bytes += output.length;
      }
      return;
    }
    if (line.subarray(0, 7).toString('ascii') === '%begin ') {
      this.#response = this.#pending;
      this.#pending = null;
      return;
    }
    const ended = line.subarray(0, 5).toString('ascii') === '%end ';
    const errored = line.subarray(0, 7).toString('ascii') === '%error ';
    if (ended || errored) {
      const response = this.#response;
      this.#response = undefined;
      if (response) {
        if (errored) response.reject(new Error('tmux control command failed'));
        else {
          // tmux never inserts notifications inside a command output block. Arming synchronously at
          // this %end makes every subsequently parsed %output byte provably newer than this C-c.
          this.#chunks = [];
          this.#bytes = 0;
          this.#overflow = false;
          this.#armed = true;
          response.resolve();
        }
      }
      return;
    }
    if (line.subarray(0, 17).toString('ascii') === '%session-changed ') {
      clearTimeout(this.#startTimer);
      this.#resolveAttached();
      return;
    }
    if (line.subarray(0, 5).toString('ascii') === '%exit') {
      this.#fail(new Error('tmux control mode detached'));
    }
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    this.#closed = true;
    clearTimeout(this.#startTimer);
    this.#rejectAttached(error);
    this.#pending?.reject(error);
    this.#response?.reject(error);
    this.#pending = null;
    this.#response = undefined;
    this.#chunks = [];
    this.#bytes = 0;
    try { this.#child.kill(); } catch { /* already gone */ }
  }

  #request(command: string): Promise<void> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new Error('tmux control output capture is unavailable'));
    }
    if (this.#pending || this.#response) {
      return Promise.reject(new Error('tmux control command already pending'));
    }
    return new Promise<void>((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#child.stdin.write(`${command}\n`, (error) => {
        if (error) this.#fail(error);
      });
    });
  }
}
