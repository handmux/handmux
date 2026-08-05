import { describe, expect, it } from 'vitest';
import { codexKind } from '../src/hooks/useCodexSession.js';

describe('codexKind', () => {
  it('uses authoritative App Server wait states', () => {
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: [] } })).toBe('working');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })).toBe('permission');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })).toBe('permission');
  });

  it('does not inherit terminal-derived state for unmanaged sessions', () => {
    expect(codexKind({ managed: false })).toBeNull();
  });
});
