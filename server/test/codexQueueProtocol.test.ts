import { describe, expect, it } from 'vitest';
import {
  parseCodexOutboxSnapshot, parseCodexQueueItem, parseCodexSendResult,
  parseCodexSubmissionReceiptView,
} from '../src/codexQueueProtocol.js';

describe('Codex queue protocol', () => {
  const item = { id: 'queue-1', text: 'Continue', createdAt: 10, requestId: 'request-1' };

  it('validates queue items and send results', () => {
    expect(parseCodexQueueItem(item)).toEqual(item);
    expect(parseCodexSendResult({ queued: true, item })).toEqual({ queued: true, item });
    expect(parseCodexSendResult({ turn: { id: 'turn-1' } })).toEqual({ turn: { id: 'turn-1' } });
    expect(parseCodexSendResult({ queued: true, item: { ...item, createdAt: '10' } })).toBeNull();
  });

  it('validates the minimal submission receipt exposed to the browser', () => {
    expect(parseCodexSubmissionReceiptView({
      requestId: 'request-1', status: 'accepted', turnId: 'turn-1',
    })).toEqual({ requestId: 'request-1', status: 'accepted', turnId: 'turn-1' });
    expect(parseCodexSubmissionReceiptView({
      requestId: 'request-2', status: 'queued', queueItemId: 'queue-2',
    })).toEqual({ requestId: 'request-2', status: 'queued', queueItemId: 'queue-2' });
    expect(parseCodexSubmissionReceiptView({
      requestId: 'request-2', status: 'queued',
    })).toBeNull();
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

  it.each([
    ['queue key', (snapshot: { version: number; queues: unknown[]; receipts: unknown[] }) => ({
      ...snapshot,
      queues: [snapshot.queues[0], snapshot.queues[0]],
    })],
    ['receipt key', (snapshot: { version: number; queues: unknown[]; receipts: unknown[] }) => ({
      ...snapshot,
      receipts: [snapshot.receipts[0], snapshot.receipts[0]],
    })],
    ['queue item id', (snapshot: { version: number; queues: unknown[]; receipts: unknown[] }) => ({
      ...snapshot,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [
        item, { ...item, requestId: 'request-2' },
      ] }],
    })],
    ['queue item request id', (snapshot: { version: number; queues: unknown[]; receipts: unknown[] }) => ({
      ...snapshot,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [
        item, { ...item, id: 'queue-2' },
      ] }],
    })],
  ])('rejects a duplicate %s instead of silently overwriting it', (_label, corrupt) => {
    const snapshot = {
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-1', text: 'Continue',
        status: 'queued', queueItemId: 'queue-1', createdAt: 10, updatedAt: 11,
      }],
    };
    expect(parseCodexOutboxSnapshot(corrupt(snapshot))).toBeNull();
  });

  it('scopes queue item ids and request ids to their pane-thread queue', () => {
    expect(parseCodexOutboxSnapshot({
      version: 1,
      queues: [
        { pane: '%1', threadId: 'thread-1', items: [item] },
        { pane: '%2', threadId: 'thread-2', items: [item] },
      ],
      receipts: [],
    })).not.toBeNull();
  });
});
