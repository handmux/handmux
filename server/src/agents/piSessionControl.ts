import type { LocalAgentBridgeHost } from '../agent-runtime/bridgeTypes.js';
import type {
  AgentModelControlPatch,
  AgentModelControlSnapshot,
  AgentSessionControlAdapterV1,
} from '../agent-runtime/sessionControl.js';

export const PI_SESSION_CONTROL_IMPLEMENTATION_VERSION = 3;

function isSnapshot(value: unknown): value is AgentModelControlSnapshot {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createPiSessionControlAdapter({
  host,
}: {
  host: LocalAgentBridgeHost;
}): AgentSessionControlAdapterV1 {
  if (!host || typeof host.request !== 'function') {
    throw new TypeError('Pi Session Control adapter requires LocalAgentBridgeHost');
  }
  const read = async (
    run: Parameters<AgentSessionControlAdapterV1['readModelControl']>[0],
    refresh: boolean,
  ): Promise<AgentModelControlSnapshot | null> => {
    // Connector v2 knows nothing about Session Control. Treat absence as an optional capability instead
    // of probing an unregistered Bridge method and delaying or disabling its otherwise healthy chat.
    if ((run.ref.implementationVersion ?? 1) < PI_SESSION_CONTROL_IMPLEMENTATION_VERSION) return null;
    const value = await host.request(
      run,
      'session-control',
      'read',
      { refresh },
      { timeoutMs: refresh ? 30_000 : 8_000, signal: run.signal },
    );
    if (!isSnapshot(value)) throw new Error('Pi Extension returned an invalid Session Control snapshot');
    return value;
  };
  return {
    apiVersion: 1,
    readModelControl: (run, options) => read(run, options?.refresh === true),
    async updateModelControl(run, patch: AgentModelControlPatch) {
      if ((run.ref.implementationVersion ?? 1) < PI_SESSION_CONTROL_IMPLEMENTATION_VERSION) {
        throw new Error('Pi Session Control requires /reload');
      }
      const value = await host.request(
        run,
        'session-control',
        'update',
        patch,
        { timeoutMs: 8_000, signal: run.signal },
      );
      if (!isSnapshot(value)) throw new Error('Pi Extension returned an invalid Session Control snapshot');
      return value;
    },
  };
}
