import { describe, expect, it, vi } from 'vitest';
import { parseBooleanSetting, performanceSettingsFromEnv } from '../src/performanceSettings.js';

describe('performance settings', () => {
  it('accepts booleans and the text forms flags and env vars carry', () => {
    for (const value of [true, 'true', '1']) expect(parseBooleanSetting(value, 'codebuddy')).toBe(true);
    for (const value of [false, 'false', '0']) expect(parseBooleanSetting(value, 'codebuddy')).toBe(false);
    for (const bad of ['maybe', 'yes', 1, null]) {
      expect(() => parseBooleanSetting(bad, 'codebuddy')).toThrow(/bad codebuddy/);
    }
  });

  it('reads the server env, falling back to the default with a warning on a bad value', () => {
    expect(performanceSettingsFromEnv({})).toEqual({ codebuddy: true });
    expect(performanceSettingsFromEnv({ HANDMUX_CODEBUDDY: '0' })).toEqual({ codebuddy: false });
    const warn = vi.fn();
    expect(performanceSettingsFromEnv({ HANDMUX_CODEBUDDY: 'x' }, warn)).toEqual({ codebuddy: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
