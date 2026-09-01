import { useCallback, useEffect, useRef, useState } from 'react';
import { respondAgentInteraction, streamAgentInteractions } from '../agentInteractionApi.js';
import { UnauthorizedError } from '../apiErrors.js';
import type { AgentRunRef } from '../agentCatalog.js';
import type {
  AgentInteractionValue,
  PendingAgentInteraction,
} from '../agentInteractionTypes.js';

export interface AgentInteractionController {
  pending: PendingAgentInteraction[];
  status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'error';
  error: 'unavailable' | 'response_failed' | null;
  respondingId: string | null;
  respond(interaction: PendingAgentInteraction, value: AgentInteractionValue): Promise<void>;
}

export function useAgentInteraction(
  run: AgentRunRef | null,
  enabled: boolean,
  onAuthFail?: () => void,
): AgentInteractionController {
  const [pending, setPending] = useState<PendingAgentInteraction[]>([]);
  const [status, setStatus] = useState<AgentInteractionController['status']>('idle');
  const [error, setError] = useState<AgentInteractionController['error']>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const runRef = useRef(run);
  const revisionRef = useRef(-1);
  const revisionRunRef = useRef<string | null>(null);
  runRef.current = run;

  useEffect(() => {
    const controller = new AbortController();
    if (!enabled || !run?.sessionId) {
      setPending([]);
      setStatus('idle');
      setError(null);
      return () => controller.abort();
    }
    const runKey = `${run.agentId}\0${run.paneId}\0${run.runId}`;
    if (revisionRunRef.current !== runKey) {
      revisionRunRef.current = runKey;
      revisionRef.current = -1;
    }
    let current = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const applyEvent = (event: Parameters<typeof streamAgentInteractions>[1]['onEvent'] extends (
      value: infer T,
    ) => void ? T : never): void => {
      if (event.revision <= revisionRef.current) return;
      revisionRef.current = event.revision;
      setPending((items) => event.type === 'opened'
        ? [...items.filter((item) => item.id !== event.interaction.id), event.interaction]
        : items.filter((item) => item.id !== event.interactionId));
    };
    const connect = async (): Promise<void> => {
      setStatus((value) => value === 'ready' ? 'reconnecting' : 'connecting');
      try {
        await streamAgentInteractions(run, {
          signal: controller.signal,
          onReady: (checkpoint) => {
            if (!current) return;
            if (checkpoint.revision < revisionRef.current) return;
            revisionRef.current = checkpoint.revision;
            setPending(checkpoint.pending);
            setError(null);
            setStatus('ready');
          },
          onEvent: (event) => { if (current) applyEvent(event); },
        });
        if (!controller.signal.aborted) throw new Error('Agent Interaction stream closed');
      } catch (cause) {
        if (!current || controller.signal.aborted) return;
        if (cause instanceof UnauthorizedError) onAuthFail?.();
        setError('unavailable');
        setStatus('reconnecting');
        reconnectTimer = setTimeout(() => { void connect(); }, 1_000);
      }
    };
    void connect();
    return () => {
      current = false;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [enabled, onAuthFail, run?.agentId, run?.paneId, run?.runId, run?.sessionId]);

  const respond = useCallback(async (
    interaction: PendingAgentInteraction,
    value: AgentInteractionValue,
  ): Promise<void> => {
    const active = runRef.current;
    if (!active || interaction.runId !== active.runId) throw new Error('Interaction is no longer current');
    setRespondingId(interaction.id);
    setError(null);
    try {
      const receipt = await respondAgentInteraction(active, interaction, value);
      if (receipt.status === 'accepted' || receipt.status === 'already_resolved') {
        setPending((items) => items.filter((item) => item.id !== interaction.id));
        return;
      }
      throw new Error('interaction_response_rejected');
    } catch (cause) {
      if (cause instanceof UnauthorizedError) onAuthFail?.();
      setError('response_failed');
      throw new Error('Agent interaction response failed');
    } finally { setRespondingId(null); }
  }, [onAuthFail]);

  return { pending, status, error, respondingId, respond };
}
