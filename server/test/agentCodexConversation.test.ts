import { describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import type { ConversationEvent } from '../src/agent-runtime/conversationTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import { createCodexConversationAdapter } from '../src/agents/codexConversation.js';
import type { CodexTranscriptMessage } from '../src/codexTranscriptParse.js';
import type { TranscriptReader } from '../src/transcriptReader.js';

function fakeReader(messages: CodexTranscriptMessage[]): TranscriptReader {
  return {
    read: vi.fn(async () => messages) as TranscriptReader['read'],
    readPrefix: vi.fn(async () => [...messages]) as NonNullable<TranscriptReader['readPrefix']>,
    clear: vi.fn(),
    size: () => 1,
  };
}

function appHarness() {
  let listener: ((event: unknown) => void) | undefined;
  const close = vi.fn();
  const app = {
    discover: vi.fn(async () => ({ managed: true, threadId: 'thread-1' })),
    observeConversation: vi.fn(async (
      _pane: string,
      _threadId: string,
      next: (event: unknown) => void,
    ) => {
      listener = next;
      return { cursor: 20, close };
    }),
    send: vi.fn(async (): Promise<unknown> => ({ turn: { id: 'turn-new' } })),
    dispatchPrompt: vi.fn(async (): Promise<unknown> => ({
      busy: false, result: { turn: { id: 'turn-new' } },
    })),
    dispatchSteer: vi.fn(async (): Promise<unknown> => ({
      busy: false, result: { turn: { id: 'turn-new' } },
    })),
    interrupt: vi.fn(async (): Promise<unknown> => ({ interrupted: true, turnId: 'turn-1' })),
  };
  return {
    app,
    close,
    emit(event: unknown) {
      if (!listener) throw new Error('not observing');
      listener(event);
    },
  };
}

async function setup(
  messages: CodexTranscriptMessage[] = [],
  durablePollMs = 10_000,
  reader: TranscriptReader = fakeReader(messages),
  durableSettleTimeoutMs = 15_000,
  rolloutSize: (file: string) => Promise<number | null> = async () => Number.MAX_SAFE_INTEGER,
  findRollout: (root: string, sessionId: string) => Promise<string | null>
    = async (_root, sessionId) => sessionId === 'thread-1' ? '/rollout.jsonl' : null,
) {
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const controller = runtime.controller('codex', async () => true);
  const lease = await controller.attach({
    paneId: '%1', attachmentId: 'codex-app-server', sessionId: 'thread-1', process: { pid: 101 },
  });
  const harness = appHarness();
  const adapter = createCodexConversationAdapter({
    app: harness.app,
    sessionsRoot: '/codex/sessions',
    reader,
    findRollout,
    rolloutSize,
    durablePollMs,
    durableSettleTimeoutMs,
  });
  const service = new ConversationService({
    runs: runtime, adapters: { codex: adapter },
    activitySource: { read: async () => ({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
    }) },
  });
  return { runtime, controller, lease, harness, adapter, service, reader };
}

describe('Codex Conversation adapter', () => {
  it('projects only the changed durable suffix after an append', async () => {
    const first: CodexTranscriptMessage = {
      i: 0, id: 'codex:turn-1:user-1', type: 'text', role: 'user', text: 'first', ts: undefined,
    };
    const second: CodexTranscriptMessage = {
      i: 1, id: 'codex:turn-2:user-1', type: 'text', role: 'user', text: 'second', ts: undefined,
    };
    let readCount = 0;
    const reader: TranscriptReader = {
      read: vi.fn(async () => [first, second]) as TranscriptReader['read'],
      readPrefix: vi.fn(async () => [first]) as NonNullable<TranscriptReader['readPrefix']>,
      readSnapshot: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) return { messages: [first], version: 'v1', changedFrom: 0 };
        const guarded = new Proxy(first, {
          get() { throw new Error('stable prefix was projected again'); },
        });
        return { messages: [guarded, second], version: 'v2', changedFrom: 1 };
      }) as NonNullable<TranscriptReader['readSnapshot']>,
      clear: vi.fn(),
      size: () => 1,
    };
    const { service } = await setup([], 10_000, reader);
    const initial = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    const appended = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    if (initial.status !== 'ok' || appended.status !== 'ok') throw new Error('expected history');
    expect(appended.page.items.map((item) => item.kind === 'message'
      ? item.content[0]?.type === 'text' && item.content[0].text : '')).toEqual(['first', 'second']);
  });

  it('projects the durable rollout into standard items with opaque Core history', async () => {
    const messages: CodexTranscriptMessage[] = [
      {
        i: 0, id: 'codex:turn-1:user-1', turnId: 'turn-1', correlationId: 'request-1',
        type: 'text', role: 'user', text: 'question', ts: '2026-08-12T00:00:00Z',
      },
      {
        i: 1, id: 'codex:turn-1:reason-1', turnId: 'turn-1',
        type: 'thinking', role: 'assistant', text: 'public summary', ts: undefined,
      },
      {
        i: 2, id: 'codex:turn-1:tool-1', turnId: 'turn-1', type: 'tool', role: 'assistant', ts: undefined,
        tool: {
          name: 'apply_patch', input: { file_path: 'src/app.ts', patch: '+new' }, result: 'done',
          isError: false, diff: { added: 1, removed: 0, hunks: [] },
        },
      },
      { i: 3, type: 'compact', summary: 'retained Codex summary', ts: undefined },
      { i: 4, type: 'interrupt', ts: undefined },
      { i: 5, type: 'slash', name: '/compact', args: 'now', result: 'Compacted', ts: undefined },
    ];
    const { service } = await setup(messages);
    const descriptor = await service.discover({ agentId: 'codex', sessionId: 'thread-1' });
    expect(descriptor?.capabilities).toEqual({ history: true, live: 'poll' });
    expect(JSON.stringify(descriptor)).not.toContain('codex-thread:');
    const result = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    if (result.status !== 'ok') throw new Error('expected history');
    expect(result.page.items.map((item) => item.kind)).toEqual([
      'message', 'reasoning_summary', 'tool_call', 'tool_result', 'diff', 'compaction', 'interrupt',
      'notice',
    ]);
    expect(result.page.items.find((item) => item.kind === 'diff')).toMatchObject({
      path: 'src/app.ts', patch: '+new', summary: '+1 -0',
    });
    expect(result.page.items.find((item) => item.kind === 'compaction')).toMatchObject({
      summary: 'retained Codex summary',
    });
    const user = result.page.items.find((item) => item.kind === 'message' && item.role === 'user');
    expect(user).toMatchObject({ groupingId: 'turn-1', correlationId: 'request-1' });
    const tool = result.page.items.find((item) => item.kind === 'tool_call');
    expect(tool).toMatchObject({
      groupingId: 'turn-1',
      extensions: {
        'conversation.tool': expect.objectContaining({
          name: 'apply_patch', result: 'done',
          diff: { added: 1, removed: 0, hunks: [] },
        }),
      },
    });
    expect(tool).not.toHaveProperty('correlationId');
    expect(JSON.stringify(result.page)).not.toContain('/rollout.jsonl');
    expect(result.page.items.find((item) => item.kind === 'notice')).toMatchObject({
      code: 'slash_command',
      extensions: { 'conversation.slash': { name: '/compact', args: 'now', result: 'Compacted' } },
    });
  });

  it('requires the pane-owned App Server thread for live capabilities', async () => {
    const { service, harness, lease } = await setup();
    const descriptor = await service.discover(lease.ref);
    expect(descriptor?.capabilities).toEqual({
      history: true, live: 'delta', sendable: true, steer: true, send: ['prompt'], interrupt: true,
    });
    harness.app.discover.mockResolvedValueOnce({ managed: true, threadId: 'another-thread' });
    expect(await service.discover(lease.ref)).toBeNull();
  });

  it('reads an active managed thread before its rollout file exists', async () => {
    const { service, lease } = await setup(
      [], 10_000, fakeReader([]), 15_000,
      async () => 0,
      async () => null,
    );

    expect(await service.discover(lease.ref)).toMatchObject({
      session: { agentId: 'codex', sessionId: 'thread-1' },
      run: lease.ref,
    });
    const result = await service.readPage(lease.ref, { limit: 20 });

    expect(result).toMatchObject({
      status: 'ok',
      page: { sessionId: 'thread-1', items: [], hasMore: false },
    });
  });

  it('requires immutable transcript prefix reads for the opening boundary', () => {
    const harness = appHarness();
    const { readPrefix: _readPrefix, ...reader } = fakeReader([]);

    expect(() => createCodexConversationAdapter({ app: harness.app, reader })).toThrow(
      'Codex Conversation adapter requires immutable transcript prefix reads',
    );
  });

  it('keeps empty tool completion metadata without emitting an empty durable result', async () => {
    const { service } = await setup([{
      i: 0, id: 'codex:turn-1:tool-1', turnId: 'turn-1', type: 'tool', role: 'assistant', ts: undefined,
      tool: {
        name: 'exec_command', input: { cmd: 'true' }, result: '', isError: false,
        outcome: 'success',
      },
    }]);
    const result = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    if (result.status !== 'ok') throw new Error('expected history');
    expect(result.page.items.map((item) => item.kind)).toEqual(['tool_call']);
    expect(result.page.items[0]).toMatchObject({
      kind: 'tool_call',
      extensions: {
        'conversation.tool': expect.objectContaining({ result: '', outcome: 'success' }),
      },
    });
  });

  it('keeps an oversized message and MCP tool readable after boundary clipping and redaction', async () => {
    const oversizedMessage = '你🙂'.repeat(70_000);
    const oversizedResult = JSON.stringify({
      output: '中'.repeat(100_000), apiKey: 'mcp-result-secret',
      endpoint: 'http://localhost:4321/mcp', savedPath: '/Users/alice/mcp-output.json',
    });
    const { service } = await setup([{
      i: 0, id: 'codex:turn-large:assistant', type: 'text', role: 'assistant',
      text: oversizedMessage, ts: undefined,
    }, {
      i: 1, id: 'codex:turn-large:tool', type: 'tool', role: 'assistant', ts: undefined,
      tool: {
        name: 'private-mcp:query',
        input: {
          query: 'keep this', Authorization: 'Bearer input-secret', cookie: 'sid=cookie-secret',
          cwd: '/Users/alice/project', savedPath: '/private/tmp/result.json',
          file_path: 'file:///Users/alice/project/secret.ts',
          endpoint: 'http://127.0.0.1:4321/mcp',
          documentationUrl: 'https://docs.example.com/mcp',
        },
        result: oversizedResult, isError: false, outcome: 'success',
        diff: {
          added: 1, removed: 0,
          hunks: [{
            oldStart: 1, newStart: 1,
            lines: ['+Authorization: Bearer diff-secret /Users/alice/project/file.ts'],
          }],
        },
      },
    }]);

    const result = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    if (result.status !== 'ok') throw new Error('expected readable oversized history');
    const message = result.page.items.find((item) => item.kind === 'message');
    const tool = result.page.items.find((item) => item.kind === 'tool_call');
    const toolResult = result.page.items.find((item) => item.kind === 'tool_result');
    const diff = result.page.items.find((item) => item.kind === 'diff');
    expect(message).toMatchObject({
      status: 'truncated',
      truncation: { reason: 'size_limit', originalBytes: Buffer.byteLength(oversizedMessage) },
    });
    if (!message || message.kind !== 'message' || message.content[0]?.type !== 'text') {
      throw new Error('expected clipped message');
    }
    expect(Buffer.byteLength(message.content[0].text)).toBeLessThanOrEqual(240 * 1024);
    expect(message.content[0].text).not.toContain('\uFFFD');
    expect(tool).toMatchObject({
      status: 'complete',
      input: { query: 'keep this', documentationUrl: 'https://docs.example.com/mcp' },
      extensions: {
        'conversation.tool': expect.objectContaining({
          name: 'private-mcp:query', outcome: 'success', isError: false,
          input: expect.objectContaining({
            query: 'keep this', documentationUrl: 'https://docs.example.com/mcp',
          }),
        }),
      },
    });
    expect(tool).not.toHaveProperty('truncation');
    expect(toolResult).toMatchObject({
      status: 'truncated',
      truncation: { reason: 'size_limit', originalBytes: Buffer.byteLength(oversizedResult) },
    });
    expect(diff).toMatchObject({ status: 'complete' });
    expect(diff).not.toHaveProperty('truncation');
    const serialized = JSON.stringify(result.page);
    expect(serialized).not.toContain('input-secret');
    expect(serialized).not.toContain('diff-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('mcp-result-secret');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('127.0.0.1');
    expect(Buffer.byteLength(serialized)).toBeLessThan(1024 * 1024);
  });

  it('maps App Server text lifecycle and reconciles durable history without a legacy snapshot', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The user record commonly lands before the final assistant record. This intermediate token must
    // not replace the already-settled live reply with a page that does not contain it yet.
    durable.push({
      i: 0, id: 'codex:turn-1:user-1', type: 'text', role: 'user', text: 'question', ts: undefined,
    });
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: '', completed: false,
    });
    harness.emit({
      type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: 'Hello',
    });
    harness.emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'Hello', completed: true,
    });
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events.map((event) => event.type)).toEqual([
      'item.opened', 'item.delta', 'item.delta', 'item.settled',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'item.settled', durableItemId: 'codex:turn-1:agent-1',
      item: {
        kind: 'message', role: 'assistant', groupingId: 'turn-1',
        content: [{ type: 'text', text: 'Hello' }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.type === 'history.changed')).toBe(false);

    durable.push({
      i: 1, id: 'codex:turn-1:agent-1', type: 'text', role: 'assistant', text: 'Hello', ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.filter((event) => event.type === 'history.changed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('codex-thread:');
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('keeps the settled frontier across a transient readable rollout candidate', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease, reader } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    durable.push({
      i: 0, id: 'codex:turn-1:user-1', type: 'text', role: 'user', text: 'question', ts: undefined,
    });
    harness.emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'answer', completed: true,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    durable.push({
      i: 1, id: 'codex:turn-1:agent-1', type: 'text', role: 'assistant', text: 'answer', ts: undefined,
    });
    const readsBeforeHint = vi.mocked(reader.read).mock.calls.length;
    harness.emit({ type: 'conversationSnapshot', threadId: 'thread-1', cursor: 24, messages: [] });
    await vi.waitFor(() => expect(vi.mocked(reader.read).mock.calls.length).toBeGreaterThan(readsBeforeHint));
    durable.pop();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(events.some((event) => event.type === 'history.changed')).toBe(false);

    durable.push({
      i: 1, id: 'codex:turn-1:agent-1', type: 'text', role: 'assistant', text: 'answer', ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('recognizes a durable Goal whose rollout identity differs from its live identity', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    const goal = { objective: 'Ship safely', status: 'active' as const, createdAt: 10 };
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-goal', event: 'set', goal,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    durable.push({
      i: 0, id: 'codex:turn-goal:goal-context-1', itemId: 'goal-context-1',
      turnId: 'turn-goal', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: goal.objective, status: goal.status }, ts: undefined,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.find((event) => event.type === 'item.settled')).toMatchObject({
      durableItemId: 'codex-goal:10:set',
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('reconciles a live restarted Goal with its durable active set lifecycle', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-goal', event: 'restarted',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    durable.push({
      i: 0, id: 'codex:turn-goal:goal-context-1', itemId: 'goal-context-1',
      turnId: 'turn-goal', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('seeds the durable Goal baseline before processing observer replay', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-old:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-old', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    }];
    let releaseBaseline!: (value: CodexTranscriptMessage[]) => void;
    const baseline = new Promise<CodexTranscriptMessage[]>((resolve) => { releaseBaseline = resolve; });
    const reader: TranscriptReader = {
      read: vi.fn(async () => durable) as TranscriptReader['read'],
      readPrefix: vi.fn(async () => baseline) as NonNullable<TranscriptReader['readPrefix']>,
      clear: vi.fn(),
      size: () => 1,
    };
    const { service, harness, lease } = await setup(durable, 10, reader);
    const events: ConversationEvent[] = [];
    const opening = service.open(lease, {}, (event) => { events.push(event); });
    await vi.waitFor(() => expect(reader.readPrefix).toHaveBeenCalledOnce());
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-new', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    releaseBaseline([...durable]);
    await opening;
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    durable.push({
      i: 1, id: 'codex:turn-new:user-1', turnId: 'turn-new',
      type: 'text', role: 'user', text: 'unrelated durable item', ts: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.type === 'history.changed')).toBe(false);

    durable.push({
      i: 2, id: 'codex:turn-new:goal-context-new', itemId: 'goal-context-new',
      turnId: 'turn-new', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('does not let an older differently identified Goal swallow an opening live lifecycle', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-goal:goal-context-1', itemId: 'goal-context-1',
      turnId: 'turn-goal', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', tokensUsed: 1_200 }, ts: undefined,
    }];
    let releaseBaseline!: () => void;
    const baseline = new Promise<void>((resolve) => { releaseBaseline = resolve; });
    const reader: TranscriptReader = {
      read: vi.fn(async () => durable) as TranscriptReader['read'],
      readPrefix: vi.fn(async () => {
        await baseline;
        return durable;
      }) as NonNullable<TranscriptReader['readPrefix']>,
      clear: vi.fn(),
      size: () => 1,
    };
    const { service, harness, lease } = await setup(durable, 10, reader);
    const events: ConversationEvent[] = [];
    const opening = service.open(lease, {}, (event) => { events.push(event); });
    await vi.waitFor(() => expect(reader.readPrefix).toHaveBeenCalledOnce());
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-goal', event: 'restarted',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    releaseBaseline();
    await opening;
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    durable.push({
      i: 1, id: 'codex:turn-next:goal-context-2', itemId: 'goal-context-2',
      turnId: 'turn-next', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', tokensUsed: 0 }, ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('keeps an opening live Goal in the suffix when its durable context lands during the prefix read', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let releasePrefix!: () => void;
    let prefixStarted!: () => void;
    const started = new Promise<void>((resolve) => { prefixStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePrefix = resolve; });
    const reader: TranscriptReader = {
      read: vi.fn(async () => durable) as TranscriptReader['read'],
      readPrefix: vi.fn(async () => {
        const snapshot = [...durable];
        prefixStarted();
        await blocked;
        return snapshot;
      }) as NonNullable<TranscriptReader['readPrefix']>,
      clear: vi.fn(),
      size: () => 1,
    };
    const { service, harness, lease } = await setup(durable, 10, reader);
    const events: ConversationEvent[] = [];
    const opening = service.open(lease, {}, (event) => { events.push(event); });
    await started;
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    durable.push({
      i: 0, id: 'codex:turn-next:goal-context-new', itemId: 'goal-context-new',
      turnId: 'turn-next', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    releasePrefix();
    await opening;

    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.filter((event) => event.type === 'item.settled')).toHaveLength(1);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('observes an active Goal that arrives while capturing the durable cutoff', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let emitDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      emitDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    emitDuringCutoff = () => harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('drops an entire opening assistant lifecycle when the durable prefix already owns it', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let settleDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      settleDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    settleDuringCutoff = () => {
      harness.emit({
        type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        text: '', completed: false,
      });
      harness.emit({
        type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        delta: 'done', completed: false,
      });
      harness.emit({
        type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        text: 'done', completed: true,
      });
      durable.push({
        i: 0, id: 'codex:turn-1:agent-1', itemId: 'agent-1', turnId: 'turn-1',
        type: 'text', role: 'assistant', text: 'done', ts: undefined,
      });
    };
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type.startsWith('item.'))).toEqual([]);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('keeps an opening assistant lifecycle when the same durable id has different content', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let settleDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      settleDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10_000, fakeReader(durable), 1_000, rolloutSize,
    );
    settleDuringCutoff = () => {
      harness.emit({
        type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        text: '', completed: false,
      });
      harness.emit({
        type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        delta: 'live answer', completed: false,
      });
      harness.emit({
        type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        text: 'live answer', completed: true,
      });
      durable.push({
        i: 0, id: 'codex:turn-1:agent-1', itemId: 'agent-1', turnId: 'turn-1',
        type: 'text', role: 'assistant', text: 'different durable answer', ts: undefined,
      });
    };
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some((event) => event.type === 'item.opened')).toBe(true);
    expect(events.some((event) => event.type === 'item.settled')).toBe(true);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not flash a partial opening assistant lifecycle before its late completion', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let streamDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      streamDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    streamDuringCutoff = () => {
      harness.emit({
        type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        text: '', completed: false,
      });
      harness.emit({
        type: 'delta', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
        delta: 'done', completed: false,
      });
      durable.push({
        i: 0, id: 'codex:turn-1:agent-1', itemId: 'agent-1', turnId: 'turn-1',
        type: 'text', role: 'assistant', text: 'done', ts: undefined,
      });
    };
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'done', completed: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type.startsWith('item.'))).toEqual([]);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('uses only post-checkpoint Goal occurrences to cover an opening Goal lifecycle', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-old:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-old', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    }];
    let settleDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      settleDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    const seeded = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    expect(seeded.status).toBe('ok');
    settleDuringCutoff = () => {
      harness.emit({
        type: 'goal', threadId: 'thread-1', turnId: null, event: 'set',
        goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
      });
      durable.push({
        i: 1, id: 'codex:turn-new:goal-context-new', itemId: 'goal-context-new',
        turnId: 'turn-new', type: 'goal', role: 'assistant', event: 'set',
        goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
      });
    };
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(events.filter((event) => event.type.startsWith('item.'))).toEqual([]);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not let a known old Goal cover a real opening lifecycle without a new occurrence', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-old:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-old', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    }];
    let settleDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      settleDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    const seeded = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    expect(seeded.status).toBe('ok');
    settleDuringCutoff = () => harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: null, event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some((event) => event.type === 'item.settled')).toBe(true);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('retains an unknown tagged Goal even when old durable history has the same semantics', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-current:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-current', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', tokensUsed: 1_200 }, ts: undefined,
    }];
    let snapshotDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      snapshotDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    const seeded = await service.readPage(
      { agentId: 'codex', sessionId: 'thread-1' }, { limit: 20 },
    );
    expect(seeded.status).toBe('ok');
    snapshotDuringCutoff = () => harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      observationSnapshot: true,
      goal: {
        objective: 'Ship safely', status: 'active', createdAt: 10, tokensUsed: 1_500,
      },
    });
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(events.some((event) => event.type === 'item.settled')).toBe(true);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not let a merely displayed Goal use an older semantic occurrence after reconnect', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-old:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-old', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    }];
    let snapshotDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      snapshotDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    const firstEvents: ConversationEvent[] = [];
    const first = await service.open(lease, {}, (event) => { firstEvents.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-new', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await vi.waitFor(() => expect(firstEvents.some((event) => event.type === 'item.settled')).toBe(true));
    await first.close();

    snapshotDuringCutoff = () => harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-new', event: 'set',
      observationSnapshot: true,
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    const secondEvents: ConversationEvent[] = [];
    const second = await service.open(lease, {}, (event) => { secondEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondEvents.some((event) => event.type === 'item.settled')).toBe(true);
    expect(secondEvents.some((event) => event.type === 'stream.gap')).toBe(false);
    await second.close();
    expect(harness.close).toHaveBeenCalledTimes(2);
  });

  it('suppresses a reconnect snapshot only after that Goal lifecycle became durable', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let snapshotDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      snapshotDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    const firstEvents: ConversationEvent[] = [];
    const first = await service.open(lease, {}, (event) => { firstEvents.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
    });
    await vi.waitFor(() => expect(firstEvents.some((event) => event.type === 'item.settled')).toBe(true));
    durable.push({
      i: 0, id: 'codex:turn-current:goal-context', itemId: 'goal-context',
      turnId: 'turn-current', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    await vi.waitFor(() => expect(firstEvents.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
    await first.close();
    expect(harness.close).toHaveBeenCalledOnce();

    snapshotDuringCutoff = () => harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      observationSnapshot: true,
      goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
    });
    const secondEvents: ConversationEvent[] = [];
    const second = await service.open(lease, {}, (event) => { secondEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(secondEvents.filter((event) => event.type.startsWith('item.'))).toEqual([]);
    expect(secondEvents.some((event) => event.type === 'stream.gap')).toBe(false);
    await second.close();
    expect(harness.close).toHaveBeenCalledTimes(2);
  });

  it("does not treat a tagged Goal's origin setup turn as its next turn", async () => {
    const durable: CodexTranscriptMessage[] = [];
    let snapshotDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      snapshotDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    snapshotDuringCutoff = () => {
      harness.emit({
        type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
        observationSnapshot: true,
        goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
      });
      harness.emit({
        type: 'snapshot', threadId: 'thread-1', turnId: 'turn-current', itemId: 'agent-current',
        text: 'still working', completed: false,
      });
    };
    const events: ConversationEvent[] = [];

    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(events.some((event) => event.type === 'item.settled')).toBe(true);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('starts the active Goal deadline for a later setup turn', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let snapshotDuringCutoff = (): void => {};
    const rolloutSize = vi.fn(async () => {
      snapshotDuringCutoff();
      return Number.MAX_SAFE_INTEGER;
    });
    const { service, harness, lease } = await setup(
      durable, 10, fakeReader(durable), 40, rolloutSize,
    );
    snapshotDuringCutoff = () => {
      harness.emit({
        type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
        observationSnapshot: true,
        goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
      });
      harness.emit({
        type: 'snapshot', threadId: 'thread-1', turnId: 'turn-next', itemId: 'agent-next',
        text: 'next turn has no Goal context', completed: false,
      });
    };
    const events: ConversationEvent[] = [];

    await service.open(lease, {}, (event) => { events.push(event); });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true));
    expect(events.filter((event) => event.type === 'stream.gap')).toHaveLength(1);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('does not let an older identical Goal cover a newly settled lifecycle', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-old:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-old', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    }];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-new', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.type === 'history.changed')).toBe(false);

    durable.push({
      i: 1, id: 'codex:turn-new:goal-context-new', itemId: 'goal-context-new',
      turnId: 'turn-new', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('does not let a same-turn old Goal swallow a restarted lifecycle', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-current:goal-context-old', itemId: 'goal-context-old',
      turnId: 'turn-current', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', tokensUsed: 1_200 }, ts: undefined,
    }];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20, tokensUsed: 0 },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    durable.push({
      i: 1, id: 'codex:turn-current:goal-context-new', itemId: 'goal-context-new',
      turnId: 'turn-current', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', tokensUsed: 0 }, ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('lets a replacement Goal supersede an older active card that never became durable', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10, fakeReader(durable), 40);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
    });
    await vi.waitFor(() => expect(
      events.filter((event) => event.type === 'item.settled'),
    ).toHaveLength(1));
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await vi.waitFor(() => expect(
      events.filter((event) => event.type === 'item.settled'),
    ).toHaveLength(2));

    durable.push({
      i: 0, id: 'codex:turn-next:goal-context-new', itemId: 'goal-context-new',
      turnId: 'turn-next', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('assigns repeated pending Goals to durable occurrences one-to-one', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    for (const [turnId, createdAt] of [['turn-1', 10], ['turn-2', 20]] as const) {
      harness.emit({
        type: 'goal', threadId: 'thread-1', turnId, event: 'set',
        goal: { objective: 'Ship safely', status: 'active', createdAt },
      });
    }
    await vi.waitFor(() => expect(
      events.filter((event) => event.type === 'item.settled'),
    ).toHaveLength(2));

    durable.push({
      i: 0, id: 'codex:turn-1:goal-context-1', itemId: 'goal-context-1',
      turnId: 'turn-1', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.type === 'history.changed')).toBe(false);

    durable.push({
      i: 1, id: 'codex:turn-2:goal-context-2', itemId: 'goal-context-2',
      turnId: 'turn-2', type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('reserves an exact Goal occurrence before an earlier semantic match can claim it', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10, fakeReader(durable), 40);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-1', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 10 },
    });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-2', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await vi.waitFor(() => expect(
      events.filter((event) => event.type === 'item.settled'),
    ).toHaveLength(2));
    durable.push({
      i: 0, id: 'codex-goal:20:set', turnId: 'turn-2',
      type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Ship safely', status: 'active' }, ts: undefined,
    });

    // G2 is exact-covered. G1 has already seen its next turn and must time out; with greedy semantic
    // allocation G1 steals this occurrence and G2 waits forever because it has no later turn signal.
    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true));
    expect(events.filter((event) => event.type === 'stream.gap')).toHaveLength(1);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('does not suppress changed Goal content merely because its stable id is unchanged', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex-goal:10:set', turnId: 'turn-current',
      type: 'goal', role: 'assistant', event: 'set',
      goal: { objective: 'Old objective', status: 'active', createdAt: 10 }, ts: undefined,
    }];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'New objective', status: 'active', createdAt: 10 },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));

    const goal = durable[0]?.goal;
    if (!goal) throw new Error('expected durable Goal');
    goal.objective = 'New objective';
    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('does not terminate a live provisional item when durable history advances', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'partial', completed: false,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.opened')).toBe(true));
    durable.push({
      i: 0, id: 'codex:turn-1:user-1', type: 'text', role: 'user', text: 'question', ts: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.some((event) => event.type === 'history.changed')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('fails closed when a settled live item never becomes durable and reads keep failing', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const reader = fakeReader(durable);
    const { service, harness, lease } = await setup(durable, 10, reader, 40);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    vi.mocked(reader.read).mockRejectedValue(new Error('rollout temporarily unavailable'));
    harness.emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'never persisted', completed: true,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true));
    expect(events.filter((event) => event.type === 'stream.gap')).toHaveLength(1);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('accepts a durable item that arrives after its deadline but before the next read', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 100, fakeReader(durable), 40);
    const events: ConversationEvent[] = [];
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    await service.open(lease, {}, (event) => {
      events.push(event);
      if (event.type === 'item.settled') resolveSettled();
    });
    harness.emit({
      type: 'completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'persisted late', completed: true,
    });
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 45));
    durable.push({
      i: 0, id: 'codex:turn-1:agent-1', turnId: 'turn-1',
      type: 'text', role: 'assistant', text: 'persisted late', ts: undefined,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('retains an active Goal until the next durable turn has had time to cover it', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10, fakeReader(durable), 40);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));
    // The Goal can be emitted before App Server delivers this turn's first item. Its native turn binding
    // must make the later started event part of the frozen baseline, not a false "next turn" signal.
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-current', itemId: 'agent-current',
      text: 'current turn still running', completed: false,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.opened')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    expect(harness.close).not.toHaveBeenCalled();

    durable.push({
      i: 0, id: 'codex:turn-current:user-1', turnId: 'turn-current',
      type: 'text', role: 'user', text: 'current turn durable progress', ts: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
    harness.emit({
      type: 'turnCompleted', threadId: 'thread-1', turnId: 'turn-current', status: 'interrupted',
    });
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-next', itemId: 'agent-next',
      text: 'next turn without durable correlation', completed: false,
    });
    durable.push({
      i: 1, id: 'unscoped-next-user',
      type: 'text', role: 'user', text: 'next turn without a Goal context', ts: undefined,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true));
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('fails closed after a native next turn even when every later durable read fails', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const reader = fakeReader(durable);
    const { service, harness, lease } = await setup(durable, 10, reader, 40);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    harness.emit({
      type: 'goal', threadId: 'thread-1', turnId: 'turn-current', event: 'set',
      goal: { objective: 'Ship safely', status: 'active', createdAt: 20 },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'item.settled')).toBe(true));
    vi.mocked(reader.read).mockRejectedValue(new Error('rollout unavailable'));
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-next', itemId: 'agent-next',
      text: 'next turn started', completed: false,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true));
    expect(events.filter((event) => event.type === 'stream.gap')).toHaveLength(1);
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
  });

  it('detects rollout-only items without any App Server conversation event', async () => {
    const durable: CodexTranscriptMessage[] = [];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    durable.push({
      i: 0, id: 'codex:turn-1:tool-1', turnId: 'turn-1', type: 'tool', role: 'assistant', ts: undefined,
      tool: {
        name: 'exec_command', input: { cmd: 'npm test' }, result: 'ok', isError: false,
      },
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'history.changed')).toBe(true));
    expect(events.filter((event) => event.type === 'stream.gap')).toEqual([]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('does not publish a transient backwards or empty rollout projection', async () => {
    const durable: CodexTranscriptMessage[] = [{
      i: 0, id: 'codex:turn-1:user-1', type: 'text', role: 'user', text: 'question', ts: undefined,
    }];
    const { service, harness, lease } = await setup(durable, 10);
    const events: ConversationEvent[] = [];
    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    durable.splice(0);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(events).toEqual([]);
    expect(harness.close).not.toHaveBeenCalled();
    await handle.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not publish an unchanged baseline and stops polling after close', async () => {
    const { service, harness, lease, reader } = await setup([], 10);
    const events: ConversationEvent[] = [];
    const handle = await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(events).toEqual([]);
    expect(reader.read).toHaveBeenCalled();
    await handle.close();
    const callsAfterClose = vi.mocked(reader.read).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(reader.read).toHaveBeenCalledTimes(callsAfterClose);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('does not start a queued durable read after the observation closes', async () => {
    const durable: CodexTranscriptMessage[] = [];
    let blockNext = false;
    let releaseRead!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reader: TranscriptReader = {
      read: vi.fn(async () => {
        if (blockNext) {
          blockNext = false;
          await blocked;
        }
        return durable;
      }) as TranscriptReader['read'],
      readPrefix: vi.fn(async () => durable) as NonNullable<TranscriptReader['readPrefix']>,
      clear: vi.fn(),
      size: () => 1,
    };
    const { service, harness, lease } = await setup(durable, 10, reader);
    const handle = await service.open(lease, {}, () => {});
    const callsBeforeBlock = vi.mocked(reader.read).mock.calls.length;
    blockNext = true;
    harness.emit({ type: 'conversationSnapshot', threadId: 'thread-1', cursor: 24, messages: [] });
    await vi.waitFor(() => expect(vi.mocked(reader.read).mock.calls.length).toBe(callsBeforeBlock + 1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await handle.close();
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(reader.read).toHaveBeenCalledTimes(callsBeforeBlock + 1);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('closes the native observer when the initial durable baseline cannot be read', async () => {
    const reader = fakeReader([]);
    vi.mocked(reader.readPrefix!).mockRejectedValueOnce(new Error('rollout unavailable'));
    const { service, harness, lease } = await setup([], 10, reader);

    await expect(service.open(lease, {}, () => {})).rejects.toThrow('rollout unavailable');
    expect(harness.close).toHaveBeenCalledOnce();
    const callsAfterFailure = vi.mocked(reader.readPrefix!).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(reader.readPrefix).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('cancels unfinished items at turn completion', async () => {
    const { service, harness, lease } = await setup();
    const events: ConversationEvent[] = [];
    await service.open(lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.emit({
      type: 'started', threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1',
      text: 'partial', completed: false,
    });
    harness.emit({
      type: 'turnCompleted', threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted',
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.at(-1)).toMatchObject({ type: 'item.cancelled', reason: 'interrupted' });
  });

  it('maps Core send ids to App Server idempotency and preserves delivery semantics', async () => {
    const { service, harness, lease } = await setup();
    expect(await service.send(lease, {
      clientRequestId: 'request-1', text: 'hello', delivery: 'prompt',
    })).toMatchObject({
      status: 'accepted', nativeId: 'turn-new',
    });
    expect(harness.app.dispatchPrompt).toHaveBeenCalledWith('%1', 'thread-1', 'hello', 'request-1');
    expect(await service.send(lease, {
      clientRequestId: 'request-2', text: 'later', delivery: 'follow_up',
    })).toEqual({ status: 'rejected', reason: 'invalid_request', nativeMutation: false });
    expect(await service.send(lease, {
      clientRequestId: 'request-3', text: 'steer', delivery: 'steer',
    })).toEqual({ status: 'rejected', reason: 'invalid_request', nativeMutation: false });
    expect(await service.interrupt(lease)).toEqual({ status: 'accepted' });
  });
});
