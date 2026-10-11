import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';

export interface ConversationRestartReceipt {
  operationId: string;
  recovery: {
    kind: 'codex_resume';
    sessionId: string;
    command: string;
  };
  phase: 'prepared' | 'stopped' | 'resuming' | 'ready';
  state: 'current' | 'stale';
  canResume: boolean;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseConversationRestartReceipt(value: unknown): ConversationRestartReceipt | null {
  const receipt = record(value);
  const recovery = record(receipt?.recovery);
  if (!receipt || typeof receipt.operationId !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.operationId)
    || !recovery || recovery.kind !== 'codex_resume' || typeof recovery.sessionId !== 'string'
    || !SESSION_ID_RE.test(recovery.sessionId)
    || recovery.command !== `handmux codex resume ${recovery.sessionId}`
    || !['prepared', 'stopped', 'resuming', 'ready'].includes(String(receipt.phase))
    || (receipt.state !== 'current' && receipt.state !== 'stale')
    || typeof receipt.canResume !== 'boolean'
    || (receipt.canResume && (receipt.state !== 'current'
      || receipt.phase === 'resuming' || receipt.phase === 'ready'))) {
    return null;
  }
  return {
    operationId: receipt.operationId,
    recovery: {
      kind: 'codex_resume',
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
  if (!receipt) throw new Error('Conversation restart returned no receipt');
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
  return parseReceiptResponse(response);
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
  if (!receipt) throw new Error('Conversation restart recovery returned no receipt');
  return receipt;
}
