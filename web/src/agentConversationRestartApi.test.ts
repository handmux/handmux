import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';

vi.mock('./apiRequest.js', () => ({ requestJson: vi.fn() }));

const sessionId = '12345678-1234-1234-1234-123456789abc';
const receipt = {
  operationId: 'a'.repeat(64),
  recovery: { kind: 'codex_resume' as const, sessionId,
    command: `handmux codex resume ${sessionId}` },
  phase: 'stopped' as const,
  state: 'current' as const,
  canResume: true,
};
const run: AgentRunRef = { agentId: 'codex', paneId: '%8', runId: 'run-8', sessionId };

afterEach(() => vi.clearAllMocks());

describe('conversation restart API', () => {
  it('posts the confirmed run and parses the server receipt', async () => {
    const api = await import('./agentConversationRestartApi.js').catch(() => null);
    expect(api).not.toBeNull();
    if (!api) return;
    vi.mocked(requestJson).mockResolvedValue({ receipt });

    await expect(api.restartConversation(run)).resolves.toEqual(receipt);
    expect(requestJson).toHaveBeenCalledWith('/api/agents/conversation-restart', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ run }),
    }));
  });

  it('uses only the selected pane for durable recovery lookup', async () => {
    const api = await import('./agentConversationRestartApi.js').catch(() => null);
    expect(api).not.toBeNull();
    if (!api) return;
    vi.mocked(requestJson).mockResolvedValue({ receipt });

    await expect(api.getConversationRestartRecovery('%8')).resolves.toEqual(receipt);
    expect(requestJson).toHaveBeenCalledWith('/api/agents/conversation-restart-recovery?paneId=%258',
      expect.objectContaining({ timeoutMs: 8_000 }));
  });
});
