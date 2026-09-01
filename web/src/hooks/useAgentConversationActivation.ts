import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateConversation,
  describeConversationActivation,
} from '../agentConversationActivationApi.js';
import type { ConversationActivationDescriptor } from '../agentConversationActivationApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { ApiError, UnauthorizedError } from '../apiErrors.js';

export interface AgentConversationActivationController {
  status: 'idle' | 'loading' | 'ready' | 'activating' | 'waiting' | 'unavailable' | 'error';
  descriptor: ConversationActivationDescriptor | null;
  error: 'stale_run' | 'activation_failed' | 'discovery_timeout' | null;
  activate(): Promise<void>;
  retry(): void;
}

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
  const [error, setError] = useState<AgentConversationActivationController['error']>(null);
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
    setError(null);
    if (!enabled || !run || run.sessionId) {
      setStatus('idle');
      return undefined;
    }
    const controller = new AbortController();
    setStatus('loading');
    void describeConversationActivation(run, controller.signal).then((next) => {
      if (generation.current !== requestGeneration) return;
      setDescriptor(next);
      setStatus(next ? 'ready' : 'unavailable');
    }).catch((cause) => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
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
  }, [enabled, retryKey, run?.runId, run?.sessionId]);

  const activate = useCallback(async (): Promise<void> => {
    const active = runRef.current;
    if (!active || !descriptor || status === 'activating' || status === 'waiting') return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    activationRef.current?.abort();
    activationRef.current = controller;
    setError(null);
    setStatus('activating');
    try {
      await activateConversation(active, controller.signal);
      if (generation.current !== requestGeneration) return;
      setStatus('waiting');
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (controller.signal.aborted) return;
        const discovered = await discoverRef.current(active);
        if (generation.current !== requestGeneration) return;
        if (discovered?.sessionId) return;
        await delay(400, controller.signal);
      }
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setError('discovery_timeout');
      setStatus('error');
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setError(cause instanceof ApiError && cause.code === 'stale_run'
        ? 'stale_run' : 'activation_failed');
      setStatus('error');
    } finally {
      if (activationRef.current === controller) activationRef.current = null;
    }
  }, [descriptor, status]);

  return {
    status,
    descriptor,
    error,
    activate,
    retry: () => setRetryKey((value) => value + 1),
  };
}
