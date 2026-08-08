import { describe, expect, it } from 'vitest';
import { currentPaneAgent, reconcilePaneAgents } from './paneAgents.js';

describe('pane agent identity', () => {
  const current = {
    paneId: '%1',
    panes: [{ id: '%1', agent: 'codex' }, { id: '%2', agent: null }],
  };

  it('uses the initial /panes identity before inbox state has loaded', () => {
    expect(currentPaneAgent(current, {})).toBe('codex');
    expect(currentPaneAgent(current, { '%1': { agent: 'claude' } })).toBe('codex');
  });

  it('prefers later live state and clears an agent that has exited', () => {
    const panes = reconcilePaneAgents(current.panes, {});
    expect(panes[0].agent).toBeNull();
    expect(currentPaneAgent({ ...current, panes }, {})).toBeNull();
  });

  it('keeps stable pane references when live identity has not changed', () => {
    expect(reconcilePaneAgents(current.panes, { '%1': { agent: 'codex' } })).toBe(current.panes);
  });
});
