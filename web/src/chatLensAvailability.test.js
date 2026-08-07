import { describe, expect, it } from 'vitest';
import { canEnableClaudeChatLens, canUseChatLens } from './chatLensAvailability.js';
import { codexKind } from './hooks/useCodexSession.js';

describe('chat lens availability', () => {
  it('gates only Claude enablement on Claude hooks', () => {
    expect(canEnableClaudeChatLens('installed')).toBe(true);
    expect(canEnableClaudeChatLens('absent')).toBe(false);
    expect(canEnableClaudeChatLens('no-claude')).toBe(false);
    expect(canEnableClaudeChatLens(null)).toBe(true);
  });

  it('exposes every Codex pane so unmanaged sessions can show safe setup guidance', () => {
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
