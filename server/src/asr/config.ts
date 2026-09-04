export type AsrProviderName = 'xfyun' | 'tencent';

export interface XfyunAsrConfig {
  provider: 'xfyun';
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export interface TencentAsrConfig {
  provider: 'tencent';
  appId: string;
  secretId: string;
  secretKey: string;
  engineModelType: string;
}

export type AsrConfig = XfyunAsrConfig | TencentAsrConfig;

const xfyunConfig = (env: NodeJS.ProcessEnv): XfyunAsrConfig => ({
  provider: 'xfyun',
  appId: env.XFYUN_APPID || '',
  apiKey: env.XFYUN_APIKEY || '',
  apiSecret: env.XFYUN_APISECRET || '',
});

const tencentConfig = (env: NodeJS.ProcessEnv): TencentAsrConfig => ({
  provider: 'tencent',
  appId: env.TENCENT_ASR_APPID || '',
  secretId: env.TENCENT_ASR_SECRET_ID || '',
  secretKey: env.TENCENT_ASR_SECRET_KEY || '',
  engineModelType: env.TENCENT_ASR_ENGINE_MODEL_TYPE || '16k_zh',
});

const complete = (config: AsrConfig): boolean => config.provider === 'xfyun'
  ? !!(config.appId && config.apiKey && config.apiSecret)
  : !!(config.appId && config.secretId && config.secretKey && config.engineModelType);

// HANDMUX_ASR_PROVIDER selects exactly one configured provider. Without it, keep legacy XFYUN_* installs
// working; a Tencent-only environment is also detected for direct server launches.
export function asrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig | null {
  const selected = env.HANDMUX_ASR_PROVIDER;
  if (selected === 'xfyun' || selected === 'tencent') {
    const config = selected === 'xfyun' ? xfyunConfig(env) : tencentConfig(env);
    return complete(config) ? config : null;
  }
  const legacy = xfyunConfig(env);
  if (complete(legacy)) return legacy;
  const tencent = tencentConfig(env);
  return complete(tencent) ? tencent : null;
}

export function isAsrConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return asrConfig(env) !== null;
}
