import { describe, expect, it, vi } from 'vitest';
import {
  ConversationContractError,
  ConversationService,
} from '../src/agent-runtime/conversation.js';
import type { ConversationContractErrorCode } from '../src/agent-runtime/conversation.js';
import type {
  AgentConversationAdapterV1,
  ConversationActivitySnapshot,
  ConversationAdapterEvent,
  ConversationAdapterEventSink,
  ConversationItem,
} from '../src/agent-runtime/conversationTypes.js';
import {
  normalizeConversationDraft,
  normalizeConversationItem,
} from '../src/agent-runtime/conversationValidation.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type {
  AgentRunLease,
  ScopedAgentRunController,
} from '../src/agent-runtime/run.js';

function message(id = 'item-1', text = 'hello'): ConversationItem {
  return {
    id,
    sessionId: 'session-1',
    kind: 'message',
    status: 'complete',
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

interface AdapterHarness {
  adapter: AgentConversationAdapterV1;
  emit(event: ConversationAdapterEvent): Promise<void>;
  sourceViewId: string;
  sourceHistoryToken: string;
  sourceCursor?: string;
  checkpointSequence: number;
  items: ConversationItem[];
  onObserve?: (sink: ConversationAdapterEventSink) => void;
  onRead?: () => void | Promise<void>;
  close: ReturnType<typeof vi.fn>;
  readRequests: Array<{ beforeSourceCursor?: string; limit: number }>;
}

function adapterHarness(): AdapterHarness {
  let sink: ConversationAdapterEventSink | undefined;
  const harness: AdapterHarness = {
    sourceViewId: 'provider-view',
    sourceHistoryToken: 'provider-history-1',
    checkpointSequence: 10,
    items: [message()],
    close: vi.fn(),
    readRequests: [],
    adapter: undefined as unknown as AgentConversationAdapterV1,
    async emit(event) {
      if (!sink) throw new Error('not observing');
      await sink(event);
    },
  };
  harness.adapter = {
    apiVersion: 1,
    async discoverNative(target) {
      const sessionId = target.sessionId;
      if (!sessionId) return null;
      return {
        session: { agentId: 'pi', sessionId },
        ...('runId' in target ? { run: target } : {}),
        sourceViewId: harness.sourceViewId,
        capabilities: {
          history: true,
          live: 'delta',
          send: ['prompt', 'steer', 'follow_up'],
          interrupt: true,
        },
      };
    },
    async readNativePage(session, request) {
      harness.readRequests.push(structuredClone(request));
      await harness.onRead?.();
      return {
        sessionId: session.sessionId,
        sourceViewId: harness.sourceViewId,
        sourceHistoryToken: harness.sourceHistoryToken,
        items: structuredClone(harness.items.slice(0, request.limit)),
        ...(harness.sourceCursor === undefined
          ? {} : { previousSourceCursor: harness.sourceCursor }),
        hasMore: harness.sourceCursor !== undefined,
      };
    },
    async observeNative(_run, nextSink) {
      sink = nextSink;
      harness.onObserve?.(nextSink);
      return {
        checkpoint: {
          sourceViewId: harness.sourceViewId,
          sourceSequence: harness.checkpointSequence,
        },
        close: harness.close,
      };
    },
  };
  return harness;
}

async function liveRun(runId = 'run-1'): Promise<{
  runtime: AgentRunRuntime;
  controller: ScopedAgentRunController;
  lease: AgentRunLease;
}> {
  const runtime = new AgentRunRuntime({ newRunId: () => runId });
  const controller = runtime.controller('pi', async () => true);
  const lease = await controller.attach({
    paneId: '%1',
    attachmentId: `attachment-${runId}`,
    sessionId: 'session-1',
    process: { pid: 101 },
  });
  return { runtime, controller, lease };
}

function tokenFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

describe('ConversationService durable projection', () => {
  it('classifies page input, cursor, availability, and adapter contract failures', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const expectCode = async (
      operation: Promise<unknown>,
      code: ConversationContractErrorCode,
    ): Promise<void> => {
      await expect(operation).rejects.toMatchObject({
        name: 'ConversationContractError', code,
      } satisfies Partial<ConversationContractError>);
    };

    await expectCode(service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 0 },
    ), 'invalid_request');

    const discover = harness.adapter.discoverNative.bind(harness.adapter);
    harness.adapter.discoverNative = async () => null;
    await expectCode(service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    ), 'session_unavailable');

    harness.adapter.discoverNative = discover;
    await expectCode(service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20, before: 'missing-cursor' },
    ), 'page_stale');

    harness.adapter.readNativePage = async (session) => ({
      sessionId: `${session.sessionId}-wrong`,
      sourceViewId: 'provider-view', sourceHistoryToken: 'provider-history',
      items: [], hasMore: false,
    });
    await expectCode(service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    ), 'contract_violation');
  });

  it('serializes provider history reads per session so an older result cannot overwrite a newer view', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    const nativeRead = harness.adapter.readNativePage.bind(harness.adapter);
    let calls = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    harness.adapter.readNativePage = async (session, request) => {
      const call = ++calls;
      const sourceHistoryToken = call === 1 ? 'provider-history-1' : 'provider-history-2';
      if (call === 1) {
        markFirstStarted();
        await firstGate;
      }
      return { ...await nativeRead(session, request), sourceHistoryToken };
    };
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });

    const first = service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    await firstStarted;
    const second = service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    releaseFirst();

    const [older, newer] = await Promise.all([first, second]);
    expect(older.status).toBe('ok');
    expect(newer.status).toBe('ok');
    if (older.status !== 'ok' || newer.status !== 'ok') throw new Error('expected pages');
    expect(newer.page.historyVersion).not.toBe(older.page.historyVersion);
    expect(await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 20, expectedHistoryVersion: newer.page.historyVersion },
    )).toMatchObject({ status: 'ok' });
  });

  it('wraps provider view, history, and cursor tokens without leaking them', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    harness.sourceCursor = 'provider-cursor-secret';
    const service = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('core'),
    });

    const descriptor = await service.discover({ agentId: 'pi', sessionId: 'session-1' });
    expect(descriptor).toMatchObject({ session: { agentId: 'pi', sessionId: 'session-1' } });
    expect(JSON.stringify(descriptor)).not.toContain('provider-');

    const first = await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 20, expectedViewId: descriptor!.viewId, expectedHistoryVersion: descriptor!.historyVersion },
    );
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('expected a page');
    expect(first.page.previousCursor).toMatch(/^cursor:/);
    expect(JSON.stringify(first)).not.toContain('provider-cursor-secret');

    await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 20, before: first.page.previousCursor! },
    );
    expect(harness.readRequests.at(-1)).toEqual({
      beforeSourceCursor: 'provider-cursor-secret', limit: 20,
    });
  });

  it('keeps a wrapped cursor valid when the same provider view only appends history', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    harness.sourceCursor = 'provider-page-before-tail';
    const service = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('append'),
    });
    const first = await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (first.status !== 'ok') throw new Error('expected a page');

    harness.sourceHistoryToken = 'provider-history-2';
    const older = await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      {
        limit: 20,
        before: first.page.previousCursor!,
        expectedViewId: first.page.viewId,
        expectedHistoryVersion: first.page.historyVersion,
      },
    );

    expect(older.status).toBe('ok');
    if (older.status !== 'ok') throw new Error('expected an older page');
    expect(older.page.viewId).toBe(first.page.viewId);
    expect(older.page.historyVersion).not.toBe(first.page.historyVersion);
    expect(harness.readRequests.slice(-2)).toEqual([
      { beforeSourceCursor: 'provider-page-before-tail', limit: 20 },
      { limit: 1 },
    ]);
  });

  it('bounds retained session projections and wrapped cursors', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    harness.items = [];
    const service = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('bounded'),
    });
    const first = await service.discover({ agentId: 'pi', sessionId: 'session-0' });
    for (let index = 1; index <= 256; index++) {
      await service.discover({ agentId: 'pi', sessionId: `session-${index}` });
    }
    const revisited = await service.discover({ agentId: 'pi', sessionId: 'session-0' });
    expect(revisited?.viewId).not.toBe(first?.viewId);

    harness.sourceCursor = 'provider-older';
    let expiredCursor = '';
    for (let index = 0; index <= 2_048; index++) {
      const result = await service.readPage(
        { agentId: 'pi', sessionId: 'cursor-session' }, { limit: 1 },
      );
      if (result.status !== 'ok') throw new Error('expected cursor page');
      if (index === 0) expiredCursor = result.page.previousCursor || '';
    }
    await expect(service.readPage(
      { agentId: 'pi', sessionId: 'cursor-session' },
      { limit: 1, before: expiredCursor },
    )).rejects.toThrow(/expired/i);
  });

  it('keeps a view token for history changes, rejects stale reads, and changes epochs on restart', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    const firstService = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('first'),
    });
    const first = await firstService.discover({ agentId: 'pi', sessionId: 'session-1' });
    harness.sourceHistoryToken = 'provider-history-2';
    const changed = await firstService.discover({ agentId: 'pi', sessionId: 'session-1' });
    expect(changed!.viewId).toBe(first!.viewId);
    expect(changed!.historyVersion).not.toBe(first!.historyVersion);
    expect(await firstService.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 20, expectedHistoryVersion: first!.historyVersion },
    )).toEqual({
      status: 'stale',
      currentViewId: changed!.viewId,
      currentHistoryVersion: changed!.historyVersion,
    });

    const restarted = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('restarted'),
    });
    const afterRestart = await restarted.discover({ agentId: 'pi', sessionId: 'session-1' });
    expect(afterRestart!.historyVersion).not.toBe(changed!.historyVersion);
    expect(afterRestart!.viewId).not.toBe(changed!.viewId);
  });

  it('invalidates wrapped cursors when the provider view changes', async () => {
    const { runtime } = await liveRun();
    const harness = adapterHarness();
    harness.sourceCursor = 'source-page-2';
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const first = await service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    if (first.status !== 'ok') throw new Error('expected a page');
    harness.sourceViewId = 'provider-view-2';
    harness.sourceHistoryToken = 'provider-history-2';
    const stale = await service.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 20, before: first.page.previousCursor! },
    );
    expect(stale.status).toBe('stale');
  });

  it('validates item identity, paths, extensions, resources, and external URLs', () => {
    const retainedSummary = '摘要'.repeat(2_500);
    expect(normalizeConversationItem({
      id: 'compact-1', sessionId: 'session-1', status: 'complete',
      kind: 'compaction', summary: retainedSummary,
    }, 'pi', 'session-1')).toMatchObject({
      kind: 'compaction', summary: retainedSummary,
    });
    expect(() => normalizeConversationItem(
      { ...message(), sessionId: 'another-session' }, 'pi', 'session-1',
    )).toThrow(/durable/i);
    expect(() => normalizeConversationDraft({
      kind: 'diff', path: '/etc/passwd', patch: 'x',
    }, 'pi')).toThrow(/draft/i);
    expect(() => normalizeConversationDraft({
      kind: 'notice', level: 'info', message: 'ok', extensions: { 'codex.secret': true },
    }, 'pi')).toThrow(/draft/i);
    expect(() => normalizeConversationDraft({
      kind: 'message', role: 'assistant',
      content: [{ type: 'resource', resourceId: '/private/tmp/a' }],
    }, 'pi')).toThrow(/draft/i);
    for (const url of [
      'file:///etc/passwd',
      'http://user:password@example.com',
      'http://localhost/a',
      'http://127.0.0.1/a',
      'http://[::1]/a',
      'http://[fd00::1]/a',
    ]) {
      expect(() => normalizeConversationDraft({
        kind: 'message', role: 'assistant', content: [{ type: 'external_link', url }],
      }, 'pi'), url).toThrow(/draft/i);
    }
    expect(normalizeConversationDraft({
      kind: 'reasoning_summary', text: 'user-visible summary',
    }, 'pi')).toEqual({ kind: 'reasoning_summary', text: 'user-visible summary' });
    expect(() => normalizeConversationDraft({ kind: 'thinking', text: 'raw chain of thought' }, 'pi'))
      .toThrow(/draft/i);
  });
});

