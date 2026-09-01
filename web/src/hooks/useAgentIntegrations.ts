import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  enableAgentIntegration,
  readAgentIntegrations,
} from '../agentIntegrationApi.js';
import type {
  AgentIntegrationName,
  AgentIntegrationSnapshot,
} from '../agentIntegrationApi.js';

export interface AgentIntegrationsController {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: readonly AgentIntegrationSnapshot[];
  busy: AgentIntegrationName | null;
  error: { kind: 'load' | 'action'; name?: AgentIntegrationName } | null;
  refresh(): Promise<void>;
  enable(name: AgentIntegrationName): Promise<void>;
}

export function useAgentIntegrations({ enabled = true }: { enabled?: boolean } = {}): AgentIntegrationsController {
  const [status, setStatus] = useState<AgentIntegrationsController['status']>('idle');
  const [items, setItems] = useState<AgentIntegrationSnapshot[]>([]);
  const [busy, setBusy] = useState<AgentIntegrationName | null>(null);
  const [error, setError] = useState<AgentIntegrationsController['error']>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const busyRef = useRef<AgentIntegrationName | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++request.current;
    setStatus('loading');
    setError(null);
    try {
      const next = await readAgentIntegrations();
      if (!mounted.current || request.current !== id) return;
      setItems(next);
      setStatus('ready');
    } catch {
      if (!mounted.current || request.current !== id) return;
      setStatus('error');
      setError({ kind: 'load' });
    }
  }, []);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const enable = useCallback(async (name: AgentIntegrationName): Promise<void> => {
    if (busyRef.current) return;
    // A status refresh started before this mutation may contain the pre-enable snapshot. Invalidate it so
    // its late response cannot overwrite the mutation result.
    request.current += 1;
    busyRef.current = name;
    setBusy(name);
    setError(null);
    try {
      const next = await enableAgentIntegration(name);
      if (!mounted.current) return;
      setItems((current) => current.map((item) => item.name === name ? next : item));
      setStatus('ready');
    } catch {
      if (!mounted.current) return;
      setError({ kind: 'action', name });
    } finally {
      busyRef.current = null;
      if (mounted.current) setBusy(null);
    }
  }, []);

  return { status, items, busy, error, refresh, enable };
}
