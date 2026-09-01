import { describe, expect, it } from 'vitest';
import {
  clearPaneConversationIdentities,
  currentPaneAgent,
  hasCanonicalCurrentPaneAgent,
  navigationAgentMaps,
} from './paneAgents.js';

describe('pane agent identity', () => {
  const current = {
    paneId: '%1',
    panes: [{ id: '%1', agent: 'codex' }, { id: '%2', agent: null }],
  };

  it('uses the initial /panes identity before inbox state has loaded', () => {
    expect(currentPaneAgent(current, {})).toBe('codex');
    expect(currentPaneAgent(current, { '%1': { agent: 'claude' } })).toBe('codex');
  });

  it('keeps canonical /panes null authoritative over a stale Inbox state', () => {
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1', agent: null }] }, {
      '%1': { agent: 'claude' },
    })).toBeNull();
  });

  it('uses /states identity only for an older /panes response that omitted the field', () => {
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1' }] }, {
      '%1': { agent: 'claude' },
    })).toBe('claude');
    expect(hasCanonicalCurrentPaneAgent({ ...current, panes: [{ id: '%1' }] })).toBe(false);
  });

  it('distinguishes an authoritative Agent exit from a temporarily unknown pane', () => {
    expect(hasCanonicalCurrentPaneAgent({ ...current, panes: [{ id: '%1', agent: null }] })).toBe(true);
    expect(hasCanonicalCurrentPaneAgent({ ...current, panes: [] })).toBe(false);
  });

  it('pins Codex identity throughout a controlled takeover, even over stale detection', () => {
    const pinned = new Set(['%1']);
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1', agent: null }] }, {}, pinned)).toBe('codex');
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1', agent: 'claude' }] }, {}, pinned)).toBe('codex');
  });

  it('forgets every cached conversation when canonical identity says the pane exited', () => {
    const identities = new Map([
      ['%1\0claude', 'claude-session'],
      ['%1\0codex', 'codex-session'],
      ['%10\0codex', 'other-pane-session'],
    ]);
    clearPaneConversationIdentities(identities, '%1');
    expect([...identities]).toEqual([['%10\0codex', 'other-pane-session']]);
  });

});

describe('navigation Agent logos', () => {
  it('lets canonical current-window panes clear stale /states logos', () => {
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      panes: [{ id: '%1', agent: null }, { id: '%2', agent: 'codex' }],
    }, {
      '%1': { window: '@1', agent: 'claude' },
      '%2': { window: '@1', agent: 'claude' },
      '%3': { window: '@2', agent: 'claude' },
    });
    expect(maps.paneAgents).toEqual({ '%1': null, '%2': 'codex', '%3': 'claude' });
    expect(maps.windowAgents).toEqual({ '@1': 'codex', '@2': 'claude' });
  });

  it('keeps old /panes responses compatible when they omit Agent identity', () => {
    const maps = navigationAgentMaps({ window: { id: '@1' }, panes: [{ id: '%1' }] }, {
      '%1': { window: '@1', agent: 'claude' },
    });
    expect(maps.paneAgents['%1']).toBe('claude');
    expect(maps.windowAgents['@1']).toBe('claude');
  });
});
