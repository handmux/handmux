import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversationRestartRecovery,
  parseConversationRestartReceipt,
  recoverConversationRestart,
  restartConversation,
} from '../agentConversationRestartApi.js';
import type { ConversationRestartReceipt } from '../agentConversationRestartApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { ApiError, UnauthorizedError } from '../apiErrors.js';
import { backoffDelay } from '../backoff.js';

export type ConversationRestartRecoveryView = Omit<ConversationRestartReceipt, 'operationId' | 'state'> & {
  operationId?: string;
  state: ConversationRestartReceipt['state'] | 'unknown';
};

export interface ConversationRestartController {
  status: 'idle' | 'loading' | 'ready' | 'restarting' | 'recovering' | 'error' | 'unknown';
  receipt: ConversationRestartRecoveryView | null;
  error: string | null;
  restart(): Promise<void>;
  recover(): Promise<void>;
  retry(): void;
}

function manualRecovery(run: AgentRunRef): ConversationRestartRecoveryView | null {
  const sessionId = run.sessionId;
  if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }
  return {
    recovery: { kind: 'codex_resume', sessionId, command: `handmux codex resume ${sessionId}` },
    phase: 'prepared', state: 'unknown', canResume: false,
  };
}

function recoveryView(value: ConversationRestartReceipt): ConversationRestartRecoveryView {
  return value;
}

