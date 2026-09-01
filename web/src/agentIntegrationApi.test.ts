import { describe, expect, it } from 'vitest';
import { parseAgentIntegrations } from './agentIntegrationApi.js';

describe('parseAgentIntegrations', () => {
  it('accepts exactly one Claude Code and Pi status across the public state set', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'needs-repair' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'needs-repair' },
    ]);
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'not-enabled', reason: 'initialize-first' },
      { name: 'pi', status: 'conflict' },
    ] })).toEqual([
      { name: 'claude', status: 'not-enabled', reason: 'initialize-first' },
      { name: 'pi', status: 'conflict' },
    ]);
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

  it('fails closed for duplicates, missing known Agents, and unknown known-Agent states', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'pi', status: 'ready' },
      { name: 'pi', status: 'not-enabled' },
    ] })).toBeNull();
    expect(parseAgentIntegrations({ integrations: [{ name: 'claude', status: 'ready' }] })).toBeNull();
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'installed' },
      { name: 'pi', status: 'ready' },
    ] })).toBeNull();
  });
});
