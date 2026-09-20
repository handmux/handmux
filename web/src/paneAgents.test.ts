import { describe, expect, it } from 'vitest';
import {
  clearPaneConversationIdentities,
  currentPaneAgent,
  hasCanonicalCurrentPaneAgent,
  mergePaneAgents,
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

  it('pins the activation provider throughout a controlled takeover, even over stale detection', () => {
    const pin = { paneId: '%1', agentId: 'future-agent' };
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1', agent: null }] }, {}, pin))
      .toBe('future-agent');
    expect(currentPaneAgent({ ...current, panes: [{ id: '%1', agent: 'claude' }] }, {}, pin))
      .toBe('future-agent');
    expect(currentPaneAgent({ ...current, paneId: '%2' }, {}, pin)).toBeNull();
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

describe('navigation Agent logos', () => {  it('lets canonical current-window panes clear stale /states logos', () => {
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

  it('marks an unselected multi-pane window with its ACTIVE pane, not the last one listed', () => {
    // Selecting @2 lands on %5. Listing %4 last must not decide the closed tab's logo — that is what made
    // the badge change the moment the window was selected.
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@1', activePaneId: '%1' }, { id: '@2', activePaneId: '%5' }],
      panes: [{ id: '%1', agent: 'claude' }],
    }, {
      '%1': { window: '@1', agent: 'claude' },
      '%5': { window: '@2', agent: 'codebuddy' },
      '%4': { window: '@2', agent: 'claude' },
    });
    expect(maps.windowAgents['@2']).toBe('codebuddy');
  });

  it('keeps a window\'s Agent when its active pane is a shell this client knows nothing about', () => {
    // A window can run Claude in one pane and sit on a shell in another. The shell pane has no Agent, but it
    // is not evidence that the window has none either — writing `null` there left a window full of Claude
    // with no logo at all, while its pane map drew one.
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@1', activePaneId: '%1' }, { id: '@2', activePaneId: '%5' }],
      panes: [{ id: '%1', agent: 'claude' }],
    }, {
      '%1': { window: '@1', agent: 'claude' },
      '%4': { window: '@2', agent: 'claude' },
    });
    expect(maps.windowAgents['@2']).toBe('claude');
  });

  it('prefers the active pane of a window that runs more than one Agent', () => {
    // Both panes have an Agent, so the pane the window opens on decides.
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@1', activePaneId: '%1' }, { id: '@2', activePaneId: '%5' }],
      panes: [{ id: '%1', agent: 'claude' }],
    }, {
      '%1': { window: '@1', agent: 'claude' },
      '%5': { window: '@2', agent: 'codebuddy' },
      '%4': { window: '@2', agent: 'claude' },
    });
    expect(maps.windowAgents['@2']).toBe('codebuddy');
  });

  it('falls back to the Agent the window does run when its own active pane has none', () => {
    // The open window: its active pane (%2) is a shell with an explicit "no Agent", so the window's own list
    // decides — and that list has Claude in %1.
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@1', activePaneId: '%2' }],
      panes: [{ id: '%1', agent: 'claude' }, { id: '%2', agent: null }],
    }, {});
    expect(maps.windowAgents['@1']).toBe('claude');
  });

  it('leaves a window alone when its active pane is not known', () => {
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@2' }],
      panes: [{ id: '%1', agent: 'claude' }],
    }, { '%4': { window: '@2', agent: 'claude' } });
    expect(maps.windowAgents['@2']).toBe('claude');
  });

  it("the selected window's badge is its active pane's Agent too", () => {
    // The same rule as any other window: the client's own current pane must not decide the badge, or it
    // changes the moment the window is selected. Here the active pane (%1) is claude while the pane listed
    // last (%2) is codex.
    const maps = navigationAgentMaps({
      window: { id: '@1' },
      windows: [{ id: '@1', activePaneId: '%1' }],
      panes: [{ id: '%1', agent: 'claude' }, { id: '%2', agent: 'codex' }],
    }, {
      '%1': { window: '@1', agent: 'codex' },
      '%2': { window: '@1', agent: 'codex' },
    });
    expect(maps.windowAgents['@1']).toBe('claude');
  });
});

describe('merging a fresh /panes response', () => {
  it('keeps the last confirmed Agent when the server omits the field for a pane', () => {
    // The server omits `agent` when its probe was inconclusive. Losing the value there is what made the
    // selected pane's badge blank and then flip to the compatibility roster.
    const merged = mergePaneAgents(
      [{ id: '%1', agent: 'codebuddy' }, { id: '%2', agent: 'claude' }],
      [{ id: '%1' }, { id: '%2', agent: 'claude' }],
    );
    expect(merged[0]).toEqual({ id: '%1', agent: 'codebuddy' });
    expect(merged[1]).toEqual({ id: '%2', agent: 'claude' });
  });

  it('takes an explicit null as the server saying the Agent is gone', () => {
    expect(mergePaneAgents([{ id: '%1', agent: 'claude' }], [{ id: '%1', agent: null }]))
      .toEqual([{ id: '%1', agent: null }]);
  });

  it('leaves a pane it has never seen alone, and does not invent one', () => {
    expect(mergePaneAgents([], [{ id: '%1' }])).toEqual([{ id: '%1' }]);
    expect(mergePaneAgents(undefined, [{ id: '%1', agent: 'pi' }])).toEqual([{ id: '%1', agent: 'pi' }]);
  });
});
