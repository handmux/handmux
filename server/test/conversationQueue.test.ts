import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { migrateLegacyCodexOutbox } from '../src/agent-runtime/migrateLegacyCodexOutbox.js';
import {
  FileConversationStateStore,
  MemoryConversationStateStore,
} from '../src/agent-runtime/conversationStore.js';
import type {
  AgentConversationAdapterV1,
  ConversationActivitySnapshot,
  ConversationDispatchReceipt,
  ConversationItem,
} from '../src/agent-runtime/conversationTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

async function harness(options: {
  activity?: ConversationActivitySnapshot;
  prompt?: () => Promise<ConversationDispatchReceipt>;
  steer?: () => Promise<ConversationDispatchReceipt>;
  pageItems?: ConversationItem[];
  readPage?: AgentConversationAdapterV1['readNativePage'];
  discoverNative?: AgentConversationAdapterV1['discoverNative'];
  activityReads?: ConversationActivitySnapshot[];
  activityRead?: (
    current: ConversationActivitySnapshot,
    store: MemoryConversationStateStore,
  ) => ConversationActivitySnapshot;
} = {}) {
  const runs = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const lease = await runs.controller('test', async () => true).attach({
    paneId: '%1', attachmentId: 'attachment', sessionId: 'session-1', process: { pid: 101 },
  });
  let activity = options.activity ?? {
    activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
  } as ConversationActivitySnapshot;
  const activityReads = [...(options.activityReads ?? [])];
  const store = new MemoryConversationStateStore();
  const dispatchPrompt = vi.fn<NonNullable<AgentConversationAdapterV1['dispatchPrompt']>>(
    async () => options.prompt ? options.prompt() : { outcome: 'accepted' },
  );
  const dispatchSteer = options.steer
    ? vi.fn<NonNullable<AgentConversationAdapterV1['dispatchSteer']>>(options.steer)
    : undefined;
  let tokenSequence = 0;
  const adapter: AgentConversationAdapterV1 = {
    apiVersion: 1,
    async discoverNative(target) {
      if (options.discoverNative) return options.discoverNative(target);
      return {
        session: { agentId: 'test', sessionId: target.sessionId! },
        ...('runId' in target ? { run: target } : {}), sourceViewId: 'view',
        capabilities: {
          history: true, live: 'poll', ...('runId' in target ? {
            sendable: true as const, ...(dispatchSteer ? { steer: true as const } : {}),
          } : {}),
        },
      };
    },
    async readNativePage(session, request) {
      if (options.readPage) return options.readPage(session, request);
      return {
        sessionId: session.sessionId, sourceViewId: 'view', sourceHistoryToken: 'history',
        items: structuredClone(options.pageItems ?? []), hasMore: false,
      };
    },
    dispatchPrompt,
    ...(dispatchSteer ? { dispatchSteer } : {}),
  };
  const service = new ConversationService({
    runs, adapters: { test: adapter }, store,
    activitySource: { read: async () => structuredClone(options.activityRead
      ? options.activityRead(activity, store) : activityReads.shift() ?? activity) },
    newToken: () => `action-token-${++tokenSequence}`,
  });
  return {
    service, lease, runs, store, dispatchPrompt, dispatchSteer,
    setActivity(next: ConversationActivitySnapshot) { activity = next; },
  };
}

