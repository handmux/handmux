import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversationActivationRecovery,
  recoverConversationActivation,
} from '../agentConversationActivationApi.js';
import type { ConversationActivationRecoveryReceipt } from '../agentConversationActivationApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { UnauthorizedError } from '../apiErrors.js';

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

export interface ConversationActivationRecoveryController {
  status: 'idle' | 'loading' | 'ready' | 'recovering' | 'waiting' | 'error' | 'unknown';
  receipt: ConversationActivationRecoveryReceipt | null;
  recover(): Promise<void>;
  retry(): void;
}

export function useConversationActivationRecovery(
  paneId: string | null,
  enabled: boolean,
  discover: (paneId: string, sessionId: string) => Promise<AgentRunRef | null>,
  onAuthFail?: () => void,
): ConversationActivationRecoveryController {
  const [status, setStatus] = useState<ConversationActivationRecoveryController['status']>('idle');
  const [receipt, setReceipt] = useState<ConversationActivationRecoveryReceipt | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const generation = useRef(0);
  const paneKey = useRef<string | null>(null);
  const inputPaneRef = useRef<string | null>(enabled ? paneId : null);
  const receiptRef = useRef(receipt);
  const discoverRef = useRef(discover);
  const authRef = useRef(onAuthFail);
  const operationRef = useRef<AbortController | null>(null);
  receiptRef.current = receipt;
  inputPaneRef.current = enabled ? paneId : null;
  discoverRef.current = discover;
  authRef.current = onAuthFail;

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    if (!enabled || !paneId) {
      paneKey.current = null;
      setReceipt(null);
      setStatus('idle');
      return undefined;
    }
    if (paneKey.current !== paneId) {
      paneKey.current = paneId;
      setReceipt(null);
    }
    const controller = new AbortController();
    setStatus('loading');
    void getConversationActivationRecovery(paneId, controller.signal).then((next) => {
      if (generation.current !== requestGeneration) return;
      setReceipt(next);
      setStatus('ready');
    }).catch((cause) => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      // A transient Server/runtime/network gap is not authoritative absence. Keep the last safe page.
      setStatus('unknown');
    });
    return () => {
      controller.abort();
      operationRef.current?.abort();
      operationRef.current = null;
      generation.current += 1;
    };
  }, [enabled, paneId, retryKey]);

  const recover = useCallback(async (): Promise<void> => {
    const current = receiptRef.current;
    const activePane = paneKey.current;
    if (!activePane || activePane !== inputPaneRef.current || !current
      || !current.canResume || current.state !== 'current'
      || current.phase === 'resuming' || status === 'recovering' || status === 'waiting') return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    operationRef.current?.abort();
    operationRef.current = controller;
    setReceipt({ ...current, phase: 'resuming', canResume: false });
    setStatus('recovering');
    try {
      const recovery = await recoverConversationActivation(
        activePane, current.operationId, controller.signal,
      );
      if (recovery.sessionId !== current.recovery.sessionId
        || recovery.command !== current.recovery.command) {
        throw new Error('Conversation recovery identity changed');
      }
      if (generation.current !== requestGeneration) return;
      setStatus('waiting');
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
        if (controller.signal.aborted) return;
        const discovered = await discoverRef.current(activePane, current.recovery.sessionId);
        if (generation.current !== requestGeneration) return;
        if (discovered?.agentId === 'codex' && discovered.paneId === activePane
          && discovered.sessionId === current.recovery.sessionId) {
          setReceipt(null);
          setStatus('ready');
          void getConversationActivationRecovery(activePane).catch(() => {});
          return;
        }
        await delay(DISCOVERY_INTERVAL_MS, controller.signal);
      }
      if (!controller.signal.aborted && generation.current === requestGeneration) setStatus('error');
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setStatus('error');
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  }, [status]);

  const paneMatches = !!enabled && !!paneId && paneKey.current === paneId;
  return {
    status: enabled && paneId && !paneMatches ? 'loading' : status,
    receipt: paneMatches ? receipt : null,
    recover,
    retry: () => setRetryKey((value) => value + 1),
  };
}
