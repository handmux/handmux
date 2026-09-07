import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';
import { parseApiRecovery } from './apiErrors.js';
import type { ApiRecovery } from './apiErrors.js';

export interface ConversationActivationDescriptor {
  effect: 'replace-process-preserve-session';
}

export interface ConversationActivationRecoveryReceipt {
  operationId: string;
  recovery: ApiRecovery;
  phase: 'prepared' | 'interrupted' | 'resuming';
  state: 'current' | 'stale';
  canResume: boolean;
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

export async function activateConversation(
  run: AgentRunRef,
  signal?: AbortSignal,
): Promise<ApiRecovery | null> {
  const response = record(await requestJson('/api/agents/conversation-activation', {
    method: 'POST',
    body: JSON.stringify({ run }),
    timeoutMs: 20_000,
    ...(signal ? { signal } : {}),
  }));
  if (response?.accepted !== true) throw new Error('Conversation activation was not accepted');
  return parseApiRecovery(response.recovery);
}

function parseRecoveryReceipt(value: unknown): ConversationActivationRecoveryReceipt | null {
  const receipt = record(value);
  const recovery = parseApiRecovery(receipt?.recovery);
  if (!receipt || typeof receipt.operationId !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.operationId) || !recovery
    || (receipt.phase !== 'prepared' && receipt.phase !== 'interrupted' && receipt.phase !== 'resuming')
    || (receipt.state !== 'current' && receipt.state !== 'stale')
    || typeof receipt.canResume !== 'boolean'
    || (receipt.canResume && (receipt.state !== 'current' || receipt.phase === 'resuming'))) {
    throw new Error('Conversation activation returned an invalid recovery receipt');
  }
  return {
    operationId: receipt.operationId,
    recovery,
    phase: receipt.phase,
    state: receipt.state,
    canResume: receipt.canResume,
  };
}

export async function getConversationActivationRecovery(
  paneId: string,
  signal?: AbortSignal,
): Promise<ConversationActivationRecoveryReceipt | null> {
  const response = record(await requestJson(
    `/api/agents/conversation-activation-recovery?${new URLSearchParams({ paneId })}`,
    { timeoutMs: 8_000, ...(signal ? { signal } : {}) },
  ));
  if (!response || !Object.hasOwn(response, 'receipt')) {
    throw new Error('Conversation activation returned an invalid recovery response');
  }
  return response.receipt === null ? null : parseRecoveryReceipt(response.receipt);
}

export async function recoverConversationActivation(
  paneId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<ApiRecovery> {
  const response = record(await requestJson('/api/agents/conversation-activation-recovery', {
    method: 'POST',
    body: JSON.stringify({ paneId, operationId }),
    timeoutMs: 20_000,
    ...(signal ? { signal } : {}),
  }));
  const recovery = parseApiRecovery(response?.recovery);
  if (response?.accepted !== true || !recovery) {
    throw new Error('Conversation recovery was not accepted');
  }
  return recovery;
}