export function useConversationRestart(
  run: AgentRunRef | null,
  enabled: boolean,
  onAuthFail?: () => void,
  activePaneId: string | null = run?.paneId ?? null,
): ConversationRestartController {
  const [status, setStatus] = useState<ConversationRestartController['status']>('idle');
  const [receipt, setReceipt] = useState<ConversationRestartRecoveryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const generation = useRef(0);
  const paneKey = useRef<string | null>(null);
  const paneInputRef = useRef<string | null>(enabled ? activePaneId : null);
  const enabledRef = useRef(enabled);
  const runRef = useRef(run);
  const receiptRef = useRef(receipt);
  const authRef = useRef(onAuthFail);
  const operationRef = useRef<AbortController | null>(null);
  const lookupRef = useRef<AbortController | null>(null);
  const operationBusyRef = useRef(false);
  const staleRunLookupErrorRef = useRef<string | null>(null);
  runRef.current = run;
  receiptRef.current = receipt;
  authRef.current = onAuthFail;
  enabledRef.current = enabled;
  paneInputRef.current = enabled ? activePaneId : null;

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    staleRunLookupErrorRef.current = null;
    setError(null);
    if (!enabled || !activePaneId) {
      paneKey.current = null;
      setReceipt(null);
      setStatus('idle');
      return undefined;
    }
    if (paneKey.current !== activePaneId) {
      paneKey.current = activePaneId;
      setReceipt(null);
    }
    const controller = new AbortController();
    lookupRef.current = controller;
    let retryTimer: number | undefined;
    let failures = 0;
    controller.signal.addEventListener('abort', () => window.clearTimeout(retryTimer), { once: true });
    setStatus('loading');
    const lookup = async (): Promise<void> => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      try {
        const next = await getConversationRestartRecovery(activePaneId, controller.signal);
        if (controller.signal.aborted || generation.current !== requestGeneration) return;
        if (!next || next.phase === 'ready') {
          setReceipt(null);
          setError(null);
          setStatus('ready');
        } else {
          setReceipt(recoveryView(next));
          setError(null);
          setStatus('error');
        }
      } catch (cause) {
        if (controller.signal.aborted || generation.current !== requestGeneration) return;
        setStatus('unknown');
        if (cause instanceof UnauthorizedError) {
          controller.abort();
          operationRef.current?.abort();
          authRef.current?.();
          return;
        }
        retryTimer = window.setTimeout(() => { void lookup(); }, backoffDelay(++failures));
      }
    };
    void lookup();
    return () => {
      controller.abort();
      if (lookupRef.current === controller) lookupRef.current = null;
      operationRef.current?.abort();
      operationRef.current = null;
      operationBusyRef.current = false;
      generation.current += 1;
    };
  }, [activePaneId, enabled, retryKey]);

  useEffect(() => {
    if (!enabled || !activePaneId || status !== 'error' || !receipt) return undefined;
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      try {
        const next = await getConversationRestartRecovery(activePaneId, controller.signal);
        if (controller.signal.aborted || paneKey.current !== activePaneId) return;
        if (next?.phase === 'ready') {
          staleRunLookupErrorRef.current = null;
          setReceipt(null);
          setStatus('ready');
          return;
        }
        if (next) {
          staleRunLookupErrorRef.current = null;
          setReceipt(recoveryView(next));
        } else if (staleRunLookupErrorRef.current) {
          const reason = staleRunLookupErrorRef.current;
          staleRunLookupErrorRef.current = null;
          setReceipt(null);
          setError(reason);
          setStatus('error');
          return;
        }
        timer = window.setTimeout(() => { void poll(); }, 1_000);
      } catch (cause) {
        if (controller.signal.aborted || paneKey.current !== activePaneId) return;
        if (cause instanceof UnauthorizedError) {
          authRef.current?.();
          return;
        }
        timer = window.setTimeout(() => { void poll(); }, backoffDelay(++failures));
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 1_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activePaneId, enabled, receipt !== null, status]);

  const restart = useCallback(async (): Promise<void> => {
    const activeRun = runRef.current;
    const activePane = paneKey.current;
    if (!enabledRef.current || !activeRun || activeRun.agentId !== 'codex'
      || !activeRun.sessionId || !activePane || activeRun.paneId !== activePane
      || activePane !== paneInputRef.current || operationBusyRef.current) return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    lookupRef.current?.abort();
    operationRef.current?.abort();
    operationRef.current = controller;
    operationBusyRef.current = true;
    staleRunLookupErrorRef.current = null;
    setReceipt(null);
    setError(null);
    setStatus('restarting');
    try {
      const next = await restartConversation({ ...activeRun }, controller.signal);
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (next.phase === 'ready') {
        setReceipt(null);
        setStatus('ready');
      } else {
        setReceipt(recoveryView(next));
        setStatus('error');
      }
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      if (cause instanceof ApiError && ['not_started', 'stale_run', 'unsupported'].includes(cause.code ?? '')
        && cause.recoveryPayload === undefined) {
        if (cause.code === 'stale_run') {
          try {
            const pending = await getConversationRestartRecovery(activePane, controller.signal);
            if (controller.signal.aborted || generation.current !== requestGeneration) return;
            if (pending && pending.phase !== 'ready') {
              setReceipt(recoveryView(pending));
              setError(null);
              setStatus('error');
              return;
            }
          } catch {
            if (controller.signal.aborted || generation.current !== requestGeneration) return;
            staleRunLookupErrorRef.current = cause.serverError || cause.message;
            setReceipt(manualRecovery(activeRun));
            setError(null);
            setStatus('error');
            return;
          }
        }
        setReceipt(null);
        setError(cause.serverError || cause.message);
        setStatus('error');
        return;
      }
      let next = cause instanceof ApiError
        ? parseConversationRestartReceipt(cause.recoveryPayload) : null;
      if (!next) {
        try { next = await getConversationRestartRecovery(activePane, controller.signal); }
        catch { /* A read-only retry below will keep checking while the copy-only guide remains visible. */ }
      }
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setError(null);
      setReceipt(next ? recoveryView(next) : manualRecovery(activeRun));
      setStatus('error');
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      operationBusyRef.current = false;
    }
  }, []);

  const recover = useCallback(async (): Promise<void> => {
    const current = receiptRef.current;
    const activePane = paneKey.current;
    if (!activePane || activePane !== paneInputRef.current || !current?.operationId
      || !current.canResume || current.state !== 'current'
      || current.phase === 'resuming' || current.phase === 'ready' || operationBusyRef.current) return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    lookupRef.current?.abort();
    operationRef.current?.abort();
    operationRef.current = controller;
    operationBusyRef.current = true;
    staleRunLookupErrorRef.current = null;
    setError(null);
    setReceipt({ ...current, phase: 'resuming', canResume: false });
    setStatus('recovering');
    try {
      const next = await recoverConversationRestart(activePane, current.operationId, controller.signal);
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (next.phase === 'ready') {
        setReceipt(null);
        setStatus('ready');
      } else {
        setReceipt(recoveryView(next));
        setStatus('error');
      }
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      let next = cause instanceof ApiError
        ? parseConversationRestartReceipt(cause.recoveryPayload) : null;
      if (!next) {
        try { next = await getConversationRestartRecovery(activePane, controller.signal); }
        catch { /* Keep the existing command available even when the server is still reconnecting. */ }
      }
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setReceipt(next ? recoveryView(next) : current);
      setStatus('error');
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      operationBusyRef.current = false;
    }
  }, []);

  return {
    status: enabled && activePaneId && paneKey.current !== activePaneId ? 'loading' : status,
    receipt: enabled && activePaneId && paneKey.current === activePaneId ? receipt : null,
    error: enabled && activePaneId && paneKey.current === activePaneId ? error : null,
    restart,
    recover,
    retry: () => setRetryKey((value) => value + 1),
  };
}