describe('ConversationService live handoff', () => {
  it('fails open closed when an adapter ignores a handoff buffer overflow', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    harness.onObserve = (sink) => {
      for (let index = 0; index < 4097; index += 1) {
        void Promise.resolve(sink({
          type: 'item.opened', sourceSequence: index + 1, provisionalId: `draft-${index}`,
          draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        })).catch(() => {});
      }
    };
    const events: unknown[] = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });

    await expect(service.open(lease, {}, (event) => { events.push(event); })).rejects.toThrow(/buffer/i);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it('fails open closed when the handoff buffer overflows during the history read', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    let observedSink!: ConversationAdapterEventSink;
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    harness.onObserve = (sink) => { observedSink = sink; };
    harness.onRead = async () => {
      markReadStarted();
      await readGate;
    };
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const opening = service.open(lease, {}, () => {});
    await readStarted;
    for (let index = 0; index < 4097; index += 1) {
      void Promise.resolve(observedSink({
        type: 'item.opened', sourceSequence: index + 1, provisionalId: `draft-${index}`,
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      })).catch(() => {});
    }
    releaseRead();

    await expect(opening).rejects.toThrow(/buffer/i);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('emits a gap when the handoff buffer overflows after exposing the baseline', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const events: Array<{ type: string }> = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    await service.open(lease, {}, (event) => { events.push(event); });

    for (let index = 0; index < 4097; index += 1) {
      void Promise.resolve(harness.emit({
        type: 'item.opened', sourceSequence: index + 11, provisionalId: `draft-${index}`,
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      })).catch(() => {});
    }

    await vi.waitFor(() => expect(events).toEqual([{ type: 'stream.gap', sequence: 1, afterSequence: 0 }]));
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('observes before reading, buffers the handoff window, and calls the facade only after open returns', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const order: string[] = [];
    const pending: Promise<void>[] = [];
    harness.onObserve = (sink) => {
      order.push('observe');
      pending.push(Promise.resolve(sink({
        type: 'item.opened', sourceSequence: 10, provisionalId: 'baseline',
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'old' }] },
      })));
      pending.push(Promise.resolve(sink({
        type: 'item.opened', sourceSequence: 11, provisionalId: 'live-1',
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      })));
    };
    harness.onRead = () => {
      order.push('read');
      pending.push(harness.emit({
        type: 'item.delta', sourceSequence: 12, provisionalId: 'live-1',
        delta: { op: 'text.append', target: 'message.content', blockIndex: 0, text: 'b' },
      }));
    };
    const events: unknown[] = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const handle = await service.open(lease, {}, (event) => { order.push('facade'); events.push(event); });
    order.push('returned');

    expect(order.slice(0, 3)).toEqual(['observe', 'read', 'returned']);
    expect(events).toEqual([]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual([
      expect.objectContaining({ type: 'item.opened', sequence: 1, provisionalId: 'live-1' }),
      expect.objectContaining({ type: 'item.delta', sequence: 2, provisionalId: 'live-1' }),
    ]);
    expect(handle.checkpoint.streamSequence).toBe(0);
    await Promise.all(pending);
  });

  it('keeps the opening observation and page read ahead of later session reads', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const discoverNative = harness.adapter.discoverNative.bind(harness.adapter);
    const readNativePage = harness.adapter.readNativePage.bind(harness.adapter);
    const observeNative = harness.adapter.observeNative?.bind(harness.adapter);
    if (!observeNative) throw new Error('expected live adapter');
    let releaseExisting!: () => void;
    let markExistingStarted!: () => void;
    const existingGate = new Promise<void>((resolve) => { releaseExisting = resolve; });
    const existingStarted = new Promise<void>((resolve) => { markExistingStarted = resolve; });
    let blockNextSessionDiscover = true;
    let openingSnapshotPending = false;
    let observationStarted = false;
    const reads: string[] = [];
    harness.adapter.discoverNative = async (target) => {
      if (!('runId' in target) && blockNextSessionDiscover) {
        blockNextSessionDiscover = false;
        markExistingStarted();
        await existingGate;
      }
      return discoverNative(target);
    };
    harness.adapter.observeNative = async (run, sink) => {
      observationStarted = true;
      const handle = await observeNative(run, sink);
      openingSnapshotPending = true;
      return handle;
    };
    harness.adapter.readNativePage = async (session, request) => {
      reads.push(openingSnapshotPending ? 'opening' : 'regular');
      openingSnapshotPending = false;
      return readNativePage(session, request);
    };
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const existingRead = service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    await existingStarted;

    const opening = service.open(lease, {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observationStarted).toBe(false);
    releaseExisting();
    await existingRead;
    const handle = await opening;

    expect(reads.slice(0, 2)).toEqual(['regular', 'opening']);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('supports precise cancellation and rejects identity-changing replacement', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const events: unknown[] = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.emit({
      type: 'item.opened', sourceSequence: 11, provisionalId: 'draft-1',
      draft: { kind: 'tool_call', callId: 'call-1', name: 'read' },
    });
    await harness.emit({
      type: 'item.cancelled', sourceSequence: 12, provisionalId: 'draft-1', reason: 'interrupted',
    });
    await harness.emit({
      type: 'item.opened', sourceSequence: 13, provisionalId: 'draft-2',
      draft: { kind: 'tool_call', callId: 'call-1', name: 'read' },
    });
    await expect(harness.emit({
      type: 'item.delta', sourceSequence: 14, provisionalId: 'draft-2',
      delta: { op: 'item.replace', draft: { kind: 'tool_call', callId: 'call-2', name: 'read' } },
    })).rejects.toThrow(/identity/i);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
    expect(events).toEqual([
      expect.objectContaining({ type: 'item.opened', provisionalId: 'draft-1' }),
      expect.objectContaining({ type: 'item.cancelled', provisionalId: 'draft-1' }),
      expect.objectContaining({ type: 'item.opened', provisionalId: 'draft-2' }),
      { type: 'stream.gap', sequence: 4, afterSequence: 3 },
    ]);
  });

  it('fails the live stream closed when an adapter ignores an uncloneable event rejection', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const events: Array<{ type: string }> = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const invalid = {
      type: 'item.opened', sourceSequence: 11, provisionalId: 'draft-1',
      draft: {
        kind: 'notice', level: 'info', message: 'bad',
        extensions: { 'pi.invalid': () => {} },
      },
    } as unknown as ConversationAdapterEvent;
    void Promise.resolve(harness.emit(invalid)).catch(() => {});

    await vi.waitFor(() => expect(events).toEqual([{ type: 'stream.gap', sequence: 1, afterSequence: 0 }]));
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('closes a native handle that resolves after its run was revoked', async () => {
    const { runtime, controller, lease } = await liveRun();
    const harness = adapterHarness();
    let releaseObserve!: () => void;
    const observeGate = new Promise<void>((resolve) => { releaseObserve = resolve; });
    harness.adapter.observeNative = async (_run, _sink) => {
      await observeGate;
      return {
        checkpoint: { sourceViewId: harness.sourceViewId, sourceSequence: 10 },
        close: harness.close,
      };
    };
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    const opening = service.open(lease, {}, () => {});
    await controller.revoke(lease, 'provider_clear');
    releaseObserve();
    await expect(opening).rejects.toThrow(/revoked/i);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('clears provisional state and closes the native stream on a real gap', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const events: Array<{ type: string }> = [];
    const service = new ConversationService({ runs: runtime, adapters: { pi: harness.adapter } });
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.emit({
      type: 'item.opened', sourceSequence: 11, provisionalId: 'draft-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });
    await harness.emit({ type: 'stream.gap', sourceSequence: 12, afterSourceSequence: 11 });
    expect(events.map((event) => event.type)).toEqual(['item.opened', 'stream.gap']);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('publishes history changes after the durable read barrier without closing the observation', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const events: unknown[] = [];
    const service = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter }, newToken: tokenFactory('facade'),
    });
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(harness.emit({
      type: 'history.committed', sourceSequence: 11,
      sourceViewId: 'provider-view', sourceHistoryToken: 'provider-history-2',
    })).rejects.toThrow(/not readable/i);
    await vi.waitFor(() => expect(events).toEqual([
      { type: 'stream.gap', sequence: 1, afterSequence: 0 },
    ]));
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());

    const secondHarness = adapterHarness();
    secondHarness.sourceHistoryToken = 'provider-history-2';
    secondHarness.checkpointSequence = 11;
    const secondService = new ConversationService({
      runs: runtime, adapters: { pi: secondHarness.adapter }, newToken: tokenFactory('second'),
    });
    const nextEvents: unknown[] = [];
    await secondService.open(lease, {}, (event) => { nextEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondHarness.sourceHistoryToken = 'provider-history-3';
    await secondHarness.emit({
      type: 'history.committed', sourceSequence: 12,
      sourceViewId: 'provider-view', sourceHistoryToken: 'provider-history-3',
    });
    expect(nextEvents).toEqual([
      expect.objectContaining({ type: 'history.changed', sequence: 1 }),
    ]);
    expect(JSON.stringify(nextEvents)).not.toContain('provider-history');
    expect(secondHarness.close).not.toHaveBeenCalled();
  });

  it('advances the latest frontier on history commits and observes the next uncorrelated queued send', async () => {
    const { runtime, lease } = await liveRun();
    const harness = adapterHarness();
    const base = message('baseline-tail', 'ready');
    harness.items = [base];
    const discoverNative = harness.adapter.discoverNative.bind(harness.adapter);
    harness.adapter.dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
    harness.adapter.discoverNative = async (target) => {
      const descriptor = await discoverNative(target);
      if (!descriptor || !('runId' in target)) return descriptor;
      return {
        ...descriptor,
        capabilities: { ...descriptor.capabilities, sendable: true, send: ['prompt'] },
      };
    };
    let activity: ConversationActivitySnapshot = {
      activity: 'working' as const,
      activeTurn: { state: 'active' as const, nativeTurnId: 'turn-existing' },
      revision: 1, epoch: 'run-1',
    };
    const service = new ConversationService({
      runs: runtime, adapters: { pi: harness.adapter },
      activitySource: { read: async () => structuredClone(activity) },
      newToken: tokenFactory('history-frontier'),
    });
    await service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    const live = await service.open(lease, {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.send(lease, {
      clientRequestId: 'request-history', text: 'same text', delivery: 'prompt',
    });

    harness.items = [{
      id: 'pre-send-same-text', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    }];
    harness.sourceHistoryToken = 'provider-history-2';
    await harness.emit({
      type: 'history.committed', sourceSequence: 11,
      sourceViewId: 'provider-view', sourceHistoryToken: 'provider-history-2',
    });

    activity = {
      activity: 'idle', activeTurn: { state: 'none' }, revision: 2, epoch: 'run-1',
    };
    await service.queueSnapshot(lease);
    await vi.waitFor(() => expect(harness.adapter.dispatchPrompt).toHaveBeenCalledOnce());

    harness.items = [{
      id: 'post-send-same-text', sessionId: 'session-1', kind: 'message', role: 'user',
      status: 'complete', content: [{ type: 'text', text: 'same text' }],
    }];
    harness.sourceHistoryToken = 'provider-history-3';
    await harness.emit({
      type: 'history.committed', sourceSequence: 12,
      sourceViewId: 'provider-view', sourceHistoryToken: 'provider-history-3',
    });
    expect(service.querySubmission(lease, 'request-history')).toEqual({
      status: 'accepted', nativeId: 'post-send-same-text',
    });
    live.close();
  });
});
