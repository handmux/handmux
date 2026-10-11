import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiErrors.js';
import { requestJson } from './apiRequest.js';

afterEach(() => vi.unstubAllGlobals());

describe('requestJson', () => {
  it('preserves structured recovery receipts returned with restart errors', async () => {
    const receipt = {
      operationId: 'a'.repeat(64),
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
      phase: 'prepared',
      state: 'current',
      canResume: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Codex could not be safely restarted', code: 'unavailable', recovery: receipt,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })));

    const error = await requestJson('/api/agents/conversation-restart', {
      method: 'POST', body: JSON.stringify({ run: {} }),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).recoveryPayload).toEqual(receipt);
  });
});
