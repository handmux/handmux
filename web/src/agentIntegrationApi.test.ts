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
    // Codex is reported like the rest and shown read-only: PATH decides 已接入 / 未安装.
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'ready' },
      { name: 'codebuddy', status: 'not-enabled' },
      { name: 'codex', status: 'ready' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'pi', status: 'ready' },
      { name: 'codebuddy', status: 'not-enabled' },
      { name: 'codex', status: 'ready' },
    ]);
    // A subset is managed as-is rather than rejected: the panel shows what the Server actually reports.
    expect(parseAgentIntegrations({ integrations: [{ name: 'claude', status: 'ready' }] }))
      .toEqual([{ name: 'claude', status: 'ready' }]);
  });

  it('ignores Agents it does not know while keeping every known row', () => {
    expect(parseAgentIntegrations({ integrations: [
      { name: 'claude', status: 'ready' },
      { name: 'codex', status: 'ready' },
      { name: 'future-agent', status: 'future-state' },
      { name: 'pi', status: 'not-enabled' },
    ] })).toEqual([
      { name: 'claude', status: 'ready' },
      { name: 'codex', status: 'ready' },
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
