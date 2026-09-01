export interface CodexQueueItem {
  [key: string]: unknown;
  id: string;
  text: string;
  createdAt: number;
  requestId?: string;
  editing?: true;
}

export type CodexSendResult =
  | { [key: string]: unknown; queued: true; item: CodexQueueItem }
  | { [key: string]: unknown; queued?: false; turn?: { id?: string | null; [key: string]: unknown } | null };

export type CodexSubmissionStatus = 'pending' | 'queued' | 'accepted';

export interface CodexSubmissionReceipt {
  pane: string;
  threadId: string;
  requestId: string;
  text: string;
  status: CodexSubmissionStatus;
  createdAt: number;
  updatedAt: number;
  queueItemId?: string;
  turnId?: string;
}

export interface CodexSubmissionReceiptView {
  requestId: string;
  status: CodexSubmissionStatus;
  queueItemId?: string;
  turnId?: string;
}

export interface CodexQueueRecord {
  pane: string;
  threadId: string;
  items: CodexQueueItem[];
}

export interface CodexOutboxSnapshot {
  version: 1;
  queues: CodexQueueRecord[];
  receipts: CodexSubmissionReceipt[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function timeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseCodexQueueItem(value: unknown): CodexQueueItem | null {
  const record = recordOf(value);
  if (!record) return null;
  const id = stringOf(record.id);
  const text = stringOf(record.text);
  const createdAt = timeOf(record.createdAt);
  if (!id || !text || createdAt == null) return null;
  const requestId = record.requestId == null ? undefined : stringOf(record.requestId) ?? undefined;
  if (record.requestId != null && !requestId) return null;
  if (record.editing != null && record.editing !== true) return null;
  return {
    ...record, id, text, createdAt,
    ...(requestId ? { requestId } : {}),
    ...(record.editing === true ? { editing: true } : {}),
  } as CodexQueueItem;
}

export function parseCodexSendResult(value: unknown): CodexSendResult | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.queued === true) {
    const item = parseCodexQueueItem(record.item);
    return item ? { ...record, queued: true, item } : null;
  }
  if (record.queued != null && record.queued !== false) return null;
  const turn = record.turn == null ? record.turn as null | undefined : recordOf(record.turn);
  if (record.turn != null && !turn) return null;
  if (turn?.id != null && typeof turn.id !== 'string') return null;
  return { ...record, ...(record.queued === false ? { queued: false } : {}), ...(turn ? { turn } : {}) };
}

export function parseCodexSubmissionReceipt(value: unknown): CodexSubmissionReceipt | null {
  const record = recordOf(value);
  if (!record) return null;
  const pane = stringOf(record.pane);
  const threadId = stringOf(record.threadId);
  const requestId = stringOf(record.requestId);
  const text = stringOf(record.text);
  const statuses: readonly CodexSubmissionStatus[] = ['pending', 'queued', 'accepted'];
  const status = statuses.find((candidate) => candidate === record.status);
  const createdAt = timeOf(record.createdAt);
  const updatedAt = timeOf(record.updatedAt);
  if (!pane || !threadId || !requestId || !text || !status || createdAt == null || updatedAt == null) return null;
  const queueItemId = record.queueItemId == null ? undefined : stringOf(record.queueItemId) ?? undefined;
  const turnId = record.turnId == null ? undefined : stringOf(record.turnId) ?? undefined;
  if ((record.queueItemId != null && !queueItemId) || (record.turnId != null && !turnId)) return null;
  if (status === 'queued' && !queueItemId) return null;
  return {
    pane, threadId, requestId, text, status, createdAt, updatedAt,
    ...(queueItemId ? { queueItemId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function parseCodexSubmissionReceiptView(value: unknown): CodexSubmissionReceiptView | null {
  const record = recordOf(value);
  if (!record) return null;
  const requestId = stringOf(record.requestId);
  const statuses: readonly CodexSubmissionStatus[] = ['pending', 'queued', 'accepted'];
  const status = statuses.find((candidate) => candidate === record.status);
  const queueItemId = record.queueItemId == null ? undefined : stringOf(record.queueItemId) ?? undefined;
  const turnId = record.turnId == null ? undefined : stringOf(record.turnId) ?? undefined;
  if (!requestId || !status
    || (record.queueItemId != null && !queueItemId)
    || (record.turnId != null && !turnId)
    || (status === 'queued' && !queueItemId)) return null;
  return {
    requestId, status,
    ...(queueItemId ? { queueItemId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function parseCodexOutboxSnapshot(value: unknown): CodexOutboxSnapshot | null {
  const record = recordOf(value);
  if (!record || record.version !== 1 || !Array.isArray(record.queues) || !Array.isArray(record.receipts)) {
    return null;
  }
  const queues: CodexQueueRecord[] = [];
  const queueKeys = new Set<string>();
  for (const candidate of record.queues) {
    const queue = recordOf(candidate);
    if (!queue || !Array.isArray(queue.items)) return null;
    const pane = stringOf(queue.pane);
    const threadId = stringOf(queue.threadId);
    const items = queue.items.map(parseCodexQueueItem);
    if (!pane || !threadId || items.some((item) => !item)) return null;
    const queueKey = `${pane}\0${threadId}`;
    if (queueKeys.has(queueKey)) return null;
    queueKeys.add(queueKey);
    const itemIds = new Set<string>();
    const itemRequestIds = new Set<string>();
    for (const item of items as CodexQueueItem[]) {
      if (itemIds.has(item.id) || (item.requestId && itemRequestIds.has(item.requestId))) return null;
      itemIds.add(item.id);
      if (item.requestId) itemRequestIds.add(item.requestId);
    }
    queues.push({ pane, threadId, items: items as CodexQueueItem[] });
  }
  const receipts = record.receipts.map(parseCodexSubmissionReceipt);
  if (receipts.some((receipt) => !receipt)) return null;
  const receiptKeys = new Set<string>();
  for (const receipt of receipts as CodexSubmissionReceipt[]) {
    const receiptKey = `${receipt.pane}\0${receipt.threadId}\0${receipt.requestId}`;
    if (receiptKeys.has(receiptKey)) return null;
    receiptKeys.add(receiptKey);
  }
  return { version: 1, queues, receipts: receipts as CodexSubmissionReceipt[] };
}
