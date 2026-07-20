import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('server config', () => {
  it('reads normalized shortcuts passed by the supervisor', () => {
    const shortcuts = { command: [], chat: [{ type: 'text', text: 'ok', enter: true }] };
    expect(loadConfig({ HANDMUX_SHORTCUTS: JSON.stringify(shortcuts) }).shortcuts).toEqual(shortcuts);
  });
});
