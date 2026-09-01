import { describe, expect, it } from 'vitest';
import { inboxReconnectNeeded } from '../src/agentCatalog.js';

const descriptors = [{
  id: 'codex', label: 'Codex',
  capabilities: { inbox: true, conversation: true, interaction: true, subscriptionUsage: true },
}];

describe('Inbox reconnect visibility', () => {
  it('does not turn a partial provider degradation into a global warning when rows remain usable', () => {
    const degraded = {
      descriptors,
      runs: [],
      health: [{
        adapterId: 'codex', capability: 'inbox' as const, availability: 'degraded' as const,
      }],
    };
    expect(inboxReconnectNeeded(degraded, true)).toBe(false);
    expect(inboxReconnectNeeded(degraded, false)).toBe(true);
  });

  it('keeps the warning for a fully unavailable Inbox even when stale rows remain rendered', () => {
    expect(inboxReconnectNeeded({
      descriptors,
      runs: [],
      health: [{
        adapterId: 'codex', capability: 'inbox', availability: 'unavailable',
      }],
    }, true)).toBe(true);
  });

  it('ignores unrelated capability health and adapters without Inbox support', () => {
    expect(inboxReconnectNeeded({
      descriptors: [{
        id: 'codex', label: 'Codex',
        capabilities: { inbox: false, conversation: true, interaction: true, subscriptionUsage: true },
      }],
      runs: [],
      health: [
        { adapterId: 'codex', capability: 'conversation', availability: 'unavailable' },
        { adapterId: 'codex', capability: 'inbox', availability: 'unavailable' },
      ],
    }, false)).toBe(false);
  });
});
