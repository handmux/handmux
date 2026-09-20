import { describe, expect, it } from 'vitest';
import { parseAgentIntegrations } from './agentIntegrationApi.js';

describe('parseAgentIntegrations', () => {
  it('accepts every known Agent the Server reports, one row each', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'needs-repair' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'needs-repair' },
    ]);
    // The product grew a third Agent: a response carrying all three must parse. Requiring exactly two rows
    // (and exactly Claude + Pi) is what broke this panel the day CodeBuddy shipped.
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
      { name: 'codebuddy', status: 'needs-repair' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
      { name: 'codebuddy', status: 'needs-repair' },
    ]);
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'not-enabled', reason: 'initialize-first' },
      { name: 'pi', status: 'conflict' },
    ] })).toEqual([
      { name: 'claude', status: 'not-enabled', reason: 'initialize-first' },
      { name: 'pi', status: 'conflict' },
    ]);
    // A subset is managed as-is rather than rejected: the panel shows what the Server actually reports.
    expect(parseAgentIntegrations({ integrations: [{ name: 'claude', status: 'ready' }] }))
      .toEqual([{ name: 'claude', status: 'ready' }]);
  });

  it('ignores future Agents while keeping the known rows available', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'codex', status: 'ready' },
      { name: 'future-agent', status: 'future-state' },
      { name: 'pi', status: 'not-enabled' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
    ]);
  });

  it('fails closed for duplicates, an empty list, and unknown known-Agent states', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'pi', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
    ] })).toBeNull();
    expect(parseAgentIntegrations({ integrations: [] })).toBeNull();
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'installed' },
      { name: 'pi', status: 'ready' },
    ] })).toBeNull();
  });
});
