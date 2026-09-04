import { describe, expect, it } from 'vitest';
import { asrConfig, isAsrConfigured } from '../src/asr/config.js';

describe('ASR provider config', () => {
  it('keeps a legacy XFYUN-only environment working', () => {
    expect(asrConfig({ XFYUN_APPID: 'A', XFYUN_APIKEY: 'K', XFYUN_APISECRET: 'S' })).toEqual({
      provider: 'xfyun', appId: 'A', apiKey: 'K', apiSecret: 'S',
    });
  });

  it('selects Tencent explicitly and does not fall back when its credentials are incomplete', () => {
    expect(asrConfig({
      HANDMUX_ASR_PROVIDER: 'tencent',
      TENCENT_ASR_APPID: '1', TENCENT_ASR_SECRET_ID: 'ID', TENCENT_ASR_SECRET_KEY: 'KEY',
      XFYUN_APPID: 'A', XFYUN_APIKEY: 'K', XFYUN_APISECRET: 'S',
    })).toEqual({
      provider: 'tencent', appId: '1', secretId: 'ID', secretKey: 'KEY', engineModelType: '16k_zh',
    });
    expect(isAsrConfigured({
      HANDMUX_ASR_PROVIDER: 'tencent', TENCENT_ASR_APPID: '1',
      XFYUN_APPID: 'A', XFYUN_APIKEY: 'K', XFYUN_APISECRET: 'S',
    })).toBe(false);
  });
});
