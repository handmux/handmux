import { parseHealthReadySnapshot } from '../healthProtocol.js';

export interface SupervisorHealthProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function probeServerReadiness(
  port: number,
  { fetchImpl = fetch, timeoutMs = 500 }: SupervisorHealthProbeOptions = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health/ready`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return parseHealthReadySnapshot(await response.json())?.ready === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
