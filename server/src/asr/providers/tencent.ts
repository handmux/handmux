import { recognizeTencentSentence, TencentSentenceError } from '../tencentSentence.js';
import { buildTencentAsrSignedUrl } from '../tencentSign.js';
import type {
  FillerFilterLevel, TencentAsrConfig, VoiceProviderAdapter,
} from '../providerRegistry.js';

const FILTER_MODAL: Record<FillerFilterLevel, '0' | '1' | '2'> = {
  low: '0', medium: '1', high: '2',
};

export const tencentAdapter: VoiceProviderAdapter = {
  id: 'tencent',
  defaultMode: 'streaming',
  fields: [
    { key: 'appId', env: 'TENCENT_ASR_APPID', promptKey: 'setup.voiceTencentAppId' },
    { key: 'secretId', env: 'TENCENT_ASR_SECRET_ID', promptKey: 'setup.voiceTencentSecretId', secret: true },
    { key: 'secretKey', env: 'TENCENT_ASR_SECRET_KEY', promptKey: 'setup.voiceTencentSecretKey', secret: true },
    {
      key: 'engineModelType', env: 'TENCENT_ASR_ENGINE_MODEL_TYPE',
      promptKey: 'setup.voiceTencentEngine', defaultValue: '16k_zh',
    },
  ],
  profiles: [
    { mode: 'streaming', labelKey: 'setup.voiceTencent', hintKey: 'setup.voiceTencentHint' },
    {
      mode: 'sentence', labelKey: 'setup.voiceTencentSentence',
      hintKey: 'setup.voiceTencentSentenceHint',
    },
  ],
  capabilities: { fillerFilter: true },
  readConfig: (env, mode) => ({
    provider: 'tencent', mode,
    appId: env.TENCENT_ASR_APPID || '',
    secretId: env.TENCENT_ASR_SECRET_ID || '',
    secretKey: env.TENCENT_ASR_SECRET_KEY || '',
    engineModelType: env.TENCENT_ASR_ENGINE_MODEL_TYPE || '16k_zh',
  }),
  isConfigured: (config) => config.provider === 'tencent'
    && !!(config.appId && config.secretId && config.secretKey && config.engineModelType),
  createStreamingSession: (config, options) => {
    if (config.provider !== 'tencent') throw new Error('tencent adapter received another provider config');
    return {
      provider: 'tencent', protocol: 'tencent-asr-v2',
      ...buildTencentAsrSignedUrl({
        ...config as TencentAsrConfig,
        filterModal: FILTER_MODAL[options.fillerFilter],
      }),
    };
  },
  recognizeSentence: (config, audio, options) => {
    if (config.provider !== 'tencent') throw new Error('tencent adapter received another provider config');
    return recognizeTencentSentence(config as TencentAsrConfig, audio, {
      filterModal: Number(FILTER_MODAL[options.fillerFilter]) as 0 | 1 | 2,
    });
  },
  publicError: (error) => error instanceof TencentSentenceError ? {
    message: error.message,
    code: error.code,
    ...(error.requestId ? { providerRequestId: error.requestId } : {}),
  } : null,
};
