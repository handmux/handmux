import { describe, expect, it } from 'vitest';
import {
  parseCodexOutboxSnapshot, parseCodexQueueItem, parseCodexSendResult,
} from '../src/codexQueueProtocol.js';

describe('Codex queue protocol', () => {
  const item = { id: 'queue-1', text: 'Continue', createdAt: 10, requestId: 'request-1' };

  it('validates queue items and send results', () => {
    expect(parseCodexQueueItem(item)).toEqual(item);
    expect(parseCodexSendResult({ queued: true, item })).toEqual({ queued: true, item });
    expect(parseCodexSendResult({ turn: { id: 'turn-1' } })).toEqual({ turn: { id: 'turn-1' } });
    expect(parseCodexSendResult({ queued: true, item: { ...item, createdAt: '10' } })).toBeNull();
  });

  it('validates the complete versioned Outbox snapshot atomically', () => {
    const snapshot = {
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-1', text: 'Continue',
        status: 'queued', queueItemId: 'queue-1', createdAt: 10, updatedAt: 11,
      }],
    };
    expect(parseCodexOutboxSnapshot(snapshot)).toEqual(snapshot);
    expect(parseCodexOutboxSnapshot({ ...snapshot, receipts: [
      { ...snapshot.receipts[0], queueItemId: undefined },
    ] })).toBeNull();
  });
});
