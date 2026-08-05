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

  it('exposes every Codex pane so unmanaged sessions can offer takeover', () => {
    expect(canUseChatLens('claude', 'installed')).toBe(true);
    expect(canUseChatLens('claude', 'absent')).toBe(false);
    expect(canUseChatLens('codex', 'absent')).toBe(true);
    expect(canUseChatLens('codex', 'installed')).toBe(true);
  });

  it('keeps managed compaction distinct from a normal active turn', () => {
    expect(codexKind({ managed: true, activityKind: 'compacting', status: { type: 'active', activeFlags: [] } })).toBe('compacting');
  });

  it('never inherits terminal-derived state for an unmanaged Codex session', () => {
    expect(codexKind({ managed: false, status: { type: 'active', activeFlags: [] } })).toBeNull();
  });
});
