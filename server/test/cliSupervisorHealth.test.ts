import { describe, expect, it, vi } from 'vitest';
import { RuntimeHealth } from '../src/healthProtocol.js';
import { probeServerReadiness } from '../src/cli/supervisorHealth.js';

function response(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as Response;
}

describe('Supervisor readiness probe', () => {
  it('accepts only a successful, contract-valid ready response', async () => {
    const health = new RuntimeHealth({ now: () => 123 });
    health.set('workspace', 'ready');
    health.set('codex', 'ready');
    const fetchImpl = vi.fn(async () => response(true, health.snapshot())) as unknown as typeof fetch;

    await expect(probeServerReadiness(19_999, { fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:19999/health/ready', expect.objectContaining({
      method: 'GET', signal: expect.any(AbortSignal),
    }));
  });

  it('rejects HTTP failures and malformed optimistic bodies', async () => {
    const unavailable = vi.fn(async () => response(false, {})) as unknown as typeof fetch;
    const malformed = vi.fn(async () => response(true, { ready: true })) as unknown as typeof fetch;
    await expect(probeServerReadiness(1, { fetchImpl: unavailable })).resolves.toBe(false);
    await expect(probeServerReadiness(1, { fetchImpl: malformed })).resolves.toBe(false);
  });
});
