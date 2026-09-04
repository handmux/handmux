import { buildFirstFrame, buildAudioFrame, buildEndFrame, emptyTranscript, accumulate, textOf } from './iatProtocol.js';
import { accumulateTencent, base64ToBytes, emptyTencentTranscript, tencentTextOf } from './tencentProtocol.js';
import type { AsrSessionResponse } from '../apiRequest.js';

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

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function xfyunDriver(appId: string): AsrDriver {
  let first = true;
  let transcript = emptyTranscript();
  return {
    audio(base64) {
      const frame = first ? buildFirstFrame(appId, base64) : buildAudioFrame(base64);
      first = false;
      return JSON.stringify(frame);
    },
    end: () => JSON.stringify(buildEndFrame()),
    consume(message) {
      transcript = accumulate(transcript, message);
      const root = asRecord(message);
      const data = asRecord(root?.data);
      const code = root?.code;
      return {
        text: textOf(transcript),
        final: data?.status === 2,
        ...(typeof code === 'number' && code !== 0 ? { error: String(root?.message || `XFYUN ${code}`) } : {}),
      };
    },
  };
}

function tencentDriver(): AsrDriver {
  let transcript = emptyTencentTranscript();
  return {
    audio: base64ToBytes,
    end: () => JSON.stringify({ type: 'end' }),
    consume(message) {
      transcript = accumulateTencent(transcript, message);
      const root = asRecord(message);
      const code = root?.code;
      return {
        text: tencentTextOf(transcript),
        final: root?.final === 1,
        ...(typeof code === 'number' && code !== 0 ? { error: String(root?.message || `Tencent ASR ${code}`) } : {}),
      };
    },
  };
}

export function createAsrDriver(session: AsrSessionResponse): AsrDriver {
  return session.provider === 'tencent' ? tencentDriver() : xfyunDriver(session.appId);
}
