import { describe, expect, it } from 'vitest';
import { inboxReconnectNeeded } from '../src/agentCatalog.js';

const descriptors = [{
  id: 'codex', label: 'Codex',
  capabilities: { inbox: true, conversation: true, interaction: true, subscriptionUsage: true },
}];

describe('Inbox reconnect visibility', () => {
  it('does not turn a partial provider degradation into a global warning, including for an empty Inbox', () => {
    const degraded = {
      descriptors,
      runs: [],
      health: [{
        adapterId: 'codex', capability: 'inbox' as const, availability: 'degraded' as const,
      }],
    };
    expect(inboxReconnectNeeded(degraded)).toBe(false);
  });

  it.each(['starting', 'unavailable'] as const)(
    'keeps the warning while an Inbox source is %s',
    (availability) => {
      expect(inboxReconnectNeeded({
        descriptors,
        runs: [],
        health: [{ adapterId: 'codex', capability: 'inbox', availability }],
      })).toBe(true);
    },
  );

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
    })).toBe(false);
  });
});
