import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';

export interface ConversationRestartReceipt {
  agentId: string;
  paneId: string;
  operationId: string;
  recovery: {
    kind: string;
    sessionId: string;
    command: string;
  };
  phase: 'prepared' | 'stopped' | 'resuming' | 'ready';
  state: 'current' | 'stale';
  canResume: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseConversationRestartReceipt(value: unknown): ConversationRestartReceipt | null {
  const receipt = record(value);
  const recovery = record(receipt?.recovery);
  if (!receipt || typeof receipt.agentId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(receipt.agentId)
    || typeof receipt.paneId !== 'string' || !/^%\d+$/.test(receipt.paneId)
    || typeof receipt.operationId !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.operationId)
    || !recovery || typeof recovery.kind !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(recovery.kind)
    || typeof recovery.sessionId !== 'string' || !recovery.sessionId
    || recovery.sessionId.length > 1_024
    || typeof recovery.command !== 'string' || !recovery.command || recovery.command.length > 4_096
    || /[\x00-\x1f\x7f]/.test(recovery.command)
    || !['prepared', 'stopped', 'resuming', 'ready'].includes(String(receipt.phase))
    || (receipt.state !== 'current' && receipt.state !== 'stale')
    || typeof receipt.canResume !== 'boolean'
    || (receipt.canResume && (receipt.state !== 'current'
      || receipt.phase === 'resuming' || receipt.phase === 'ready'))) {
    return null;
  }
  return {
    agentId: receipt.agentId,
    paneId: receipt.paneId,
    operationId: receipt.operationId,
    recovery: {
      kind: recovery.kind,
      sessionId: recovery.sessionId,
      command: recovery.command as string,
    },
    phase: receipt.phase as ConversationRestartReceipt['phase'],
    state: receipt.state,
    canResume: receipt.canResume,
  };
}

function parseReceiptResponse(value: unknown): ConversationRestartReceipt | null {
  const response = record(value);
  if (!response || !Object.hasOwn(response, 'receipt')) {
    throw new Error('Conversation restart returned an invalid receipt response');
  }
  if (response.receipt === null) return null;
  const receipt = parseConversationRestartReceipt(response.receipt);
  if (!receipt) throw new Error('Conversation restart returned an invalid receipt');
  return receipt;
}

export async function restartConversation(
  run: AgentRunRef,
  signal?: AbortSignal,
): Promise<ConversationRestartReceipt> {
  const response = await requestJson('/api/agents/conversation-restart', {
    method: 'POST', body: JSON.stringify({ run }), timeoutMs: 100_000,
    ...(signal ? { signal } : {}),
  });
  const receipt = parseReceiptResponse(response);
  if (!receipt || receipt.agentId !== run.agentId || receipt.paneId !== run.paneId
    || receipt.recovery.sessionId !== run.sessionId) {
    throw new Error('Conversation restart returned a mismatched receipt');
  }
  return receipt;
}

export async function getConversationRestartRecovery(
  paneId: string,
  signal?: AbortSignal,
): Promise<ConversationRestartReceipt | null> {
  const response = await requestJson(
    `/api/agents/conversation-restart-recovery?${new URLSearchParams({ paneId })}`,
    { timeoutMs: 8_000, ...(signal ? { signal } : {}) },
  );
  const receipt = parseReceiptResponse(response);
  if (receipt && receipt.paneId !== paneId) throw new Error('Conversation restart recovery pane changed');
  return receipt;
}

export async function recoverConversationRestart(
  paneId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<ConversationRestartReceipt> {
  const response = await requestJson('/api/agents/conversation-restart-recovery', {
    method: 'POST', body: JSON.stringify({ paneId, operationId }), timeoutMs: 100_000,
    ...(signal ? { signal } : {}),
  });
  const receipt = parseReceiptResponse(response);
  if (!receipt || receipt.paneId !== paneId || receipt.operationId !== operationId) {
    throw new Error('Conversation restart recovery identity changed');
  }
  return receipt;
}