describe('Conversation Core public queue', () => {
  it.each([
    ['null', async () => null],
    ['throw', async () => { throw new Error('provider discovery failed'); }],
    ['invalid', async () => ({ invalid: true } as never)],
    ['session mismatch', async (target) => ({
      session: { agentId: 'test', sessionId: 'another-session' },
      ...('runId' in target ? { run: target } : {}),
      sourceViewId: 'view',
      capabilities: {
        history: true as const, live: 'poll' as const,
        sendable: true as const, steer: true as const,
      },
    })],
  ] satisfies Array<[string, AgentConversationAdapterV1['discoverNative']]>)
  ('keeps Queue usable with canSteer false when capability discovery returns %s', async (
    _name,
    discoverNative,
  ) => {
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 1, epoch: 'run-1',
      },
      steer: async () => ({ outcome: 'accepted' }),
      discoverNative,
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-probe-failure', text: 'keep queued', delivery: 'prompt',
    });

    await expect(h.service.queueSnapshot(h.lease)).resolves.toMatchObject({
      canSteer: false, canEdit: true, canRemove: true,
      items: [{ id: 'request-probe-failure', text: 'keep queued', state: 'queued' }],
      submissions: [], settled: [],
    });
  });

  it('queues every ordinary busy send without calling the Adapter', async () => {
    const h = await harness({
      activity: { activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' }, revision: 1, epoch: 'run-1' },
    });
    const result = await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'later', delivery: 'prompt',
    });
    expect(result).toMatchObject({ status: 'queued', submission: { id: 'request-1', state: 'queued' } });
    expect(h.dispatchPrompt).not.toHaveBeenCalled();
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({
      activity: 'working', items: [{ id: 'request-1', text: 'later', state: 'queued' }],
    });
  });

  it('durably claims an idle direct send and makes retries query-only', async () => {
    const h = await harness({ prompt: async () => ({ outcome: 'accepted', nativeId: 'turn-1' }) });
    const request = { clientRequestId: 'request-1', text: 'now', delivery: 'prompt' as const };
    const first = await h.service.send(h.lease, request);
    expect(first).toEqual({ status: 'accepted', nativeId: 'turn-1' });
    expect(await h.service.send(h.lease, request)).toEqual(first);
    expect(h.dispatchPrompt).toHaveBeenCalledOnce();
    expect(h.service.querySubmission(h.lease, 'request-1')).toEqual(first);
    const persisted = JSON.stringify(h.store.load());
    expect(persisted).not.toContain('"text":"now"');
    expect(h.store.load()).toMatchObject({
      submissions: [],
      deliveryReceipts: [{ clientRequestId: 'request-1', nativeId: 'turn-1' }],
    });
  });

  it('writes no accepted prompt body to the on-disk ledger', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-accepted-privacy-'));
    temporary.push(directory);
    const file = path.join(directory, 'conversation-state.json');
    const runs = new AgentRunRuntime({ newRunId: () => 'run-disk' });
    const lease = await runs.controller('test', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-disk', process: { pid: 101 },
    });
    const service = new ConversationService({
      runs,
      adapters: { test: {
        apiVersion: 1,
        discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: async () => ({ outcome: 'accepted', nativeId: 'turn-disk' }),
      } },
      store: new FileConversationStateStore(file),
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-disk',
      }) },
    });

    await service.send(lease, {
      clientRequestId: 'request-disk', text: 'never persist this accepted body', delivery: 'prompt',
    });
    const disk = fs.readFileSync(file, 'utf8');
    expect(disk).not.toContain('never persist this accepted body');
    expect(JSON.parse(disk)).toMatchObject({
      submissions: [],
      deliveryReceipts: [{ clientRequestId: 'request-disk', nativeId: 'turn-disk' }],
    });
  });

  it('rewrites old terminal and steer bodies into identity-only receipts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-old-terminal-privacy-'));
    temporary.push(directory);
    const file = path.join(directory, 'conversation-state.json');
    const base = {
      agentId: 'test', sessionId: 'session-old', revision: 1,
      createdAt: 1, updatedAt: 1,
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 2, ledgerRevision: 3, cycles: [], legacySends: [], submissions: [
        { ...base, clientRequestId: 'accepted-old', text: 'old accepted private body',
          payloadHash: createHash('sha256').update('old accepted private body').digest('hex'),
          state: 'accepted', dispatchOrigin: 'direct' },
        { ...base, clientRequestId: 'observed-old', text: 'old observed private body',
          payloadHash: createHash('sha256').update('old observed private body').digest('hex'),
          state: 'observed', revision: 2 },
        { ...base, clientRequestId: 'steer-old', text: 'old steer private body',
          payloadHash: createHash('sha256').update('old steer private body').digest('hex'),
          state: 'unknown', revision: 3, dispatchOrigin: 'steer',
          queueOrderKey: '0000000000000001:0000000000000003',
          steerActionId: 'steer-action-old', steerBaseRevision: 1,
          steerAnchor: { viewId: 'view-old', afterItemId: 'item-old' },
          steerDispatchPlan: {
            kind: 'steer-active-turn', activityEpoch: 'run-old', activityRevision: 2,
            nativeTurnId: 'turn-old',
          } },
      ],
    }));
    const runs = new AgentRunRuntime({ newRunId: () => 'run-old' });
    const lease = await runs.controller('test', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-old', process: { pid: 101 },
    });
    const dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const service = new ConversationService({
      runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); }, dispatchPrompt,
      } },
      store: new FileConversationStateStore(file),
      now: () => 2,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-old',
      }) },
    });

    const disk = fs.readFileSync(file, 'utf8');
    expect(disk).not.toContain('old accepted private body');
    expect(disk).not.toContain('old observed private body');
    expect(disk).not.toContain('old steer private body');
    const persisted = JSON.parse(disk);
    expect(persisted.submissions).toEqual([]);
    expect(persisted.deliveryReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientRequestId: 'accepted-old' }),
      expect.objectContaining({ clientRequestId: 'observed-old', canonicalObservedAt: 1 }),
      expect.objectContaining({ clientRequestId: 'steer-old', status: 'unknown' }),
    ]));
    expect((await service.queueSnapshot(lease)).settled).toEqual([
      { id: 'accepted-old' }, { id: 'observed-old' },
    ]);
    expect((await service.queueSnapshot(lease)).submissions).toEqual([]);
    expect(service.querySubmission(lease, 'steer-old', 'steer-action-old')).toMatchObject({
      status: 'unknown', nativeMutation: 'unknown',
    });
    expect(service.querySubmission(lease, 'steer-old', 'steer-action-old'))
      .not.toHaveProperty('submission');
    await expect(service.send(lease, {
      clientRequestId: 'accepted-old', text: 'old accepted private body', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted' });
    await expect(service.send(lease, {
      clientRequestId: 'observed-old', text: 'old observed private body', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted' });
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it('prunes expired receipts, caps idempotency tombstones, and allows an expired id to dispatch', async () => {
    const now = 10_000;
    const store = new MemoryConversationStateStore();
    const receipts = Array.from({ length: 4_100 }, (_, index) => ({
      agentId: 'test', sessionId: 'session-prune', clientRequestId: `request-${index}`,
      payloadHash: createHash('sha256').update(`text-${index}`).digest('hex'),
      acceptedAt: index + 1, expiresAt: now + 1_000,
    }));
    receipts.push({
      agentId: 'test', sessionId: 'session-prune', clientRequestId: 'request-expired',
      payloadHash: createHash('sha256').update('retry me').digest('hex'),
      acceptedAt: 0, expiresAt: now - 1,
    });
    store.save({
      version: 2, ledgerRevision: 0, submissions: [], deliveryReceipts: receipts,
      cycles: [], legacySends: [],
    });
    const runs = new AgentRunRuntime({ newRunId: () => 'run-prune' });
    const lease = await runs.controller('test', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-prune', process: { pid: 101 },
    });
    const dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const service = new ConversationService({
      runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); }, dispatchPrompt,
      } },
      store, now: () => now,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-prune',
      }) },
    });

    expect((store.load() as { deliveryReceipts: unknown[] }).deliveryReceipts).toHaveLength(4_096);
    await expect(service.send(lease, {
      clientRequestId: 'request-expired', text: 'retry me', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted' });
    expect(dispatchPrompt).toHaveBeenCalledOnce();
  });

  it('retains unobserved receipts ahead of newer observed tombstones at storage and snapshot caps', async () => {
    const now = 20_000;
    const store = new MemoryConversationStateStore();
    const observed = Array.from({ length: 4_095 }, (_, index) => ({
      agentId: 'test', sessionId: 'session-priority', clientRequestId: `observed-${index}`,
      payloadHash: createHash('sha256').update(`observed-${index}`).digest('hex'),
      canonicalObservedAt: index + 1,
      acceptedAt: 10_000 + index,
      expiresAt: now + 1_000,
    }));
    const accepted = [1, 2].map((acceptedAt) => ({
      agentId: 'test', sessionId: 'session-priority', clientRequestId: `accepted-${acceptedAt}`,
      payloadHash: createHash('sha256').update(`accepted-${acceptedAt}`).digest('hex'),
      acceptedAt,
      expiresAt: now + 1_000,
    }));
    store.save({
      version: 2, ledgerRevision: 0, submissions: [],
      deliveryReceipts: [...observed, ...accepted], cycles: [], legacySends: [],
    });
    const runs = new AgentRunRuntime({ newRunId: () => 'run-priority' });
    const lease = await runs.controller('test', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-priority', process: { pid: 101 },
    });
    const service = new ConversationService({
      runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: async () => ({ outcome: 'accepted' }),
      } },
      store, now: () => now,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-priority',
      }) },
    });

    const retained = (store.load() as { deliveryReceipts: Array<{
      clientRequestId: string; canonicalObservedAt?: number;
    }> }).deliveryReceipts;
    expect(retained).toHaveLength(4_096);
    expect(retained.slice(0, 2).map((receipt) => receipt.clientRequestId)).toEqual([
      'accepted-2', 'accepted-1',
    ]);
    expect(retained.filter((receipt) => receipt.canonicalObservedAt === undefined)).toHaveLength(2);

    const snapshot = await service.queueSnapshot(lease);
    expect(snapshot.settled).toHaveLength(1_000);
    expect(snapshot.settled.slice(0, 3)).toEqual([
      { id: 'accepted-2' }, { id: 'accepted-1' }, { id: 'observed-4094' },
    ]);
  });

  it('closes a retired accepted owner on idle startup and continues draining its Queue', async () => {
    const store = new MemoryConversationStateStore();
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    store.save({
      version: 2, ledgerRevision: 2, legacySends: [],
      submissions: [{
        agentId: 'test', sessionId: 'session-restart', clientRequestId: 'accepted-old',
        text: 'private old body', payloadHash: hash('private old body'), state: 'accepted' as never,
        dispatchOrigin: 'direct', revision: 1, createdAt: 1, updatedAt: 1,
      }, {
        agentId: 'test', sessionId: 'session-restart', clientRequestId: 'queued-next',
        text: 'continue queue', payloadHash: hash('continue queue'), state: 'queued', revision: 2,
        queueOrderKey: '0000000000000002:0000000000000002', createdAt: 2, updatedAt: 2,
      }],
      cycles: [{
        agentId: 'test', sessionId: 'session-restart', state: 'dispatching', revision: 2,
        ownerSubmissionId: 'accepted-old', activityEpoch: 'run-restart', baselineRevision: 1,
      }],
    });
    const runs = new AgentRunRuntime({ newRunId: () => 'run-restart' });
    const lease = await runs.controller('test', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-restart', process: { pid: 101 },
    });
    const dispatchPrompt = vi.fn<NonNullable<AgentConversationAdapterV1['dispatchPrompt']>>(
      async () => ({ outcome: 'accepted' }),
    );
    const service = new ConversationService({
      runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); }, dispatchPrompt,
      } },
      store, now: () => 100,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-restart',
      }) },
    });

    await service.queueSnapshot(lease);
    await vi.waitFor(() => expect(dispatchPrompt).toHaveBeenCalledOnce());
    expect(dispatchPrompt.mock.calls[0]?.[1]).toMatchObject({ text: 'continue queue' });
    expect(JSON.stringify(store.load())).not.toContain('private old body');
  });

  it('moves a no-mutation busy race to Queue and does not retry stale idle', async () => {
    const h = await harness({ prompt: async () => ({ outcome: 'busy', nativeMutation: false }) });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'race', delivery: 'prompt',
    })).toMatchObject({ status: 'queued', submission: { state: 'queued' } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(h.dispatchPrompt).toHaveBeenCalledOnce();
  });

  it('blocks automatic replay after a definitive Queue rejection', async () => {
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-0' },
        revision: 1, epoch: 'run-1',
      },
      prompt: async () => ({
        outcome: 'rejected', nativeMutation: false, reason: 'provider_rejected',
      }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'do once', delivery: 'prompt',
    });
    h.setActivity({ activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-1' });
    await h.service.queueSnapshot(h.lease);
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.dispatchPrompt).toHaveBeenCalledOnce();
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({
      items: [{ state: 'queued', autoDispatchBlockedReason: 'provider_rejected' }],
    });
  });

  it('keeps canonical observation authoritative when it arrives before a busy receipt', async () => {
    let settle!: (receipt: ConversationDispatchReceipt) => void;
    const h = await harness({
      prompt: async () => new Promise<ConversationDispatchReceipt>((resolve) => { settle = resolve; }),
      pageItems: [{
        id: 'native-user-1', sessionId: 'session-1', kind: 'message', role: 'user',
        status: 'complete', correlationId: 'request-1', content: [{ type: 'text', text: 'once' }],
      }],
    });
    const sending = h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'once', delivery: 'prompt',
    });
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' },
      { limit: 20 },
    );
    settle({ outcome: 'busy', nativeMutation: false });
    expect(await sending).toEqual({ status: 'accepted', nativeId: 'native-user-1' });
    expect(h.service.querySubmission(h.lease, 'request-1')).toEqual({
      status: 'accepted', nativeId: 'native-user-1',
    });
  });

  it.each([
    { name: 'busy', receipt: { outcome: 'busy', nativeMutation: false } },
    {
      name: 'rejected',
      receipt: { outcome: 'rejected', nativeMutation: false, reason: 'provider_rejected' },
    },
    {
      name: 'unknown',
      receipt: { outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed' },
    },
  ] satisfies Array<{ name: string; receipt: ConversationDispatchReceipt }>)
  ('keeps canonical steer ownership ahead of a late $name receipt', async ({ receipt }) => {
    let settle!: (value: ConversationDispatchReceipt) => void;
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => new Promise<ConversationDispatchReceipt>((resolve) => { settle = resolve; }),
      pageItems: [{
        id: 'native-user-1', sessionId: 'session-1', kind: 'message', role: 'user',
        status: 'complete', correlationId: 'request-1', content: [{ type: 'text', text: 'guide' }],
      }],
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    const steering = h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    });
    await vi.waitFor(() => expect(h.dispatchSteer).toHaveBeenCalledOnce());

    await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' },
      { limit: 20 },
    );
    settle(receipt);

    const result = await steering;
    expect(result).toMatchObject({
      actionId: 'steer-1', result: 'accepted', nativeMutation: true,
    });
    expect(result).not.toHaveProperty('submission');
    expect(h.service.querySubmission(h.lease, 'request-1', 'steer-1')).toEqual({
      status: 'accepted', nativeId: 'native-user-1',
    });
    await expect(h.service.queueSnapshot(h.lease)).resolves.toMatchObject({
      items: [], submissions: [], settled: [{ id: 'request-1', nativeId: 'native-user-1' }],
    });
    const persisted = h.store.load();
    expect(persisted).toMatchObject({
      submissions: [],
      deliveryReceipts: [{
        clientRequestId: 'request-1', status: 'accepted', nativeId: 'native-user-1',
        canonicalObservedAt: expect.any(Number),
      }],
    });
    expect(JSON.stringify(persisted)).not.toContain('guide');
  });

  it.each([
    { name: 'busy', receipt: { outcome: 'busy', nativeMutation: false } },
    {
      name: 'unknown',
      receipt: { outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed' },
    },
  ] satisfies Array<{ name: string; receipt: ConversationDispatchReceipt }>)
  ('does not reopen a completed fallback cycle for a late $name steer receipt', async ({ receipt }) => {
    let settleSteer!: (value: ConversationDispatchReceipt) => void;
    let promptCalls = 0;
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-before' },
        revision: 1, epoch: 'run-1', completionToken: 'completed:0',
      },
      prompt: async () => {
        promptCalls += 1;
        return promptCalls === 1
          ? { outcome: 'rejected', nativeMutation: false, reason: 'provider_rejected' }
          : { outcome: 'accepted', nativeId: 'turn-next' };
      },
      steer: async () => new Promise<ConversationDispatchReceipt>((resolve) => {
        settleSteer = resolve;
      }),
      pageItems: [{
        id: 'native-user-steer', sessionId: 'session-1', kind: 'message', role: 'user',
        status: 'complete', correlationId: 'request-steer',
        content: [{ type: 'text', text: 'guide fallback' }],
      }],
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-steer', text: 'guide fallback', delivery: 'prompt',
    });
    h.setActivity({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-1',
      completionToken: 'completed:0',
    });
    await h.service.queueSnapshot(h.lease);
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.service.querySubmission(h.lease, 'request-steer'))
      .toMatchObject({ status: 'queued', submission: { autoDispatchBlockedReason: 'provider_rejected' } }));
    const revision = h.service.querySubmission(h.lease, 'request-steer').submission?.revision;
    expect(revision).toBeTypeOf('number');

    const steering = h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-steer', actionId: 'steer-fallback',
      baseRevision: revision, anchor: { viewId: 'view-1' },
    });
    await vi.waitFor(() => expect(h.dispatchSteer).toHaveBeenCalledOnce());
    expect(h.dispatchSteer).toHaveBeenCalledWith(h.lease, expect.objectContaining({
      plan: expect.objectContaining({ kind: 'start-turn-fallback' }),
    }));
    await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' },
      { limit: 20 },
    );

    h.setActivity({
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-fallback' },
      revision: 3, epoch: 'run-1', completionToken: 'completed:0',
    });
    await h.service.queueSnapshot(h.lease);
    h.setActivity({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 4, epoch: 'run-1',
      completionToken: 'completed:1',
    });
    await h.service.queueSnapshot(h.lease);
    expect(h.store.load()).toMatchObject({
      cycles: [{ state: 'closed', closedIdleRevision: 4 }],
    });

    settleSteer(receipt);
    await expect(steering).resolves.toMatchObject({
      actionId: 'steer-fallback', result: 'accepted', nativeMutation: true,
    });
    expect(h.store.load()).toMatchObject({
      submissions: [],
      cycles: [{ state: 'closed', closedIdleRevision: 4 }],
      deliveryReceipts: [{
        clientRequestId: 'request-steer', status: 'accepted',
        canonicalObservedAt: expect.any(Number),
      }],
    });
    expect(JSON.stringify(h.store.load())).not.toContain('guide fallback');

    await expect(h.service.send(h.lease, {
      clientRequestId: 'request-next', text: 'next', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted', nativeId: 'turn-next' });
    expect(h.dispatchPrompt).toHaveBeenCalledTimes(2);
  });

  it('keeps a body-free tombstone across restart when canonical wins before the HTTP receipt', async () => {
    const h = await harness({
      prompt: async () => new Promise<ConversationDispatchReceipt>(() => {}),
      pageItems: [{
        id: 'native-user-1', sessionId: 'session-1', kind: 'message', role: 'user',
        status: 'complete', correlationId: 'request-1', content: [{ type: 'text', text: 'once' }],
      }],
    });
    void h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'once', delivery: 'prompt',
    });
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    await h.service.readPage({ agentId: 'test', sessionId: 'session-1' }, { limit: 20 });
    expect(JSON.stringify(h.store.load())).not.toContain('"text":"once"');
    expect((await h.service.queueSnapshot(h.lease)).settled).toEqual([
      { id: 'request-1', nativeId: 'native-user-1' },
    ]);

    const restartedDispatch = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const restarted = new ConversationService({
      runs: h.runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: restartedDispatch,
      } },
      store: h.store,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-1',
      }) },
    });
    await expect(restarted.send(h.lease, {
      clientRequestId: 'request-1', text: 'once', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted', nativeId: 'native-user-1' });
    expect(restartedDispatch).not.toHaveBeenCalled();
  });

  it('claims the first uncorrelated same-text user occurrence after the dispatch baseline', async () => {
    const pageItems: ConversationItem[] = [{
      id: 'baseline-1', sessionId: 'session-1', kind: 'message', role: 'assistant',
      status: 'complete', content: [{ type: 'text', text: 'ready' }],
    }];
    const h = await harness({ pageItems });
    const baselinePage = await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' }, { limit: 20 },
    );
    if (baselinePage.status !== 'ok') throw new Error('expected baseline page');
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'same text', delivery: 'prompt',
    });
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({
      settled: [{ id: 'request-1' }],
    });
    pageItems.push({
      id: 'native-user-1', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    });
    await h.service.readPage({ agentId: 'test', sessionId: 'session-1' }, { limit: 20 });
    expect(h.service.querySubmission(h.lease, 'request-1')).toEqual({
      status: 'accepted', nativeId: 'native-user-1',
    });
  });

  it('keeps the latest occurrence frontier when history appends during an older-page read', async () => {
    let historyToken = 'history-1';
    const latest: ConversationItem[] = [{
      id: 'baseline-1', sessionId: 'session-1', kind: 'message', role: 'assistant',
      status: 'complete', content: [{ type: 'text', text: 'ready' }],
    }];
    const older: ConversationItem[] = [{
      id: 'historical-same-text', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    }];
    const h = await harness({
      readPage: async (session, request) => ({
        sessionId: session.sessionId, sourceViewId: 'view', sourceHistoryToken: historyToken,
        items: structuredClone(request.beforeSourceCursor
          ? older.slice(0, request.limit) : latest.slice(-request.limit)),
        ...(!request.beforeSourceCursor ? { previousSourceCursor: 'older-page' } : {}),
        hasMore: !request.beforeSourceCursor,
      }),
    });
    const first = await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' }, { limit: 20 },
    );
    if (first.status !== 'ok') throw new Error('expected latest page');
    if (!first.page.previousCursor) throw new Error('expected an older-page cursor');

    latest.push({
      id: 'pre-send-same-text', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    });
    historyToken = 'history-2';
    await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' },
      { limit: 20, before: first.page.previousCursor },
    );
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'same text', delivery: 'prompt',
    });

    latest.push({
      id: 'post-send-same-text', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    });
    historyToken = 'history-3';
    await h.service.readPage(
      { agentId: 'test', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(h.service.querySubmission(h.lease, 'request-1')).toEqual({
      status: 'accepted', nativeId: 'post-send-same-text',
    });
  });

  it('uses an exact native item id before occurrence fallback', async () => {
    const pageItems: ConversationItem[] = [];
    const h = await harness({
      pageItems,
      prompt: async () => ({ outcome: 'accepted', nativeId: 'native-user-1' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'original', delivery: 'prompt',
    });
    pageItems.push({
      id: 'native-user-1', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'provider normalized text' }],
    });
    await h.service.readPage({ agentId: 'test', sessionId: 'session-1' }, { limit: 20 });
    expect(h.service.querySubmission(h.lease, 'request-1')).toEqual({
      status: 'accepted', nativeId: 'native-user-1',
    });
  });

  it('preserves an activity cycle that completes before the accepted receipt', async () => {
    let settle!: (receipt: ConversationDispatchReceipt) => void;
    let calls = 0;
    const h = await harness({
      prompt: async () => {
        calls += 1;
        if (calls > 1) return { outcome: 'accepted' };
        return new Promise<ConversationDispatchReceipt>((resolve) => { settle = resolve; });
      },
    });
    const first = h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'first', delivery: 'prompt',
    });
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    h.setActivity({
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
      revision: 2, epoch: 'run-1',
    });
    await h.service.queueSnapshot(h.lease);
    h.setActivity({ activity: 'idle', activeTurn: { state: 'none' }, revision: 3, epoch: 'run-1' });
    await h.service.queueSnapshot(h.lease);
    settle({ outcome: 'accepted', nativeId: 'turn-1' });
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    await h.service.send(h.lease, {
      clientRequestId: 'request-2', text: 'second', delivery: 'prompt',
    });
    expect(h.dispatchPrompt).toHaveBeenCalledTimes(2);
  });

  it('drains FIFO after an idle completion token advances without an observed non-idle edge', async () => {
    const h = await harness({
      activity: {
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
        completionToken: 'completed:0',
      },
      prompt: async () => ({ outcome: 'accepted' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'first', delivery: 'prompt',
    });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-2', text: 'second', delivery: 'prompt',
    })).toMatchObject({ status: 'queued', submission: { id: 'request-2' } });
    expect(h.dispatchPrompt).toHaveBeenCalledTimes(1);

    h.setActivity({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-1',
      completionToken: 'completed:1',
    });
    await h.service.queueSnapshot(h.lease);
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledTimes(2));
    expect(h.dispatchPrompt.mock.calls.map((call) => call[1].text)).toEqual(['first', 'second']);
  });

  it('does not keep polling Activity for an accepted submission after its cycle closes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const h = await harness({
      activity: {
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
        completionToken: 'completed:1',
      },
      activityRead: (current) => {
        reads += 1;
        return reads <= 2 ? { ...current, completionToken: 'completed:0' } : current;
      },
      prompt: async () => ({ outcome: 'accepted' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-accepted', text: 'done', delivery: 'prompt',
    });
    await vi.advanceTimersByTimeAsync(1);
    const settledReads = reads;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toBe(settledReads);
  });

  it('rechecks ordinary prompt activity immediately before native mutation', async () => {
    const idle = {
      activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
    } as const;
    const working = {
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'external-turn' },
      revision: 2, epoch: 'run-1',
    } as const;
    const h = await harness({ activity: working, activityReads: [idle, working, working] });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'do not race', delivery: 'prompt',
    })).toMatchObject({ status: 'queued', nativeMutation: false, submission: { state: 'queued' } });
    expect(h.dispatchPrompt).not.toHaveBeenCalled();
  });

  it('exposes steer only as an explicit queue action and binds query to its action id', async () => {
    const h = await harness({
      activity: { activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' }, revision: 2, epoch: 'run-1' },
      steer: async () => ({ outcome: 'accepted', nativeId: 'turn-1' }),
    });
    await h.service.send(h.lease, { clientRequestId: 'request-1', text: 'guide', delivery: 'prompt' });
    const result = await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1',
      baseRevision: 1,
      anchor: { viewId: 'view-1', afterItemId: 'item-1' },
    });
    expect(result).toMatchObject({
      actionId: 'steer-1', result: 'accepted', nativeMutation: true,
    });
    expect(h.dispatchPrompt).not.toHaveBeenCalled();
    expect(h.dispatchSteer).toHaveBeenCalledOnce();
    expect(h.dispatchSteer).toHaveBeenCalledWith(h.lease, expect.objectContaining({
      anchor: { viewId: 'view-1', afterItemId: 'item-1' },
    }));
    expect(h.service.querySubmission(h.lease, 'request-1', 'steer-1')).toMatchObject({ status: 'accepted' });
    expect(h.service.querySubmission(h.lease, 'request-1', 'another')).toMatchObject({
      status: 'rejected', reason: 'conflict', conflict: 'action_id_mismatch',
    });
    await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1',
      baseRevision: 1,
      anchor: { viewId: 'view-1', afterItemId: 'item-1' },
    });
    expect(h.dispatchSteer).toHaveBeenCalledOnce();
  });

  it('returns a definitive steer rejection to the original Queue owner without replay', async () => {
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => ({ outcome: 'rejected', nativeMutation: false, reason: 'provider_rejected' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    const request = {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1',
      baseRevision: 1,
      anchor: { viewId: 'view-1', afterItemId: 'item-1' },
    };
    expect(await h.service.queueAction(h.lease, request)).toMatchObject({
      result: 'rejected', nativeMutation: false,
      submission: { state: 'queued' },
    });
    expect(h.service.querySubmission(h.lease, 'request-1', 'steer-1')).toMatchObject({
      status: 'rejected', nativeMutation: false, submission: { state: 'queued' },
    });
    await h.service.queueAction(h.lease, request);
    expect(h.dispatchSteer).toHaveBeenCalledOnce();
  });

  it('rejects stale steer CAS payloads before native mutation', async () => {
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => ({ outcome: 'accepted' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    await expect(h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
    })).resolves.toMatchObject({ result: 'rejected', nativeMutation: false });
    await expect(h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 99,
      anchor: { viewId: 'view-1' },
    })).resolves.toMatchObject({ result: 'rejected', nativeMutation: false });
    expect(h.dispatchSteer).not.toHaveBeenCalled();

    await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    });
    await expect(h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
      anchor: { viewId: 'different-view' },
    })).resolves.toMatchObject({ result: 'rejected', nativeMutation: false });
    expect(h.dispatchSteer).toHaveBeenCalledOnce();
  });

  it('rechecks a steer plan immediately before native mutation', async () => {
    const planning = {
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
      revision: 2, epoch: 'run-1',
    } as const;
    const changed = { ...planning, revision: 3 } as const;
    const h = await harness({
      activity: changed,
      activityRead: (_current, store) => {
        const state = store.load() as {
          deliveryReceipts?: Array<{ status?: string }>;
        } | null;
        return state?.deliveryReceipts?.some((item) => item.status === 'dispatching')
          ? changed : planning;
      },
      steer: async () => ({ outcome: 'accepted' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    expect(await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    })).toMatchObject({ result: 'rejected', nativeMutation: false });
    expect(h.dispatchSteer).not.toHaveBeenCalled();
  });

  it('allows a new steer action after definitive rejection and preserves the old action receipt', async () => {
    let calls = 0;
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => (++calls === 1
        ? { outcome: 'rejected', nativeMutation: false, reason: 'provider_rejected' }
        : { outcome: 'accepted', nativeId: 'turn-1' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-old', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    });
    const rejected = h.service.querySubmission(h.lease, 'request-1', 'steer-old');
    const revision = rejected.submission?.revision;
    expect(rejected).toMatchObject({ status: 'rejected', nativeMutation: false });
    expect(revision).toBeTypeOf('number');

    expect(await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-new', baseRevision: revision,
      anchor: { viewId: 'view-1' },
    })).toMatchObject({ result: 'accepted' });
    expect(h.dispatchSteer).toHaveBeenCalledTimes(2);
    expect(h.service.querySubmission(h.lease, 'request-1', 'steer-old')).toMatchObject({
      status: 'rejected', nativeMutation: false,
    });
  });

  it('allows a new steer action after a no-mutation busy result and preserves the old action receipt', async () => {
    let calls = 0;
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => (++calls === 1
        ? { outcome: 'busy', nativeMutation: false }
        : { outcome: 'accepted', nativeId: 'turn-1' }),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-busy', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    });
    const busy = h.service.querySubmission(h.lease, 'request-1', 'steer-busy');
    const revision = busy.submission?.revision;
    expect(busy).toMatchObject({
      status: 'rejected', nativeMutation: false, submission: { state: 'queued' },
    });
    expect(revision).toBeTypeOf('number');

    expect(await h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-new', baseRevision: revision,
      anchor: { viewId: 'view-1' },
    })).toMatchObject({ result: 'accepted' });
    expect(h.dispatchSteer).toHaveBeenCalledTimes(2);
    expect(h.service.querySubmission(h.lease, 'request-1', 'steer-busy')).toMatchObject({
      status: 'rejected', nativeMutation: false,
    });
  });

  it('restores v1 dispatching as unknown and removes terminal accepted receipts', async () => {
    const h = await harness();
    const hash = (text: string) => createHash('sha256').update(JSON.stringify({
      text, delivery: 'prompt',
    })).digest('hex');
    h.store.save({ version: 1, sends: [{
      agentId: 'test', runId: 'run-1', sessionId: 'session-1',
      clientRequestId: 'request-unknown', payloadHash: hash('uncertain'),
      state: 'dispatching', createdAt: 1, updatedAt: 1,
    }, {
      agentId: 'test', runId: 'run-1', sessionId: 'session-1',
      clientRequestId: 'request-accepted', payloadHash: hash('done'),
      state: 'terminal', receipt: { status: 'accepted', nativeId: 'turn-old' },
      createdAt: 2, updatedAt: 2,
    }] });
    const restored = new ConversationService({
      runs: h.runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: h.dispatchPrompt,
      } },
      store: h.store,
    });
    expect(restored.querySubmission(h.lease, 'request-unknown')).toMatchObject({
      status: 'unknown', reason: 'delivery_unconfirmed', nativeMutation: 'unknown',
    });
    expect(restored.querySubmission(h.lease, 'request-accepted')).toEqual({
      status: 'rejected', reason: 'invalid_request',
    });
    expect(h.store.load()).toMatchObject({
      version: 2,
      legacySends: [
        { clientRequestId: 'request-unknown', state: 'terminal', receipt: { status: 'unknown' } },
      ],
    });
  });

  it('recovers an in-flight dispatch as unknown without native redelivery', async () => {
    const h = await harness({ prompt: async () => new Promise<ConversationDispatchReceipt>(() => {}) });
    void h.service.send(h.lease, { clientRequestId: 'request-1', text: 'once', delivery: 'prompt' });
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    const restarted = new ConversationService({
      runs: h.runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: vi.fn(async () => ({ outcome: 'accepted' as const })),
      } },
      store: h.store,
    });
    expect(h.store.load()).toMatchObject({ version: 2, submissions: [{ state: 'unknown' }] });
    expect(restarted).toBeTruthy();
  });

  it('recovers an in-flight steer as unknown rather than accepted', async () => {
    const h = await harness({
      activity: {
        activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
        revision: 2, epoch: 'run-1',
      },
      steer: async () => new Promise<ConversationDispatchReceipt>(() => {}),
    });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'guide', delivery: 'prompt',
    });
    void h.service.queueAction(h.lease, {
      action: 'steer', itemId: 'request-1', actionId: 'steer-1', baseRevision: 1,
      anchor: { viewId: 'view-1' },
    });
    await vi.waitFor(() => expect(h.dispatchSteer).toHaveBeenCalledOnce());
    const persisted = h.store.load();
    expect(persisted).toMatchObject({
      version: 2,
      submissions: [],
      deliveryReceipts: [{
        clientRequestId: 'request-1', status: 'dispatching', steerActionId: 'steer-1',
      }],
    });
    expect(JSON.stringify(persisted)).not.toContain('guide');
    await expect(h.service.queueSnapshot(h.lease)).resolves.toMatchObject({
      items: [], submissions: [], settled: [],
    });
    const restarted = new ConversationService({
      runs: h.runs,
      adapters: { test: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); },
        dispatchPrompt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        dispatchSteer: vi.fn(async () => ({ outcome: 'accepted' as const })),
      } },
      store: h.store,
    });
    expect(restarted.querySubmission(h.lease, 'request-1', 'steer-1')).toMatchObject({
      status: 'unknown', nativeMutation: 'unknown',
    });
    expect(restarted.querySubmission(h.lease, 'request-1', 'steer-1')).not.toHaveProperty('submission');
  });
});

