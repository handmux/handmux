import { tencentClientAdapter } from './providers/tencent.js';
import { xfyunClientAdapter } from './providers/xfyun.js';

export type VoiceSocketData = string | ArrayBuffer | ArrayBufferView;

export interface DriverMessage {
  text: string;
  final: boolean;
  error?: string;
}

export interface AsrDriver {
  audio(base64: string): VoiceSocketData;
  end(): string;
  consume(message: unknown): DriverMessage;
}

export interface AsrSessionResponse {
  provider: string;
  protocol: string;
  url: string;
  [key: string]: unknown;
}

export interface VoiceClientAdapter {
  provider: string;
  protocol: string;
  parseSession(value: Record<string, unknown>): AsrSessionResponse | null;
  createDriver(session: AsrSessionResponse): AsrDriver;
}

export interface VoiceClientRegistry {
  readonly adapters: readonly VoiceClientAdapter[];
  parseSession(value: unknown): AsrSessionResponse | null;
  createDriver(session: AsrSessionResponse): AsrDriver;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export function createVoiceClientRegistry(
  adapters: readonly VoiceClientAdapter[],
): VoiceClientRegistry {
  const byProtocol = new Map<string, VoiceClientAdapter>();
  for (const adapter of adapters) {
    if (!adapter.protocol || byProtocol.has(adapter.protocol)) {
      throw new Error(`duplicate voice protocol: ${adapter.protocol}`);
    }
    byProtocol.set(adapter.protocol, adapter);
  }
  return {
    adapters: [...adapters],
    parseSession(value) {
      const record = asRecord(value);
      if (!record || typeof record.protocol !== 'string') return null;
      return byProtocol.get(record.protocol)?.parseSession(record) ?? null;
    },
    createDriver(session) {
      const adapter = byProtocol.get(session.protocol);
      if (!adapter || session.provider !== adapter.provider) {
        throw new Error(`unsupported ASR protocol: ${session.protocol}`);
      }
      return adapter.createDriver(session);
    },
  };
}

export const voiceClientRegistry = createVoiceClientRegistry([
  xfyunClientAdapter, tencentClientAdapter,
]);
export const parseAsrSession = (value: unknown): AsrSessionResponse | null => (
  voiceClientRegistry.parseSession(value)
);
export const createAsrDriver = (session: AsrSessionResponse): AsrDriver => (
  voiceClientRegistry.createDriver(session)
);
