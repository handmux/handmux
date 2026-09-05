import WebSocket from 'ws';

export interface VoiceProbeSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'unexpected-response',
    listener: (request: unknown, response: { statusCode?: number }) => void,
  ): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  send(data: string | Uint8Array): void;
  terminate(): void;
}

export interface VoiceVerificationDependencies {
  socketFactory?: (url: string) => VoiceProbeSocket;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class VoiceVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceVerificationError';
    this.code = code;
  }
}

const socketMessage = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) return Buffer.concat(data).toString('utf8');
  return String(data);
};

export interface StreamingVerification {
  url: string;
  successOnOpen?: boolean;
  sendOnOpen?: (socket: VoiceProbeSocket) => void;
  acceptMessage?: (message: string) => boolean;
}

// Opens the provider's real signed endpoint with a short, hard timeout. Provider adapters own the frames
// and response semantics; this helper owns only the shared socket lifecycle and never includes the signed URL
// in an error, so credentials and signed query material cannot leak into setup output.
export function verifyStreamingConnection(
  verification: StreamingVerification,
  { socketFactory = (url) => new WebSocket(url) as unknown as VoiceProbeSocket, timeoutMs = 8_000 }:
  VoiceVerificationDependencies = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: VoiceProbeSocket | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.terminate(); } catch { /* already closed */ }
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new VoiceVerificationError(
      'verification_timeout', 'provider verification timed out',
    )), timeoutMs);
    try { socket = socketFactory(verification.url); }
    catch {
      finish(new VoiceVerificationError('connection_failed', 'could not open provider connection'));
      return;
    }
    socket.on('open', () => {
      try {
        verification.sendOnOpen?.(socket);
        if (verification.successOnOpen) finish();
      } catch {
        finish(new VoiceVerificationError('probe_failed', 'could not send provider verification data'));
      }
    });
    socket.on('message', (data) => {
      try {
        if (verification.acceptMessage?.(socketMessage(data))) finish();
      } catch (error) {
        finish(error instanceof Error ? error
          : new VoiceVerificationError('provider_rejected', 'provider rejected the configuration'));
      }
    });
    socket.on('unexpected-response', (_request, response) => finish(new VoiceVerificationError(
      'handshake_rejected',
      `provider rejected the WebSocket handshake${response.statusCode ? ` (HTTP ${response.statusCode})` : ''}`,
    )));
    socket.on('error', () => finish(new VoiceVerificationError(
      'connection_failed', 'could not connect to the provider',
    )));
    socket.on('close', (code) => finish(new VoiceVerificationError(
      'connection_closed', `provider closed the verification connection (code ${code})`,
    )));
  });
}

// One second of 16 kHz mono signed 16-bit PCM. It contains no user audio and forms a valid request body
// while keeping validation cost and transfer size minimal.
export const silentPcmProbe = (): Uint8Array => new Uint8Array(16_000 * 2);
