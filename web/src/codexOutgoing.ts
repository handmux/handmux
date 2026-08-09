export type CodexOutgoingSource = 'send' | 'queue' | 'steer';

export type CodexOutgoingStatus = 'sending' | 'queued' | 'accepted' | 'steered';

export interface CodexOutgoingItem {
  id: string;
  paneId: string;
  text: string;
  source: CodexOutgoingSource;
  status: CodexOutgoingStatus;
  queueId?: string | null;
}

export interface CodexSendResult {
  queued?: boolean;
  item?: { id?: string | null } | null;
  turn?: { id?: string | null } | null;
}

export interface CodexOutgoingSettlement {
  result?: CodexSendResult;
  error?: unknown;
  uncertain?: boolean;
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
  if (result?.queued) {
    return items.map((candidate) => candidate.id === id
      ? { ...candidate, source: 'queue', status: 'queued', queueId: result.item?.id || null }
      : candidate);
  }
  const status = item.source === 'steer' ? 'steered' : 'accepted';
  return items.map((candidate) => candidate.id === id
    ? { ...candidate, status, ...(candidate.source === 'queue' ? { source: 'send' } : {}) }
    : candidate);
}
