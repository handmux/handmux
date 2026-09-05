import {
  accumulateTencent, base64ToBytes, emptyTencentTranscript, tencentTextOf,
} from '../tencentProtocol.js';
import type { VoiceClientAdapter } from '../providerRegistry.js';

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export const tencentClientAdapter: VoiceClientAdapter = {
  provider: 'tencent',
  protocol: 'tencent-asr-v2',
  parseSession(value) {
    return value.provider === 'tencent' && value.protocol === 'tencent-asr-v2'
      && typeof value.url === 'string'
      ? { provider: 'tencent', protocol: 'tencent-asr-v2', url: value.url }
      : null;
  },
  createDriver() {
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
          ...(typeof code === 'number' && code !== 0
            ? { error: String(root?.message || `Tencent ASR ${code}`) } : {}),
        };
      },
    };
  },
};
