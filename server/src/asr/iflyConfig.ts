// server/src/asr/iflyConfig.js
// Read iFlytek IAT credentials lazily from env (default process.env) so it's injectable in tests.
// app_id is a public identifier (safe to hand the browser); apiKey/apiSecret never leave the server.
export interface AsrConfig {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export function asrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig {
  return { appId: env.XFYUN_APPID || '', apiKey: env.XFYUN_APIKEY || '', apiSecret: env.XFYUN_APISECRET || '' };
}
export function isAsrConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const c = asrConfig(env);
  return !!(c.appId && c.apiKey && c.apiSecret);
}
