import { describe, expect, it, vi } from 'vitest';
import { AgentSessionControlService } from '../src/agent-runtime/sessionControl.js';
import type { AgentModelControlSnapshot } from '../src/agent-runtime/sessionControl.js';
import { createCodexSessionControlAdapter } from '../src/agents/codexSessionControl.js';
import { createPiSessionControlAdapter } from '../src/agents/piSessionControl.js';

function lease(implementationVersion?: number) {
  return {
    ref: {
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
      ...(implementationVersion === undefined ? {} : { implementationVersion }),
    },
    signal: new AbortController().signal,
  };
}

const snapshot: AgentModelControlSnapshot = {
  models: [{
    id: 'provider/model', label: 'Model',
    efforts: [{ id: 'off' }, { id: 'high', description: 'Deep' }],
    serviceTiers: [{ id: 'priority', label: 'Fast' }],
  }],
  selected: { model: 'provider/model', effort: 'high', serviceTier: 'priority' },
};

describe('Agent Session Control', () => {
  it('normalizes a provider snapshot and fails closed on foreign effort/tier selections', async () => {
    const readModelControl = vi.fn(async () => snapshot);
    const updateModelControl = vi.fn(async () => snapshot);
    const service = new AgentSessionControlService({
      pi: { apiVersion: 1, readModelControl, updateModelControl },
    });
    await expect(service.readModelControl(lease(3))).resolves.toEqual({ ...snapshot, canUpdate: true });
    await expect(service.updateModelControl(lease(3), { effort: 'off' }))
      .resolves.toEqual({ ...snapshot, canUpdate: true });

    readModelControl.mockResolvedValueOnce({
      ...snapshot, selected: { ...snapshot.selected, effort: 'not-supported' },
    });
    await expect(service.readModelControl(lease(3))).rejects.toMatchObject({
      code: 'contract_violation',
    });
    updateModelControl.mockResolvedValueOnce({
      ...snapshot, selected: { ...snapshot.selected, serviceTier: 'foreign' },
    });
    await expect(service.updateModelControl(lease(3), { serviceTier: null })).rejects.toMatchObject({
      code: 'contract_violation',
    });
  });

  it('publishes a read-only model snapshot without requiring an update method', async () => {
    const service = new AgentSessionControlService({
      pi: { apiVersion: 1, readModelControl: vi.fn(async () => snapshot) },
    });
    await expect(service.readModelControl(lease(3))).resolves.toEqual({
      ...snapshot, canUpdate: false,
    });
    await expect(service.updateModelControl(lease(3), { effort: 'off' }))
      .rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps Pi v2 chat-compatible by not probing the optional v3 Bridge handler', async () => {
    const request = vi.fn(async () => snapshot);
    const adapter = createPiSessionControlAdapter({
      host: { request } as unknown as Parameters<typeof createPiSessionControlAdapter>[0]['host'],
    });
    await expect(adapter.readModelControl(lease(2))).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();

    await expect(adapter.readModelControl(lease(3), { refresh: true })).resolves.toEqual(snapshot);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.objectContaining({ implementationVersion: 3 }) }),
      'session-control', 'read', { refresh: true },
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('maps Codex native model/settings APIs into the provider-neutral contract', async () => {
    const models = vi.fn(async () => [{
      id: 'catalog-id', model: 'gpt-5.6', displayName: 'GPT-5.6', description: 'Frontier',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium' }, { reasoningEffort: 'high', description: 'More reasoning' },
      ],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Low latency' }],
    }]);
    const status = vi.fn(async () => ({
      settings: { model: 'gpt-5.6', effort: 'high', serviceTier: 'priority' },
    }));
    const updateSettings = vi.fn(async () => ({}));
    const adapter = createCodexSessionControlAdapter({ models, status, updateSettings });
    const run = { ...lease(), ref: { ...lease().ref, agentId: 'codex' } };

    await expect(adapter.readModelControl(run, { refresh: true })).resolves.toEqual({
      models: [{
        id: 'gpt-5.6', label: 'GPT-5.6', description: 'Frontier',
        efforts: [{ id: 'medium', label: 'medium' }, {
          id: 'high', label: 'high', description: 'More reasoning',
        }],
        defaultEffort: 'medium',
        serviceTiers: [{ id: 'priority', label: 'Fast', description: 'Low latency' }],
      }],
      selected: { model: 'gpt-5.6', effort: 'high', serviceTier: 'priority' },
    });
    await adapter.updateModelControl!(run, { effort: 'medium' });
    expect(updateSettings).toHaveBeenCalledWith('%1', 'session-1', { effort: 'medium' });
  });
});
