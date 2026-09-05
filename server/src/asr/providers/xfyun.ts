import { buildIatSignedUrl } from '../iflySign.js';
import type { VoiceProviderAdapter, XfyunAsrConfig } from '../providerRegistry.js';

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
  createStreamingSession: (config) => {
    if (config.provider !== 'xfyun') throw new Error('xfyun adapter received another provider config');
    const credentials = config as XfyunAsrConfig;
    return {
      provider: 'xfyun', protocol: 'xfyun-iat-v2',
      ...buildIatSignedUrl({ ...credentials, date: new Date().toUTCString() }),
    };
  },
};
