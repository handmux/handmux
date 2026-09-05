import { tencentAdapter } from './providers/tencent.js';
import { xfyunAdapter } from './providers/xfyun.js';

export type AsrMode = 'streaming' | 'sentence';
export type FillerFilterLevel = 'low' | 'medium' | 'high';

export interface AsrConfig {
  provider: string;
  mode: AsrMode;
  [key: string]: unknown;
}

export interface XfyunAsrConfig extends AsrConfig {
  provider: 'xfyun';
  mode: 'streaming';
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export interface TencentAsrConfig extends AsrConfig {
  provider: 'tencent';
  mode: AsrMode;
  appId: string;
  secretId: string;
  secretKey: string;
  engineModelType: string;
}

export interface VoiceConfigField {
  key: string;
  env: string;
  promptKey: string;
  secret?: boolean;
  defaultValue?: string;
}

export interface VoiceProviderCapabilities {
  fillerFilter?: boolean;
}

export interface VoiceRecognitionOptions {
  fillerFilter: FillerFilterLevel;
}

export interface VoiceProviderProfile {
  mode: AsrMode;
  labelKey: string;
  hintKey: string;
}

export interface StreamingAsrSession {
  provider: string;
  protocol: string;
  url: string;
  [key: string]: unknown;
}

export interface SentenceAsrResult {
  text: string;
  requestId?: string;
}

export interface PublicAsrError {
  message: string;
  code: string;
  providerRequestId?: string;
}

export interface VoiceProviderAdapter {
  id: string;
  defaultMode: AsrMode;
  fields: readonly VoiceConfigField[];
  profiles: readonly VoiceProviderProfile[];
  capabilities?: VoiceProviderCapabilities;
  readConfig(env: NodeJS.ProcessEnv, mode: AsrMode): AsrConfig;
  isConfigured(config: AsrConfig): boolean;
  createStreamingSession?(config: AsrConfig, options: VoiceRecognitionOptions): StreamingAsrSession;
  recognizeSentence?(
    config: AsrConfig,
    audio: Uint8Array,
    options: VoiceRecognitionOptions,
  ): Promise<SentenceAsrResult>;
  publicError?(error: unknown): PublicAsrError | null;
}

export interface VoiceProviderRegistry {
  readonly adapters: readonly VoiceProviderAdapter[];
  get(id: unknown): VoiceProviderAdapter | undefined;
}

export function createVoiceProviderRegistry(
  adapters: readonly VoiceProviderAdapter[],
): VoiceProviderRegistry {
  const byId = new Map<string, VoiceProviderAdapter>();
  for (const adapter of adapters) {
    if (!adapter.id || byId.has(adapter.id)) throw new Error(`duplicate voice provider: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  return {
    adapters: [...adapters],
    get: (id) => typeof id === 'string' ? byId.get(id) : undefined,
  };
}

export const voiceProviderRegistry = createVoiceProviderRegistry([tencentAdapter, xfyunAdapter]);

export function providerMode(adapter: VoiceProviderAdapter, value: unknown): AsrMode {
  return adapter.profiles.some((profile) => profile.mode === value)
    ? value as AsrMode : adapter.defaultMode;
}
