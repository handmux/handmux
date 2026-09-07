import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from './apiRequest.js';
import {
  getConversationActivationRecovery,
  recoverConversationActivation,
} from './agentConversationActivationApi.js';

vi.mock('./apiRequest.js', () => ({ requestJson: vi.fn() }));

const recovery = {
  kind: 'codex_resume' as const,
  sessionId: '12345678-1234-1234-1234-123456789abc',
  command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
};

afterEach(() => vi.clearAllMocks());

describe('Conversation activation recovery API', () => {
  it('accepts null, current, and stale recovery receipts', async () => {
    vi.mocked(requestJson)
      .mockResolvedValueOnce({ receipt: null })
      .mockResolvedValueOnce({ receipt: {
        operationId: 'a'.repeat(64), recovery, phase: 'interrupted',
        state: 'current', canResume: true,
      } })
      .mockResolvedValueOnce({ receipt: {
        operationId: 'b'.repeat(64), recovery, phase: 'prepared',
        state: 'stale', canResume: false,
      } });
    await expect(getConversationActivationRecovery('%1')).resolves.toBeNull();
    await expect(getConversationActivationRecovery('%1')).resolves.toMatchObject({
      state: 'current', canResume: true,
    });
    await expect(getConversationActivationRecovery('%1')).resolves.toMatchObject({
      state: 'stale', canResume: false,
    });
  });

  it('rejects malformed or unsafe receipts', async () => {
    vi.mocked(requestJson).mockResolvedValue({ receipt: {
      operationId: 'a'.repeat(64), recovery, phase: 'resuming',
      state: 'current', canResume: true,
    } });
    await expect(getConversationActivationRecovery('%1')).rejects.toThrow(/invalid recovery receipt/);
  });

  it('requires accepted recovery with the exact typed command', async () => {
    vi.mocked(requestJson).mockResolvedValue({ accepted: true, recovery });
    await expect(recoverConversationActivation('%1', 'a'.repeat(64))).resolves.toEqual(recovery);
    expect(requestJson).toHaveBeenCalledWith('/api/agents/conversation-activation-recovery',
      expect.objectContaining({ method: 'POST' }));
  });
});
