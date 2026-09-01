import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';

export interface ConversationActivationDescriptor {
  effect: 'replace-process-preserve-session';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function query(run: AgentRunRef): string {
  return new URLSearchParams({
    agentId: run.agentId,
    paneId: run.paneId,
    runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  }).toString();
}

export async function describeConversationActivation(
  run: AgentRunRef,
  signal?: AbortSignal,
): Promise<ConversationActivationDescriptor | null> {
  const response = record(await requestJson(`/api/agents/conversation-activation?${query(run)}`, {
    timeoutMs: 8_000,
    ...(signal ? { signal } : {}),
  }));
  if (response?.descriptor === null) return null;
  const descriptor = record(response?.descriptor);
  if (descriptor?.effect !== 'replace-process-preserve-session') {
    throw new Error('Conversation activation returned an invalid descriptor');
  }
  return { effect: 'replace-process-preserve-session' };
}

export async function activateConversation(run: AgentRunRef, signal?: AbortSignal): Promise<void> {
  const response = record(await requestJson('/api/agents/conversation-activation', {
    method: 'POST',
    body: JSON.stringify({ run }),
    timeoutMs: 20_000,
    ...(signal ? { signal } : {}),
  }));
  if (response?.accepted !== true) throw new Error('Conversation activation was not accepted');
}
