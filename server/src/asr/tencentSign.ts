import { createHmac, randomInt, randomUUID } from 'node:crypto';

export interface TencentAsrSignOptions {
  appId: string;
  secretId: string;
  secretKey: string;
  engineModelType?: string;
  filterModal?: '0' | '1' | '2';
  host?: string;
  timestamp?: number;
  expired?: number;
  nonce?: number;
  voiceId?: string;
}

// Tencent Real-time ASR WebSocket 2.0. The signature covers host/path and the key-sorted raw query;
// only the resulting short-lived URL leaves the server.
export function buildTencentAsrSignedUrl({
  appId,
  secretId,
  secretKey,
  engineModelType = '16k_zh',
  filterModal = '1',
  host = 'asr.cloud.tencent.com',
  timestamp = Math.floor(Date.now() / 1000),
  expired = timestamp + 300,
  nonce = randomInt(100000, 1000000),
  voiceId = randomUUID(),
}: TencentAsrSignOptions): { url: string } {
  const params: Record<string, string> = {
    engine_model_type: engineModelType,
    expired: String(expired),
    filter_modal: filterModal,
    nonce: String(nonce),
    secretid: secretId,
    speaker_diarization: '0',
    timestamp: String(timestamp),
    voice_format: '1',
    voice_id: voiceId,
  };
  const query = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
  const signingText = `${host}/asr/v2/${appId}?${query}`;
  const signature = createHmac('sha1', secretKey).update(signingText).digest('base64');
  return { url: `wss://${signingText}&signature=${encodeURIComponent(signature)}` };
}
