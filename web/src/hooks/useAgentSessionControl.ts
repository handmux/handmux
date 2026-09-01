import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readAgentModelControl,
  updateAgentModelControl,
} from '../agentSessionControlApi.js';
import type {
  AgentModelControlPatch,
  AgentModelControlSnapshot,
} from '../agentSessionControlApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { UnauthorizedError } from '../apiErrors.js';

export interface AgentSessionControlController {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  error: string | null;
  modelControl: AgentModelControlSnapshot | null;
  saving: boolean;
  refresh(): Promise<void>;
  update(patch: AgentModelControlPatch): Promise<void>;
}

const message = (): string => 'session_control_unavailable';

export function useAgentSessionControl(
  run: AgentRunRef | null,
  onAuthFail?: () => void,
): AgentSessionControlController {
  const [status, setStatus] = useState<AgentSessionControlController['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelControl, setModelControl] = useState<AgentModelControlSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const operation = useRef(0);
  const writeToken = useRef(0);
  const savingRef = useRef(false);
  const runRef = useRef(run);
  const modelControlRef = useRef(modelControl);
  const authRef = useRef(onAuthFail);
  runRef.current = run;
  modelControlRef.current = modelControl;
  authRef.current = onAuthFail;

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    const active = runRef.current;
    if (!active || savingRef.current) return;
    const requestGeneration = generation.current;
    const requestOperation = ++operation.current;
    setError(null);
    setStatus('loading');
    try {
      const next = await readAgentModelControl(active, { refresh });
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || runRef.current?.runId !== active.runId) return;
      setModelControl(next);
      setStatus(next ? 'ready' : 'unavailable');
    } catch (cause) {
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || runRef.current?.runId !== active.runId) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setError(message());
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    operation.current += 1;
    writeToken.current += 1;
    savingRef.current = false;
    setModelControl(null);
    setError(null);
    setSaving(false);
    if (!run) {
      setStatus('idle');
      return undefined;
    }
    void load(false);
    return () => { generation.current += 1; };
  }, [run?.runId, load]);

  const update = useCallback(async (patch: AgentModelControlPatch): Promise<void> => {
    const active = runRef.current;
    if (!active || savingRef.current) return;
    if (!modelControlRef.current?.canUpdate) throw new Error('session_control_read_only');
    const requestGeneration = generation.current;
    const requestOperation = ++operation.current;
    const requestWriteToken = ++writeToken.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await updateAgentModelControl(active, patch);
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || runRef.current?.runId !== active.runId) return;
      setModelControl(next);
      setStatus('ready');
    } catch (cause) {
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || runRef.current?.runId !== active.runId) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setError(message());
      throw cause;
    } finally {
      if (writeToken.current === requestWriteToken) savingRef.current = false;
      if (generation.current === requestGeneration && writeToken.current === requestWriteToken
        && runRef.current?.runId === active.runId) {
        setSaving(false);
      }
    }
  }, []);

  return {
    status,
    error,
    modelControl,
    saving,
    refresh: () => load(true),
    update,
  };
}
