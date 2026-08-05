import { describe, expect, it } from 'vitest';
import { canEnableChatLens, canUseChatLens } from './chatLensAvailability.js';
import { codexKind } from './hooks/useCodexSession.js';

describe('chat lens availability', () => {
  it('can be enabled for either Hook-backed Claude or managed Codex', () => {
    expect(canEnableChatLens('installed', false)).toBe(true);
    expect(canEnableChatLens('absent', true)).toBe(true);
    expect(canEnableChatLens('no-claude', true)).toBe(true);
    expect(canEnableChatLens('absent', false)).toBe(false);
    expect(canEnableChatLens(null, false)).toBe(true);
  });

  it('only exposes the switch on a pane with a reliable conversation source', () => {
    expect(canUseChatLens('claude', 'installed', null)).toBe(true);
    expect(canUseChatLens('claude', 'absent', null)).toBe(false);
    expect(canUseChatLens('codex', 'absent', { loaded: true, managed: true })).toBe(true);
    expect(canUseChatLens('codex', 'installed', { loaded: true, managed: false })).toBe(false);
    expect(canUseChatLens('codex', 'installed', { loaded: false, managed: true })).toBe(false);
  });

  it('keeps managed compaction distinct from a normal active turn', () => {
    expect(codexKind({ managed: true, activityKind: 'compacting', status: { type: 'active', activeFlags: [] } })).toBe('compacting');
  });
});
