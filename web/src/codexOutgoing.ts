import type { CodexSendResult } from '../../server/src/codexQueueProtocol.js';

export type CodexOutgoingSource = 'send' | 'queue' | 'steer';

export type CodexOutgoingStatus = 'sending' | 'queued' | 'accepted' | 'steered';

export interface CodexOutgoingItem {
  id: string;
  paneId: string;
  text: string;
  source: CodexOutgoingSource;
  status: CodexOutgoingStatus;
  queueId?: string | null;
  turnId?: string;
}

export interface CodexOutgoingSettlement {
  result?: CodexSendResult | Record<string, unknown>;
  error?: unknown;
  uncertain?: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function turnIdOf(result: unknown): string | null {
  const record = recordOf(result);
  if (!record) return null;
  const turn = recordOf(record.turn);
  if (typeof turn?.id === 'string' && turn.id) return turn.id;
  if (typeof record.turnId === 'string' && record.turnId) return record.turnId;
  const nested = recordOf(record.result);
  return typeof nested?.turnId === 'string' && nested.turnId ? nested.turnId : null;
}

export function settleCodexOutgoing(
  items: CodexOutgoingItem[],
  id: string,
  { result, error }: CodexOutgoingSettlement = {},
): CodexOutgoingItem[] {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return items;
  if (error) {
    // A rejected request is no longer "sending". Delivery can still be ambiguous after a transport
    // failure, so the composer reports that uncertainty separately without inventing a durable message.
    return items.filter((candidate) => candidate.id !== id);
  }
  if (result && 'queued' in result && result.queued === true && 'item' in result) {
    const queued = result as Extract<CodexSendResult, { queued: true }>;
    return items.map((candidate) => candidate.id === id
      ? { ...candidate, source: 'queue', status: 'queued', queueId: queued.item.id || null }
      : candidate);
  }
  const status = item.source === 'steer' ? 'steered' : 'accepted';
  const turnId = turnIdOf(result);
  return items.map((candidate) => candidate.id === id
    ? {
      ...candidate,
      status,
      ...(candidate.source === 'queue' ? { source: 'send' } : {}),
      ...(turnId ? { turnId } : {}),
    }
    : candidate);
}
