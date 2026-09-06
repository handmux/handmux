import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateConversation,
  describeConversationActivation,
} from '../agentConversationActivationApi.js';
import type { ConversationActivationDescriptor } from '../agentConversationActivationApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { ApiError, UnauthorizedError } from '../apiErrors.js';
import type { ApiRecovery } from '../apiErrors.js';

export interface AgentConversationActivationController {
  status: 'idle' | 'loading' | 'ready' | 'activating' | 'waiting' | 'unavailable' | 'error';
  descriptor: ConversationActivationDescriptor | null;
  owner: AgentRunRef | null;
  error: 'stale_run' | 'activation_failed' | 'discovery_timeout' | null;
  recovery?: ApiRecovery | null;
  activate(): Promise<void>;
  retry(): void;
}

const DISCOVERY_ATTEMPTS = 75;
const DISCOVERY_INTERVAL_MS = 400;

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

export function useAgentConversationActivation(
  run: AgentRunRef | null,
  enabled: boolean,
  discover: (run: AgentRunRef) => Promise<AgentRunRef | null>,
  onAuthFail?: () => void,
): AgentConversationActivationController {
  const [status, setStatus] = useState<AgentConversationActivationController['status']>('idle');
  const [descriptor, setDescriptor] = useState<ConversationActivationDescriptor | null>(null);
  const [owner, setOwner] = useState<AgentRunRef | null>(null);
  const [error, setError] = useState<AgentConversationActivationController['error']>(null);
  const [recovery, setRecovery] = useState<ApiRecovery | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const generation = useRef(0);
  const runRef = useRef(run);
  const discoverRef = useRef(discover);
  const authRef = useRef(onAuthFail);
  const activationRef = useRef<AbortController | null>(null);
  runRef.current = run;
  discoverRef.current = discover;
  authRef.current = onAuthFail;

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    setDescriptor(null);
    setOwner(null);
    setError(null);
    setRecovery(null);
    if (!enabled || !run || run.sessionId) {
      setStatus('idle');
      return undefined;
    }
    const controller = new AbortController();
    setStatus('loading');
    void describeConversationActivation(run, controller.signal).then((next) => {
      if (generation.current !== requestGeneration) return;
      setDescriptor(next);
      setOwner(next ? { ...run } : null);
      setStatus(next ? 'ready' : 'unavailable');
    }).catch((cause) => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setOwner(null);
      setError(cause instanceof ApiError && cause.code === 'stale_run'
        ? 'stale_run' : 'activation_failed');
      setStatus('error');
    });
    return () => {
      controller.abort();
      activationRef.current?.abort();
      activationRef.current = null;
      generation.current += 1;
    };
  }, [enabled, retryKey, run?.agentId, run?.paneId, run?.runId, run?.sessionId]);

  const activate = useCallback(async (): Promise<void> => {
    const active = runRef.current;
    if (!active || !descriptor || !owner
      || owner.agentId !== active.agentId || owner.paneId !== active.paneId || owner.runId !== active.runId
      || status === 'activating' || status === 'waiting') return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    activationRef.current?.abort();
    activationRef.current = controller;
    setError(null);
    setRecovery(null);
    setStatus('activating');
    try {
      const activationRecovery = await activateConversation(active, controller.signal);
      if (generation.current !== requestGeneration) return;
      setRecovery(activationRecovery);
      setStatus('waiting');
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
        if (controller.signal.aborted) return;
        const discovered = await discoverRef.current(active);
        if (generation.current !== requestGeneration) return;
        if (discovered?.sessionId) return;
        await delay(DISCOVERY_INTERVAL_MS, controller.signal);
      }
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setError('discovery_timeout');
      setStatus('error');
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setRecovery(cause instanceof ApiError ? cause.recovery : null);
      setError(cause instanceof ApiError && cause.code === 'stale_run'
        ? 'stale_run' : 'activation_failed');
      setStatus('error');
    } finally {
      if (activationRef.current === controller) activationRef.current = null;
    }
  }, [descriptor, owner, status]);

  return {
    status,
    descriptor,
    owner,
    error,
    recovery,
    activate,
    retry: () => setRetryKey((value) => value + 1),
  };
}
