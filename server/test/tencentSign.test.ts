import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTencentAsrSignedUrl } from '../src/asr/tencentSign.js';

describe('Tencent real-time ASR v2 signing', () => {
  it('sorts the query, signs with HMAC-SHA1, and never exposes secretKey', () => {
    const result = buildTencentAsrSignedUrl({
      appId: '123456', secretId: 'AKID-example', secretKey: 'DO-NOT-LEAK',
      engineModelType: '16k_zh', timestamp: 1000, expired: 1300, nonce: 42, voiceId: 'voice-1',
    });
    const url = new URL(result.url);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('asr.cloud.tencent.com');
    expect(url.pathname).toBe('/asr/v2/123456');
    expect(url.searchParams.get('voice_format')).toBe('1');
    expect(url.searchParams.has('result_mod')).toBe(false);
    const queryWithoutSignature = result.url.slice('wss://'.length).replace(/&signature=.*$/, '');
    const expected = createHmac('sha1', 'DO-NOT-LEAK').update(queryWithoutSignature).digest('base64');
    expect(url.searchParams.get('signature')).toBe(expected);
    expect(result.url).not.toContain('DO-NOT-LEAK');
  });
});
