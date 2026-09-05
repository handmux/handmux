import { buildIatSignedUrl } from '../iflySign.js';
import {
  silentPcmProbe, verifyStreamingConnection, VoiceVerificationError,
} from '../verify.js';
import type { VoiceProviderAdapter, XfyunAsrConfig } from '../providerRegistry.js';
import type { VoiceVerificationDependencies } from '../verify.js';

const XFYUN_BUSINESS = {
  language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10_000,
  dwa: 'wpgs', ptt: 1, nunum: 1,
};
const XFYUN_FORMAT = 'audio/L16;rate=16000';

export async function verifyXfyunAsr(
  config: XfyunAsrConfig,
  dependencies: VoiceVerificationDependencies = {},
): Promise<void> {
  const session = buildIatSignedUrl({ ...config, date: new Date().toUTCString() });
  const audio = Buffer.from(silentPcmProbe().subarray(0, 1_280)).toString('base64');
  await verifyStreamingConnection({
    url: session.url,
    sendOnOpen: (socket) => {
      socket.send(JSON.stringify({
        common: { app_id: config.appId },
        business: XFYUN_BUSINESS,
        data: { status: 0, format: XFYUN_FORMAT, encoding: 'raw', audio },
      }));
      socket.send(JSON.stringify({
        data: { status: 2, format: XFYUN_FORMAT, encoding: 'raw', audio: '' },
      }));
    },
    acceptMessage: (message) => {
      let value: unknown;
      try { value = JSON.parse(message); }
      catch { throw new VoiceVerificationError('invalid_response', 'provider returned an invalid response'); }
      const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (typeof root.code !== 'number') {
        throw new VoiceVerificationError('invalid_response', 'provider returned an invalid response');
      }
      if (root.code !== 0) {
        throw new VoiceVerificationError(
          `xfyun_${root.code}`,
          `XFYUN rejected the configuration (${root.code}): ${String(root.message || 'unknown error')}`,
        );
      }
      return true;
    },
  }, dependencies);
}

export const xfyunAdapter: VoiceProviderAdapter = {
  id: 'xfyun',
  defaultMode: 'streaming',
  fields: [
    { key: 'appId', env: 'XFYUN_APPID', promptKey: 'setup.voiceAppId' },
    { key: 'apiKey', env: 'XFYUN_APIKEY', promptKey: 'setup.voiceApiKey', secret: true },
    { key: 'apiSecret', env: 'XFYUN_APISECRET', promptKey: 'setup.voiceApiSecret', secret: true },
  ],
  profiles: [
    { mode: 'streaming', labelKey: 'setup.voiceXfyun', hintKey: 'setup.voiceXfyunHint' },
  ],
  readConfig: (env) => ({
    provider: 'xfyun', mode: 'streaming',
    appId: env.XFYUN_APPID || '', apiKey: env.XFYUN_APIKEY || '', apiSecret: env.XFYUN_APISECRET || '',
  }),
  isConfigured: (config) => config.provider === 'xfyun'
    && !!(config.appId && config.apiKey && config.apiSecret),
  verify: (config) => {
    if (config.provider !== 'xfyun') throw new Error('xfyun adapter received another provider config');
    return verifyXfyunAsr(config as XfyunAsrConfig);
  },
  createStreamingSession: (config) => {
    if (config.provider !== 'xfyun') throw new Error('xfyun adapter received another provider config');
    const credentials = config as XfyunAsrConfig;
    return {
      provider: 'xfyun', protocol: 'xfyun-iat-v2',
      ...buildIatSignedUrl({ ...credentials, date: new Date().toUTCString() }),
    };
  },
};
