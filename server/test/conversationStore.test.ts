import { describe, expect, it } from 'vitest';
import { parseConversationState } from '../src/agent-runtime/conversationStore.js';

const HASH = '0'.repeat(64);

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'request-1',
    text: 'hello', payloadHash: HASH, state: 'queued', revision: 1,
    queueOrderKey: '0000000000000001:0000000000000001', createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function cycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'codex', sessionId: 'thread-1', state: 'closed', revision: 0,
    activityEpoch: 'run-1', baselineRevision: 1,
    ...overrides,
  };
}

function state(
  submissions: Record<string, unknown>[] = [],
  cycles: Record<string, unknown>[] = [],
  ledgerRevision = Math.max(0, ...submissions.map((item) => Number(item.revision) || 0),
    ...cycles.map((item) => Number(item.revision) || 0)),
): Record<string, unknown> {
  return { version: 2, ledgerRevision, submissions, cycles, legacySends: [] };
}

describe('Conversation v2 store schema', () => {
  it.each([
    ['submission revision', state([submission({ revision: 2 })], [], 1)],
    ['cycle revision', state([], [cycle({ revision: 2 })], 1)],
  ])('rejects ledgerRevision below the maximum %s', (_name, fixture) => {
    expect(() => parseConversationState(fixture)).toThrow();
  });

  it.each([
    ['nativeId', { nativeId: 7 }],
    ['lastRunId', { lastRunId: '' }],
    ['steerActionId', { steerActionId: 7 }],
    ['steerAnchor', { steerAnchor: { afterItemId: 'item-1' } }],
    ['steerDispatchPlan', { steerDispatchPlan: {
      kind: 'steer-active-turn', activityEpoch: 'run-1', activityRevision: 1,
    } }],
    ['baseline', { baseline: { viewId: 'view-1' } }],
    ['receiptExpiresAt', { receiptExpiresAt: 'later' }],
  ])('rejects an invalid optional submission %s', (_name, overrides) => {
    expect(() => parseConversationState(state([submission(overrides)]))).toThrow();
  });

  it.each([
    ['queued with an origin', submission({ dispatchOrigin: 'direct' })],
    ['dispatching with steer origin', submission({
      state: 'dispatching', dispatchOrigin: 'steer', queueOrderKey: undefined,
    })],
    ['steering without its plan tuple', submission({ state: 'steering', dispatchOrigin: 'steer' })],
    ['direct dispatch with a queue order', submission({ state: 'dispatching', dispatchOrigin: 'direct' })],
    ['blocked non-queued submission', submission({
      state: 'accepted', dispatchOrigin: 'queue', autoDispatchBlockedReason: 'provider_rejected',
    })],
  ])('rejects invalid state/field combination: %s', (_name, fixture) => {
    expect(() => parseConversationState(state([fixture]))).toThrow();
  });

  it.each(['accepted', 'unknown', 'observed'])('rejects %s steer origin without a complete steer tuple', (status) => {
    expect(() => parseConversationState(state([submission({
      state: status, dispatchOrigin: 'steer',
    })]))).toThrow();
  });

  it.each([
    ['closed cycle with owner', cycle({ ownerSubmissionId: 'request-1' })],
    ['dispatching cycle without owner', cycle({ state: 'dispatching', revision: 1 })],
    ['awaiting_idle cycle without non-idle revision', cycle({ state: 'awaiting_idle', revision: 1 })],
    ['cycle with invalid non-idle revision', cycle({ nonIdleRevision: '2' })],
    ['cycle with invalid closed-idle revision', cycle({ closedIdleRevision: -1 })],
  ])('rejects invalid cycle condition: %s', (_name, fixture) => {
    expect(() => parseConversationState(state([], [fixture]))).toThrow();
  });

  it.each(['dispatching', 'awaiting_non_idle'])('rejects closedIdleRevision on a claimed %s cycle', (status) => {
    expect(() => parseConversationState(state(
      [submission({ state: 'accepted', dispatchOrigin: 'direct', queueOrderKey: undefined })],
      [cycle({ state: status, revision: 1, ownerSubmissionId: 'request-1', closedIdleRevision: 2 })],
      2,
    ))).toThrow();
  });

  it('rejects a cycle owner that does not resolve to the same session submission', () => {
    expect(() => parseConversationState(state(
      [submission({ sessionId: 'other-thread' })],
      [cycle({ state: 'dispatching', revision: 1, ownerSubmissionId: 'request-1' })],
    ))).toThrow();
  });

  it.each([
    ['missing identity', { state: 'dispatching' }],
    ['invalid receipt condition', {
      agentId: 'codex', runId: 'run-1', clientRequestId: 'legacy-1', payloadHash: HASH,
      state: 'dispatching', receipt: { status: 'accepted' }, createdAt: 1, updatedAt: 1,
    }],
    ['invalid terminal receipt', {
      agentId: 'codex', runId: 'run-1', clientRequestId: 'legacy-1', payloadHash: HASH,
      state: 'terminal', receipt: { status: 'bogus' }, createdAt: 1, updatedAt: 1,
    }],
  ])('rejects invalid v2 legacySends item: %s', (_name, legacySend) => {
    expect(() => parseConversationState({
      ...state(), legacySends: [legacySend],
    })).toThrow();
  });

  it.each([
    ['missing identity', { state: 'dispatching' }],
    ['dispatching with receipt', {
      agentId: 'codex', runId: 'run-1', clientRequestId: 'legacy-1', payloadHash: HASH,
      state: 'dispatching', receipt: { status: 'accepted' }, createdAt: 1, updatedAt: 1,
    }],
    ['terminal with malformed receipt', {
      agentId: 'codex', runId: 'run-1', clientRequestId: 'legacy-1', payloadHash: HASH,
      state: 'terminal', receipt: { status: 'bogus' }, createdAt: 1, updatedAt: 1,
    }],
  ])('rejects invalid v1 sends item before migration: %s', (_name, legacySend) => {
    expect(() => parseConversationState({ version: 1, sends: [legacySend] })).toThrow();
  });

  it.each([
    ['migrations', { migrations: 'invalid' }],
    ['legacy migration marker', { migrations: { legacyCodexOutboxImported: 7 } }],
  ])('rejects a non-object %s field', (_name, overrides) => {
    expect(() => parseConversationState({ ...state(), ...overrides })).toThrow();
  });

  it.each(['accepted', 'unknown', 'observed'])('accepts a writer-reachable complete %s steer record', (status) => {
    expect(() => parseConversationState(state([submission({
      state: status, dispatchOrigin: 'steer', steerActionId: 'action-1', steerBaseRevision: 1,
      steerAnchor: { viewId: 'view-1' }, steerDispatchPlan: {
        kind: 'steer-active-turn', activityEpoch: 'run-1', activityRevision: 2,
        nativeTurnId: 'turn-1',
      },
    })]))).not.toThrow();
  });

  it.each(['closed', 'awaiting_idle', 'unknown'])('accepts closedIdleRevision on writer-reachable %s cycle', (status) => {
    const overrides = status === 'closed'
      ? { closedIdleRevision: 2 }
      : status === 'awaiting_idle'
        ? { state: status, revision: 1, nonIdleRevision: 2, closedIdleRevision: 1 }
        : { state: status, revision: 1, closedIdleRevision: 2 };
    expect(() => parseConversationState(state([], [cycle(overrides)], 2))).not.toThrow();
  });

  it('accepts valid queued, active, steer, settled, cycle, and legacy records', () => {
    const plan = {
      kind: 'steer-active-turn', activityEpoch: 'run-1', activityRevision: 2,
      nativeTurnId: 'turn-1',
    };
    const parsed = parseConversationState(state([
      submission(),
      submission({ clientRequestId: 'request-2', state: 'dispatching', revision: 2,
        dispatchOrigin: 'direct', queueOrderKey: undefined, lastRunId: 'run-1' }),
      submission({ clientRequestId: 'request-3', state: 'steering', revision: 3,
        dispatchOrigin: 'steer', steerActionId: 'action-1', steerBaseRevision: 1,
        steerAnchor: { viewId: 'view-1' }, steerDispatchPlan: plan, lastRunId: 'run-1' }),
      submission({ clientRequestId: 'request-4', state: 'accepted', revision: 4,
        dispatchOrigin: 'queue', lastRunId: 'run-1' }),
      submission({ clientRequestId: 'request-5', state: 'unknown', revision: 5,
        dispatchOrigin: 'direct', queueOrderKey: undefined, lastRunId: 'run-1' }),
      submission({ clientRequestId: 'request-6', state: 'observed', revision: 6,
        queueOrderKey: undefined, nativeId: 'turn-6' }),
    ], [
      cycle({ state: 'awaiting_idle', revision: 6, ownerSubmissionId: 'request-4',
        nonIdleRevision: 2 }),
    ], 6));
    expect(parsed.submissions).toHaveLength(3);
    expect(parsed.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'request-3', status: 'unknown' }),
      expect.objectContaining({ clientRequestId: 'request-4', payloadHash: HASH }),
      expect.objectContaining({
        clientRequestId: 'request-6', payloadHash: HASH, canonicalObservedAt: 1,
      }),
    ]);
    expect(parsed.deliveryReceipts?.[0]).not.toHaveProperty('canonicalObservedAt');
    expect(parsed.cycles).toHaveLength(1);

    expect(parseConversationState({
      ...state(), legacySends: [{
        agentId: 'codex', runId: 'run-1', sessionId: 'thread-1',
        clientRequestId: 'legacy-1', payloadHash: HASH, state: 'terminal',
        receipt: { status: 'accepted', nativeId: 'turn-1' },
        createdAt: 1, updatedAt: 1, expiresAt: 2,
      }],
    }).legacySends).toHaveLength(1);
  });

  it('sanitizes old terminal prompt bodies and preserves body-free idempotency receipts', () => {
    const parsed = parseConversationState(state([
      submission({ clientRequestId: 'accepted-1', text: 'private accepted prompt', state: 'accepted',
        dispatchOrigin: 'direct', queueOrderKey: undefined }),
      submission({ clientRequestId: 'observed-1', text: 'private observed prompt', state: 'observed',
        queueOrderKey: undefined, revision: 2 }),
    ], [], 2));

    expect(parsed.submissions).toEqual([]);
    expect(parsed.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'accepted-1' }),
      expect.objectContaining({ clientRequestId: 'observed-1', canonicalObservedAt: 1 }),
    ]);
    expect(parsed.deliveryReceipts?.[0]).not.toHaveProperty('canonicalObservedAt');
    expect(JSON.stringify(parsed.deliveryReceipts)).not.toContain('private accepted prompt');
    expect(JSON.stringify(parsed.deliveryReceipts)).not.toContain('private observed prompt');
  });

  it('rejects an active submission that conflicts with a settled receipt in the same scope', () => {
    expect(() => parseConversationState({
      ...state([submission({ state: 'dispatching', dispatchOrigin: 'direct', queueOrderKey: undefined })]),
      deliveryReceipts: [{
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'request-1',
        payloadHash: HASH, acceptedAt: 1, expiresAt: 2,
      }],
    })).toThrow(/conflicts with delivery receipt/);
  });

  it('retires an observed owner without leaving an invalid active cycle reference', () => {
    const parsed = parseConversationState(state([
      submission({ clientRequestId: 'observed-owner', state: 'observed', queueOrderKey: undefined }),
    ], [cycle({
      state: 'dispatching', revision: 2, ownerSubmissionId: 'observed-owner',
    })], 2));

    expect(parsed.submissions).toEqual([]);
    expect(parsed.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'observed-owner', canonicalObservedAt: 1 }),
    ]);
    expect(parsed.cycles).toEqual([expect.objectContaining({ state: 'unknown' })]);
    expect(parsed.cycles[0]).not.toHaveProperty('ownerSubmissionId');
  });
});
