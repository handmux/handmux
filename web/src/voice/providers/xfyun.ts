import {
  buildFirstFrame, buildAudioFrame, buildEndFrame, emptyTranscript, accumulate, textOf,
} from '../iatProtocol.js';
import type { VoiceClientAdapter } from '../providerRegistry.js';

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export const xfyunClientAdapter: VoiceClientAdapter = {
  provider: 'xfyun',
  protocol: 'xfyun-iat-v2',
  parseSession(value) {
    return value.provider === 'xfyun' && value.protocol === 'xfyun-iat-v2'
      && typeof value.url === 'string' && typeof value.appId === 'string'
      ? { provider: 'xfyun', protocol: 'xfyun-iat-v2', url: value.url, appId: value.appId }
      : null;
  },
  createDriver(session) {
    if (typeof session.appId !== 'string') throw new Error('XFYUN ASR session is missing appId');
    const appId = session.appId;
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
          ...(typeof code === 'number' && code !== 0
            ? { error: String(root?.message || `XFYUN ${code}`) } : {}),
        };
      },
    };
  },
};
