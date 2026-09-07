import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentRunRef } from './agentCatalog.js';

export interface ConversationActivationTarget {
  agentId: string;
  paneId: string;
  run: AgentRunRef;
  ownsPane: boolean;
}

export function activationTargetMatches(
  target: ConversationActivationTarget | null,
  paneId: string | null,
  agentId: string | null,
): target is ConversationActivationTarget {
  return target?.paneId === paneId && target.agentId === agentId;
}

export function activationRunFor(
  target: ConversationActivationTarget | null,
  paneId: string | null,
  currentRun: AgentRunRef | null,
): AgentRunRef | null {
  if (currentRun?.paneId === paneId && currentRun.agentId !== target?.agentId) return currentRun;
  return target?.paneId === paneId ? target.run : currentRun;
}

export function conversationRecoveryForSessionlessPane<Receipt extends { state: 'current' | 'stale' }>(
  receipt: Receipt | null,
  authoritativeRun: AgentRunRef | null,
): Receipt | null {
  return authoritativeRun ? null : receipt;
}

export function conversationIdentityForActivation<Identity extends {
  agentId: string;
  paneId: string;
  sessionId: string;
}>(
  currentRun: AgentRunRef | null,
  remembered: Identity | null,
  takeoverAvailable: boolean,
): Identity | null {
  if (!currentRun || currentRun.sessionId) return remembered;
  return takeoverAvailable ? null : remembered;
}

export function invalidateRememberedConversationOnTakeover<Identity>(
  identities: Map<string, Identity>,
  key: string | null,
  currentRun: AgentRunRef | null,
  takeoverAvailable: boolean,
): void {
  if (key && currentRun && !currentRun.sessionId && takeoverAvailable) identities.delete(key);
}

interface ActivationTargetContext {
  paneId: string | null;
  rootView: 'session' | 'project';
  lens: 'terminal' | 'chat';
  runs: readonly AgentRunRef[];
  isConversationEnabled(agentId: string): boolean;
}

export function useConversationActivationTarget({
  paneId, rootView, lens, runs, isConversationEnabled,
}: ActivationTargetContext) {
  const [target, setTarget] = useState<ConversationActivationTarget | null>(null);
  const setPending = useCallback((run: AgentRunRef, active: boolean): void => {
    setTarget((current) => {
      if (active) return { agentId: run.agentId, paneId: run.paneId, run, ownsPane: true };
      if (current?.agentId !== run.agentId || current.paneId !== run.paneId
        || current.run.runId !== run.runId || !current.ownsPane) return current;
      return { ...current, ownsPane: false };
    });
  }, []);
  const clear = useCallback((): void => setTarget(null), []);

  useEffect(() => {
    if (!target) return;
    const activated = runs.some((run) => run.agentId === target.agentId
      && run.paneId === target.paneId && !!run.sessionId);
    const replaced = runs.some((run) => run.paneId === target.paneId && run.agentId !== target.agentId);
    if (paneId !== target.paneId || rootView !== 'session' || lens !== 'chat'
      || !isConversationEnabled(target.agentId) || activated || replaced) clear();
  }, [clear, isConversationEnabled, lens, paneId, rootView, runs, target]);

  const displayTarget = target?.paneId === paneId ? target : null;
  const ownershipPin = displayTarget?.ownsPane ? displayTarget : null;
  return useMemo(() => ({ target, displayTarget, ownershipPin, setPending, clear }), [
    clear, displayTarget, ownershipPin, setPending, target,
  ]);
}
