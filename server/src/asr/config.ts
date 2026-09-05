import { providerMode, voiceProviderRegistry } from './providerRegistry.js';
import type { AsrConfig, VoiceProviderRegistry } from './providerRegistry.js';

export type {
  AsrConfig, AsrMode, TencentAsrConfig, XfyunAsrConfig,
} from './providerRegistry.js';

// HANDMUX_ASR_PROVIDER selects exactly one configured provider. Without it, keep legacy XFYUN_* installs
// working; a Tencent-only environment is also detected for direct server launches.
export function asrConfigFromRegistry(
  env: NodeJS.ProcessEnv,
  registry: VoiceProviderRegistry,
): AsrConfig | null {
  const selected = env.HANDMUX_ASR_PROVIDER;
  if (selected) {
    const adapter = registry.get(selected);
    if (!adapter) return null;
    const config = adapter.readConfig(env, providerMode(adapter, env.HANDMUX_ASR_MODE));
    return adapter.isConfigured(config) ? config : null;
  }
  for (const provider of ['xfyun', ...registry.adapters
    .map((adapter) => adapter.id).filter((id) => id !== 'xfyun')]) {
    const adapter = registry.get(provider);
    if (!adapter) continue;
    const config = adapter.readConfig(env, adapter.defaultMode);
    if (adapter.isConfigured(config)) return config;
  }
  return null;
}

export function asrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig | null {
  return asrConfigFromRegistry(env, voiceProviderRegistry);
}

export function isAsrConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return asrConfig(env) !== null;
}
