import { describe, expect, it, vi } from 'vitest';
import {
  buildTencentSentenceRequest,
  recognizeTencentSentence,
  TencentSentenceError,
} from '../src/asr/tencentSentence.js';
import type { TencentAsrConfig } from '../src/asr/config.js';

const config: TencentAsrConfig = {
  provider: 'tencent', mode: 'sentence', appId: '123456',
  secretId: 'AKID-example', secretKey: 'DO-NOT-LEAK', engineModelType: '16k_zh',
};

describe('Tencent sentence ASR', () => {
  it('builds a deterministic TC3 request with base64 PCM and no exposed SecretKey', () => {
    const request = buildTencentSentenceRequest(config, Uint8Array.from([0, 1, 2, 255]), 1_700_000_000);
    expect(request.url).toBe('https://asr.tencentcloudapi.com');
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      Host: 'asr.tencentcloudapi.com',
      'X-TC-Action': 'SentenceRecognition',
      'X-TC-Timestamp': '1700000000',
      'X-TC-Version': '2019-06-14',
    });
    expect(request.headers.Authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKID-example/2023-11-14/asr/tc3_request, '
      + 'SignedHeaders=content-type;host, '
      + 'Signature=f030fb93337537e1362f363cd5e6cc4ffb5006955f4b1bbc37426a2c76da0a89',
    );
    expect(JSON.parse(request.body)).toEqual({
      ProjectId: 0, SubServiceType: 2, EngSerViceType: '16k_zh', SourceType: 1,
      VoiceFormat: 'pcm', Data: 'AAEC/w==', DataLen: 4,
    });
    expect(JSON.stringify(request)).not.toContain('DO-NOT-LEAK');
  });

  it('returns Result and preserves Tencent request IDs only on the server', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      Response: { Result: '你好', RequestId: 'req-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(recognizeTencentSentence(config, Uint8Array.of(1, 2), {
      fetch: fetchMock as typeof fetch, timestamp: 1_700_000_000,
    })).resolves.toEqual({ text: '你好', requestId: 'req-1' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces the Tencent error code and request ID without leaking credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ Response: {
      Error: { Code: 'InvalidParameterValue', Message: 'bad audio' }, RequestId: 'req-2',
    } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    let caught: unknown;
    try {
      await recognizeTencentSentence(config, Uint8Array.of(1), { fetch: fetchMock as typeof fetch });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TencentSentenceError);
    expect(caught).toMatchObject({ code: 'InvalidParameterValue', requestId: 'req-2', message: 'bad audio' });
    expect(String(caught)).not.toContain(config.secretKey);
  });
});
