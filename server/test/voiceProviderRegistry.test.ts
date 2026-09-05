import { describe, expect, it } from 'vitest';
import { asrConfigFromRegistry } from '../src/asr/config.js';
import {
  createVoiceProviderRegistry, providerMode,
} from '../src/asr/providerRegistry.js';
import type { VoiceProviderAdapter } from '../src/asr/providerRegistry.js';

describe('voice provider registry', () => {
  it('runs a newly registered provider through common config and capability flow', async () => {
    const adapter: VoiceProviderAdapter = {
      id: 'example',
      defaultMode: 'streaming',
      fields: [{ key: 'token', env: 'EXAMPLE_TOKEN', promptKey: 'example.token', secret: true }],
      profiles: [
        { mode: 'streaming', labelKey: 'example.streaming', hintKey: 'example.streaming.hint' },
        { mode: 'sentence', labelKey: 'example.sentence', hintKey: 'example.sentence.hint' },
      ],
      readConfig: (env, mode) => ({ provider: 'example', mode, token: env.EXAMPLE_TOKEN || '' }),
      isConfigured: (config) => !!config.token,
      createStreamingSession: (config) => ({
        provider: config.provider, protocol: 'example-v1', url: 'wss://example.test/asr',
      }),
      recognizeSentence: async () => ({ text: 'example text' }),
    };
    const registry = createVoiceProviderRegistry([adapter]);
    const config = asrConfigFromRegistry({
      HANDMUX_ASR_PROVIDER: 'example', HANDMUX_ASR_MODE: 'sentence', EXAMPLE_TOKEN: 'secret',
    }, registry);

    expect(config).toEqual({ provider: 'example', mode: 'sentence', token: 'secret' });
    expect(providerMode(adapter, 'unsupported')).toBe('streaming');
    expect(registry.get('example')?.createStreamingSession?.(config!)).toMatchObject({
      provider: 'example', protocol: 'example-v1',
    });
    await expect(registry.get('example')?.recognizeSentence?.(config!, Uint8Array.of(1)))
      .resolves.toEqual({ text: 'example text' });
  });

  it('rejects duplicate provider ids', () => {
    const empty = {
      id: 'same', defaultMode: 'streaming' as const, fields: [], profiles: [],
      readConfig: () => ({ provider: 'same', mode: 'streaming' as const }),
      isConfigured: () => true,
    };
    expect(() => createVoiceProviderRegistry([empty, empty])).toThrow(/duplicate voice provider/);
  });
});