describe('legacy Codex outbox migration', () => {
  function writeLegacyQueue(file: string): void {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [{
        id: 'queue-1', requestId: 'request-1', text: 'preserve me', createdAt: 10,
      }] }],
      receipts: [{ pane: '%1', threadId: 'thread-1', requestId: 'request-1', text: 'preserve me',
        status: 'queued', queueItemId: 'queue-1', createdAt: 10, updatedAt: 10 }],
    }));
  }

  function writeLegacyAccepted(file: string): void {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, queues: [], receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'accepted-1',
        text: 'private accepted prompt', status: 'accepted', turnId: 'turn-1',
        createdAt: 10, updatedAt: 11,
      }],
    }));
  }

  function sameFile(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  it('fsyncs the Conversation directory before retiring the legacy source', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-order-'));
    temporary.push(directory);
    const legacyDirectory = path.join(directory, 'legacy');
    const conversationDirectory = path.join(directory, 'conversation');
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(conversationDirectory);
    const legacy = path.join(legacyDirectory, 'codex-outbox.json');
    const core = path.join(conversationDirectory, 'conversation-state.json');
    writeLegacyQueue(legacy);
    const conversationStat = fs.statSync(conversationDirectory);
    const events: string[] = [];
    const originalFsync = fs.fsyncSync;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && sameFile(stat, conversationStat)) events.push('conversation-directory-fsync');
      return originalFsync(descriptor);
    });
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === legacy && String(destination).includes('.imported.')) events.push('legacy-rename');
      return originalRename(source, destination);
    });
    try {
      migrateLegacyCodexOutbox(legacy, core, 20);
    } finally {
      fsync.mockRestore();
      rename.mockRestore();
    }
    expect(events).toContain('conversation-directory-fsync');
    expect(events.indexOf('conversation-directory-fsync')).toBeLessThan(events.indexOf('legacy-rename'));
  });

  it.each([
    'conversation-rename',
    'conversation-directory-fsync',
    'conversation-readback',
    'legacy-rename',
    'legacy-directory-fsync',
  ] as const)('recovers idempotently after a simulated crash at %s', (failurePoint) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `handmux-outbox-crash-${failurePoint}-`));
    temporary.push(directory);
    const legacyDirectory = path.join(directory, 'legacy');
    const conversationDirectory = path.join(directory, 'conversation');
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(conversationDirectory);
    const legacy = path.join(legacyDirectory, 'codex-outbox.json');
    const core = path.join(conversationDirectory, 'conversation-state.json');
    writeLegacyQueue(legacy);
    const conversationStat = fs.statSync(conversationDirectory);
    const legacyStat = fs.statSync(legacyDirectory);
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    const originalRead = fs.readFileSync;
    let failed = false;
    let legacyDirectoryFsyncs = 0;
    const crash = (): never => {
      failed = true;
      throw new Error(`simulated crash: ${failurePoint}`);
    };
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (!failed && stat.isDirectory() && sameFile(stat, conversationStat)
        && failurePoint === 'conversation-directory-fsync') crash();
      if (stat.isDirectory() && sameFile(stat, legacyStat)) {
        legacyDirectoryFsyncs += 1;
        if (!failed && failurePoint === 'legacy-directory-fsync' && legacyDirectoryFsyncs === 1) crash();
      }
      return originalFsync(descriptor);
    });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!failed && destination === core && failurePoint === 'conversation-rename') crash();
      if (!failed && source === legacy && String(destination).includes('.imported.')
        && failurePoint === 'legacy-rename') crash();
      return originalRename(source, destination);
    });
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (!failed && file === core && failurePoint === 'conversation-readback') crash();
      return Reflect.apply(originalRead, fs, [file, ...args]);
    }) as typeof fs.readFileSync);
    try {
      expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).toThrow(`simulated crash: ${failurePoint}`);
    } finally {
      fsync.mockRestore();
      rename.mockRestore();
      read.mockRestore();
    }

    expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).not.toThrow();
    const state = JSON.parse(fs.readFileSync(core, 'utf8'));
    expect(state.submissions.filter((item: { clientRequestId?: string }) => (
      item.clientRequestId === 'request-1'
    ))).toHaveLength(1);
    expect(state.migrations?.legacyCodexOutboxImported).toBeUndefined();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readdirSync(legacyDirectory).some((name) => name.includes('.imported.'))).toBe(false);
  });

  it('imports once and removes the source, backup, tombstone, and Core marker after verification', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    fs.writeFileSync(legacy, JSON.stringify({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [{
        id: 'queue-1', requestId: 'request-1', text: 'preserve me', createdAt: 10,
      }] }],
      receipts: [{ pane: '%1', threadId: 'thread-1', requestId: 'request-1', text: 'preserve me',
        status: 'queued', queueItemId: 'queue-1', createdAt: 10, updatedAt: 10 }],
    }));
    const first = migrateLegacyCodexOutbox(legacy, core, 20);
    expect(first.imported).toBe(1);
    expect(JSON.parse(fs.readFileSync(core, 'utf8'))).toMatchObject({
      version: 2, submissions: [{ clientRequestId: 'request-1', state: 'queued', text: 'preserve me' }],
    });
    expect(JSON.parse(fs.readFileSync(core, 'utf8')).migrations).toBeUndefined();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(`${legacy}.imported.${first.fingerprint}.json`)).toBe(false);
    expect(migrateLegacyCodexOutbox(legacy, core).imported).toBe(0);
  });

  it('fails closed on malformed input without modifying the source', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-bad-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    fs.writeFileSync(legacy, '{broken');
    expect(() => migrateLegacyCodexOutbox(legacy, core)).toThrow(/invalid JSON/);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('{broken');
    expect(fs.existsSync(core)).toBe(false);
  });

  it('migrates a legacy accepted receipt without text and keeps retries query-only', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-accepted-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    writeLegacyAccepted(legacy);

    migrateLegacyCodexOutbox(legacy, core, 20);
    expect(fs.readFileSync(core, 'utf8')).not.toContain('private accepted prompt');
    expect(JSON.parse(fs.readFileSync(core, 'utf8')).deliveryReceipts).toEqual([
      expect.objectContaining({
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'accepted-1',
        nativeId: 'turn-1', acceptedAt: 11,
      }),
    ]);
    expect(fs.existsSync(legacy)).toBe(false);

    const runs = new AgentRunRuntime({ newRunId: () => 'run-migrated' });
    const lease = await runs.controller('codex', async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'thread-1', process: { pid: 101 },
    });
    const dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const service = new ConversationService({
      runs,
      adapters: { codex: {
        apiVersion: 1, discoverNative: async () => null,
        readNativePage: async () => { throw new Error('unused'); }, dispatchPrompt,
      } },
      store: new FileConversationStateStore(core), now: () => 20,
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-migrated',
      }) },
    });
    expect((await service.queueSnapshot(lease)).settled).toEqual([
      { id: 'accepted-1', nativeId: 'turn-1' },
    ]);
    await expect(service.send(lease, {
      clientRequestId: 'accepted-1', text: 'private accepted prompt', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted', nativeId: 'turn-1' });
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it('replaces an existing active Core submission with the legacy accepted receipt', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-accepted-existing-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    writeLegacyAccepted(legacy);
    fs.writeFileSync(core, JSON.stringify({
      version: 2, ledgerRevision: 1, cycles: [], legacySends: [], deliveryReceipts: [],
      submissions: [{
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'accepted-1',
        text: 'private accepted prompt',
        payloadHash: createHash('sha256').update('private accepted prompt').digest('hex'),
        state: 'unknown', revision: 1, dispatchOrigin: 'direct',
        lastRunId: '%1', createdAt: 10, updatedAt: 10,
      }],
    }));

    migrateLegacyCodexOutbox(legacy, core, 20);
    const migrated = JSON.parse(fs.readFileSync(core, 'utf8'));
    expect(migrated.submissions).toEqual([]);
    expect(migrated.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'accepted-1', nativeId: 'turn-1' }),
    ]);
    expect(fs.readFileSync(core, 'utf8')).not.toContain('private accepted prompt');
  });

  it('keeps accepted receipt identity when migration resumes after the legacy source was retired', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-accepted-crash-'));
    temporary.push(directory);
    const legacyDirectory = path.join(directory, 'legacy');
    const conversationDirectory = path.join(directory, 'conversation');
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(conversationDirectory);
    const legacy = path.join(legacyDirectory, 'codex-outbox.json');
    const core = path.join(conversationDirectory, 'conversation-state.json');
    writeLegacyAccepted(legacy);
    const legacyStat = fs.statSync(legacyDirectory);
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (!failed && stat.isDirectory() && sameFile(stat, legacyStat)) {
        failed = true;
        throw new Error('simulated crash after accepted backup rename');
      }
      return originalFsync(descriptor);
    });
    try {
      expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).toThrow(/simulated crash/);
    } finally {
      fsync.mockRestore();
    }

    const interrupted = JSON.parse(fs.readFileSync(core, 'utf8'));
    expect(interrupted.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'accepted-1' }),
    ]);
    expect(interrupted.migrations?.legacyCodexOutboxImported?.submissionKeys).toEqual([
      'codex\0thread-1\0accepted-1',
    ]);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).not.toThrow();
    const recovered = JSON.parse(fs.readFileSync(core, 'utf8'));
    expect(recovered.deliveryReceipts).toEqual([
      expect.objectContaining({ clientRequestId: 'accepted-1', nativeId: 'turn-1' }),
    ]);
    expect(recovered.migrations?.legacyCodexOutboxImported).toBeUndefined();
  });

  it('refuses to finalize an interrupted accepted migration when its receipt is missing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-accepted-missing-'));
    temporary.push(directory);
    const legacyDirectory = path.join(directory, 'legacy');
    const conversationDirectory = path.join(directory, 'conversation');
    fs.mkdirSync(legacyDirectory);
    fs.mkdirSync(conversationDirectory);
    const legacy = path.join(legacyDirectory, 'codex-outbox.json');
    const core = path.join(conversationDirectory, 'conversation-state.json');
    writeLegacyAccepted(legacy);
    const legacyStat = fs.statSync(legacyDirectory);
    const originalFsync = fs.fsyncSync;
    let failed = false;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (!failed && stat.isDirectory() && sameFile(stat, legacyStat)) {
        failed = true;
        throw new Error('simulated crash before accepted finalize');
      }
      return originalFsync(descriptor);
    });
    try {
      expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).toThrow(/simulated crash/);
    } finally {
      fsync.mockRestore();
    }
    const interrupted = JSON.parse(fs.readFileSync(core, 'utf8'));
    const fingerprint = interrupted.migrations.legacyCodexOutboxImported.fingerprint;
    interrupted.deliveryReceipts = [];
    fs.writeFileSync(core, JSON.stringify(interrupted));

    expect(() => migrateLegacyCodexOutbox(legacy, core, 20)).toThrow(/referenced delivery/);
    expect(fs.existsSync(`${legacy}.imported.${fingerprint}.json`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(core, 'utf8')).migrations.legacyCodexOutboxImported).toBeDefined();
  });

  it('fails closed when an interrupted scoped marker contains an extra submission key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-marker-key-superset-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    writeLegacyQueue(legacy);
    const fingerprint = createHash('sha256').update(fs.readFileSync(legacy)).digest('hex');
    const hash = createHash('sha256').update('preserve me').digest('hex');
    fs.writeFileSync(core, JSON.stringify({
      version: 2, ledgerRevision: 2, cycles: [],
      submissions: [{
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'request-1',
        text: 'preserve me', payloadHash: hash, state: 'queued', revision: 1,
        queueOrderKey: '0000000000000010:0000000000000001', createdAt: 10, updatedAt: 10,
      }, {
        agentId: 'codex', sessionId: 'thread-extra', clientRequestId: 'request-extra',
        text: 'extra', payloadHash: createHash('sha256').update('extra').digest('hex'),
        state: 'queued', revision: 2,
        queueOrderKey: '0000000000000011:0000000000000002', createdAt: 11, updatedAt: 11,
      }],
      migrations: { legacyCodexOutboxImported: {
        fingerprint, submissionIds: ['request-1', 'request-extra'],
        submissionKeys: [
          'codex\0thread-1\0request-1', 'codex\0thread-extra\0request-extra',
        ],
        importedAt: 20,
      } },
    }));

    expect(() => migrateLegacyCodexOutbox(legacy, core)).toThrow(/marker conflicts/);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('fails closed when an interrupted legacy ID marker contains an extra ID', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-marker-id-superset-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    writeLegacyQueue(legacy);
    const fingerprint = createHash('sha256').update(fs.readFileSync(legacy)).digest('hex');
    fs.writeFileSync(core, JSON.stringify({
      version: 2, ledgerRevision: 1, cycles: [],
      submissions: [{
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'request-1',
        text: 'preserve me', payloadHash: createHash('sha256').update('preserve me').digest('hex'),
        state: 'queued', revision: 1,
        queueOrderKey: '0000000000000010:0000000000000001', createdAt: 10, updatedAt: 10,
      }],
      migrations: { legacyCodexOutboxImported: {
        fingerprint, submissionIds: ['request-1', 'request-extra'], importedAt: 20,
      } },
    }));

    expect(() => migrateLegacyCodexOutbox(legacy, core)).toThrow(/marker conflicts/);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it.each([
    { name: 'scoped key', marker: { submissionIds: ['request-1'], submissionKeys: [
      'codex\0thread-1\0request-1', 'codex\0thread-1\0request-1',
    ] } },
    { name: 'legacy ID', marker: { submissionIds: ['request-1', 'request-1'] } },
  ])('fails closed when an interrupted marker repeats a $name', ({ marker }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-outbox-marker-duplicate-'));
    temporary.push(directory);
    const legacy = path.join(directory, 'codex-outbox.json');
    const core = path.join(directory, 'conversation-state.json');
    writeLegacyQueue(legacy);
    const fingerprint = createHash('sha256').update(fs.readFileSync(legacy)).digest('hex');
    fs.writeFileSync(core, JSON.stringify({
      version: 2, ledgerRevision: 1, cycles: [],
      submissions: [{
        agentId: 'codex', sessionId: 'thread-1', clientRequestId: 'request-1',
        text: 'preserve me', payloadHash: createHash('sha256').update('preserve me').digest('hex'),
        state: 'queued', revision: 1,
        queueOrderKey: '0000000000000010:0000000000000001', createdAt: 10, updatedAt: 10,
      }],
      migrations: { legacyCodexOutboxImported: { fingerprint, ...marker, importedAt: 20 } },
    }));

    expect(() => migrateLegacyCodexOutbox(legacy, core)).toThrow(/marker conflicts/);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
