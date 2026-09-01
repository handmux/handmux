import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationQueueAction,
  parseConversationControls,
} from './agentConversationControlsApi.js';

afterEach(() => vi.unstubAllGlobals());

describe('conversation controls parser', () => {
  it('accepts Core Activity, Queue revisions, and active submission recovery snapshots', () => {
    expect(parseConversationControls({
      activity: 'compacting',
      queue: {
        items: [{
          id: 'submission-1', text: 'later', createdAt: 1,
          state: 'queued', revision: 2, dispatchOrigin: 'queue',
          autoDispatchBlockedReason: 'provider_rejected',
        }],
        settled: [{ id: 'submission-settled', nativeId: 'native-turn-1' }],
        canSteer: true, canEdit: true, canRemove: true,
      },
      submissions: [{
        id: 'submission-2', text: 'guide now', state: 'unknown', revision: 4,
        dispatchOrigin: 'steer', steerAnchor: { viewId: 'view-1', afterItemId: 'item-1' },
        baseline: { viewId: 'view-1', historyVersion: 'history-1', tailItemId: 'item-0' },
        autoDispatchBlockedReason: 'provider_rejected',
        createdAt: 2, updatedAt: 3,
      }],
    })).toMatchObject({
      activity: 'compacting',
      queue: { items: [{
        id: 'submission-1', state: 'queued', revision: 2,
        autoDispatchBlockedReason: 'provider_rejected',
      }], settled: [{ id: 'submission-settled', nativeId: 'native-turn-1' }] },
      submissions: [{
        id: 'submission-2', state: 'unknown', revision: 4,
        autoDispatchBlockedReason: 'provider_rejected',
        steerAnchor: { viewId: 'view-1', afterItemId: 'item-1' },
        baseline: { viewId: 'view-1', historyVersion: 'history-1', tailItemId: 'item-0' },
      }],
    });
  });

  it('rejects malformed active submission snapshots instead of guessing ownership', () => {
    expect(parseConversationControls({
      submissions: [{
        id: 'submission-1', text: 'unsafe', state: 'unknown',
        createdAt: 1, updatedAt: 1,
      }],
    })).toBeNull();
  });

  it.each([
    { settled: [{ id: '', nativeId: 'turn-1' }] },
    { settled: [{ id: 'settled-1' }, { id: 'settled-1' }] },
    { settled: [{ id: 'settled-1', nativeId: '' }] },
  ])('rejects malformed identity-only settled receipts: $settled', ({ settled }) => {
    expect(parseConversationControls({
      queue: {
        items: [], settled,
        canSteer: false, canEdit: true, canRemove: true,
      },
    })).toBeNull();
  });

  it('preserves authoritative steer action identity, revision, and mutation result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({
        actionId: 'action-1', result: 'accepted', nativeMutation: true, revision: 8,
      }),
    })));
    await expect(conversationQueueAction({
      agentId: 'codex', paneId: '%1', runId: 'run-1', sessionId: 'session-1',
    }, { action: 'steer', itemId: 'submission-1', actionId: 'action-1' })).resolves.toMatchObject({
      status: 'accepted', actionId: 'action-1', nativeMutation: true, revision: 8,
    });
  });

  it.each(['accepted', 'observed'])('rejects terminal %s as an active submission snapshot', (state) => {
    expect(parseConversationControls({
      submissions: [{
        id: 'terminal-1', text: 'must not be restored', state, revision: 1,
        dispatchOrigin: 'direct', createdAt: 1, updatedAt: 1,
      }],
    })).toBeNull();
  });
});
