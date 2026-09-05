import { describe, expect, it, vi } from 'vitest';
import { createVoiceClientRegistry } from '../src/voice/providerRegistry.js';
import type { VoiceClientAdapter } from '../src/voice/providerRegistry.js';

describe('voice client registry', () => {
  it('parses and drives a newly registered streaming protocol without common-flow changes', () => {
    const consume = vi.fn(() => ({ text: 'example text', final: true }));
    const adapter: VoiceClientAdapter = {
      provider: 'example',
      protocol: 'example-v1',
      parseSession: (value) => value.provider === 'example' && typeof value.url === 'string'
        ? { provider: 'example', protocol: 'example-v1', url: value.url } : null,
      createDriver: () => ({ audio: (chunk) => chunk, end: () => 'end', consume }),
    };
    const registry = createVoiceClientRegistry([adapter]);
    const session = registry.parseSession({
      provider: 'example', protocol: 'example-v1', url: 'wss://example.test/asr',
    });

    expect(session).toMatchObject({ provider: 'example', protocol: 'example-v1' });
    const driver = registry.createDriver(session!);
    expect(driver.audio('audio')).toBe('audio');
    expect(driver.end()).toBe('end');
    expect(driver.consume({ result: 'raw' })).toEqual({ text: 'example text', final: true });
  });

  it('rejects duplicate protocols and provider/protocol mismatches', () => {
    const adapter: VoiceClientAdapter = {
      provider: 'example', protocol: 'same', parseSession: () => null,
      createDriver: () => ({ audio: () => '', end: () => '', consume: () => ({ text: '', final: false }) }),
    };
    expect(() => createVoiceClientRegistry([adapter, adapter])).toThrow(/duplicate voice protocol/);
    const registry = createVoiceClientRegistry([adapter]);
    expect(() => registry.createDriver({ provider: 'other', protocol: 'same', url: 'wss://x' }))
      .toThrow(/unsupported ASR protocol/);
  });
});
