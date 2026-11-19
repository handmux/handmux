import { describe, expect, it, vi } from 'vitest';
import {
  parseBooleanSetting,
  parsePaneCacheMs,
  performanceSettingsFromEnv,
} from '../src/performanceSettings.js';

describe('performance settings', () => {
  it('accepts booleans and the text forms flags and env vars carry', () => {
    for (const value of [true, 'true', '1']) expect(parseBooleanSetting(value, 'codebuddy')).toBe(true);
    for (const value of [false, 'false', '0']) expect(parseBooleanSetting(value, 'codebuddy')).toBe(false);
    for (const bad of ['maybe', 'yes', 1, null]) {
      expect(() => parseBooleanSetting(bad, 'codebuddy')).toThrow(/bad codebuddy/);
    }
  });

  it('bounds the pane cache age to whole milliseconds from 0 to 5000', () => {
    expect(parsePaneCacheMs(0)).toBe(0);
    expect(parsePaneCacheMs('2500')).toBe(2500);
    expect(parsePaneCacheMs(5000)).toBe(5000);
    for (const bad of [-1, 5001, 1.5, '', 'fast', null, true]) {
      expect(() => parsePaneCacheMs(bad)).toThrow(/bad pane-cache-ms/);
    }
  });

  it('reads the server env, falling back to the defaults with a warning on a bad value', () => {
    expect(performanceSettingsFromEnv({})).toEqual({ codebuddy: true, paneCacheMs: 0 });
    expect(performanceSettingsFromEnv({ HANDMUX_CODEBUDDY: '0', HANDMUX_PANE_CACHE_MS: '250' }))
      .toEqual({ codebuddy: false, paneCacheMs: 250 });
    const warn = vi.fn();
    expect(performanceSettingsFromEnv({ HANDMUX_CODEBUDDY: 'x', HANDMUX_PANE_CACHE_MS: '99999' }, warn))
      .toEqual({ codebuddy: true, paneCacheMs: 0 });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
