import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createCodexAppServer, projectCodexThread } from '../src/codexAppServer.js';
import type { CodexInteractionSnapshot } from '../src/codexAppServer.js';
import type WebSocket from 'ws';
import type { CodexStreamEvent } from '../src/codexStreamProtocol.js';

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

interface TestQueueItem extends UnknownRecord {
  id: string;
  text: string;
  requestId?: string;
}

function queueItemOf(result: unknown): TestQueueItem {
  const item = recordOf(recordOf(result)?.item);
  if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') {
    throw new Error('expected a queued send result');
  }
  return item as TestQueueItem;
}

function threadFromRead(result: unknown): unknown {
  const record = recordOf(result);
  if (!record || !Object.hasOwn(record, 'thread')) throw new Error('expected a managed thread read');
  return record.thread;
}

interface TestStatus extends UnknownRecord {
  type: string;
  activeFlags?: string[];
}

interface TestItem extends UnknownRecord {
  id: string;
  type: string;
  text?: string;
  content?: unknown[];
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string;
  changes?: UnknownRecord[];
  arguments?: UnknownRecord;
  contentItems?: UnknownRecord[];
  success?: boolean | null;
}

interface TestTurn extends UnknownRecord {
  id: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  items: TestItem[];
}

interface TestThread extends UnknownRecord {
  id: string;
  status: TestStatus;
  turns: TestTurn[];
}

function firstTurn(thread: TestThread): TestTurn {
  const turn = thread.turns[0];
  if (!turn) throw new Error('expected a thread turn');
  return turn;
}

interface TestGoal extends UnknownRecord {
  threadId: string;
  objective: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
}

interface TestRpcParams extends UnknownRecord {
  threadId?: string;
  includeTurns?: boolean;
  excludeTurns?: boolean;
  initialTurnsPage?: UnknownRecord;
  limit?: number;
  cursor?: string;
  sortDirection?: string;
  itemsView?: string;
  expectedTurnId?: string;
  objective?: string;
  status?: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: string | null;
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: string;
  approvalsReviewer?: string;
  input?: UnknownRecord[];
}

interface TestRpcMessage extends UnknownRecord {
  id?: string | number;
  method?: string;
  params: TestRpcParams;
}

interface TestSocket extends EventEmitter {
  readyState: number;
  send(data: string): void;
  close(): void;
}

type TestWebSocket = TestSocket & WebSocket;

interface FakeProxyOptions {
  empty?: boolean;
  emptyRolloutError?: string;
  loaded?: string[];
  updatedAt?: Record<string, number>;
  status?: TestStatus;
  readThread?: ((threadId: string) => TestThread) | null;
  listThread?: ((threadId: string) => TestThread) | null;
  readWait?: PromiseLike<unknown> | null;
  metadataReadWait?: PromiseLike<unknown> | null;
  resumeThread?: ((threadId: string) => TestThread) | null;
  resumeError?: string | null;
  resumeWait?: PromiseLike<unknown> | null;
  listWaits?: Array<PromiseLike<unknown> | null>;
  fixedListNextCursor?: string | null;
  listResult?: (index: number, fallback: UnknownRecord) => unknown;
  turnStartWait?: PromiseLike<unknown> | null;
  turnStartReply?: boolean;
  turnSteerReply?: boolean;
  parentThreadIds?: Record<string, string | null>;
  ephemeralThreadIds?: string[];
  initialGoal?: TestGoal | null;
  goalGetWait?: PromiseLike<unknown> | null;
  goalSetWait?: PromiseLike<unknown> | null;
  goalSetWaits?: Array<PromiseLike<unknown> | null>;
  goalSetError?: boolean;
  goalClearWait?: PromiseLike<unknown> | null;
  userAgent?: string;
}

interface TestOutbox extends UnknownRecord {
  version?: number;
  queues: UnknownRecord[];
  receipts: UnknownRecord[];
}

function fixtureThread(status: TestStatus = { type: 'idle' }): TestThread {
  return {
    id: 'thread-1', status,
    gitInfo: { branch: 'main', sha: 'abc123', originUrl: null },
    turns: [{
      id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'agent-1', type: 'agentMessage', text: 'world' },
        { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/work', commandActions: [], status: 'completed', aggregatedOutput: '/work\n' },
        { id: 'files-1', type: 'fileChange', status: 'completed', changes: [
          { path: '/work/a.js', kind: { type: 'update' }, diff: '@@\n-old\n+new' },
          { path: '/work/b.js', kind: { type: 'add' }, diff: '@@\n+created' },
        ] },
        { id: 'web-1', type: 'webSearch', query: 'Codex docs', action: { type: 'search', query: 'Codex docs', queries: null }, results: [{ url: 'https://example.com' }] },
        { id: 'mcp-1', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'Codex' }, result: { content: [] }, error: null },
        { id: 'dynamic-1', type: 'dynamicToolCall', namespace: null, tool: 'custom', arguments: { value: 1 }, status: 'completed', contentItems: [{ type: 'inputText', text: 'done' }], success: true },
        { id: 'image-1', type: 'imageView', path: '/work/screenshot.png' },
        { id: 'sleep-1', type: 'sleep', durationMs: 1000 },
        { id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'thread-1', receiverThreadIds: ['thread-2'], prompt: 'review', model: null, reasoningEffort: null, agentsStates: { 'thread-2': { status: 'completed' } } },
        { id: 'generated-1', type: 'imageGeneration', status: 'completed', revisedPrompt: 'a diagram', result: 'done', savedPath: '/work/generated.png' },
        { id: 'compact-1', type: 'contextCompaction' },
      ],
    }],
  };
}

function memoryStore(initial: TestOutbox | null = null) {
  let value: TestOutbox | null = initial == null ? null : structuredClone(initial);
  const quarantined: TestOutbox[] = [];
  return {
    read: vi.fn(() => (value == null ? null : structuredClone(value))),
    readStrict: vi.fn(() => (value == null ? null : structuredClone(value))),
    write: vi.fn((next: unknown) => { value = structuredClone(next) as TestOutbox; }),
    quarantine: vi.fn(() => {
      if (value == null) return null;
      quarantined.push(structuredClone(value));
      value = null;
      return `memory.corrupt.${quarantined.length}`;
    }),
    snapshot: () => structuredClone(value) as TestOutbox,
    quarantined: () => structuredClone(quarantined),
  };
}

function fakeProxy({
  empty = false, emptyRolloutError = 'no rollout found for thread id thread-1',
  loaded = ['thread-1'], updatedAt = {}, status = { type: 'idle' }, readThread = null, listThread = null,
  readWait = null, metadataReadWait = null, resumeThread = null, resumeError = null, resumeWait = null,
  listWaits = [], fixedListNextCursor = null, listResult,
  turnStartWait = null, turnStartReply = true, turnSteerReply = true,
  parentThreadIds = {}, ephemeralThreadIds = [], initialGoal = null,
  goalGetWait = null, goalSetWait = null, goalSetWaits = [], goalSetError = false,
  goalClearWait = null, userAgent = 'codex-cli/0.149.1',
}: FakeProxyOptions = {}) {
  const ws = new EventEmitter() as TestSocket;
  ws.readyState = 0;
  const sent: TestRpcMessage[] = [];
  let persisted = !empty;
  let goal = initialGoal;
  let goalSetCount = 0;
  let listCount = 0;
  let nextGoalCreatedAt = Math.max(1, Number(initialGoal?.createdAt || 0) + 1);
  const reply = (message: unknown) => queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify(message))));
  ws.send = (data: string) => {
    const message = JSON.parse(data) as TestRpcMessage;
    sent.push(message);
    if (message.id == null) return;
    if (message.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: message.id, result: { userAgent } });
    }
    else if (message.method === 'thread/loaded/list') {
      reply({ jsonrpc: '2.0', id: message.id, result: { data: loaded, nextCursor: null } });
    } else if (message.method === 'thread/resume') {
      const finish = () => {
        if (resumeError) reply({
          jsonrpc: '2.0', id: message.id, error: { code: -32600, message: resumeError },
        });
        else if (!persisted) reply({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32600, message: emptyRolloutError },
        });
        else {
          const source = resumeThread ? resumeThread(message.params.threadId!) : fixtureThread(status);
          const limit = Number(recordOf(message.params.initialTurnsPage)?.limit || 2);
          const initialTurns = [...source.turns].reverse().slice(0, limit);
          reply({ jsonrpc: '2.0', id: message.id, result: {
          thread: {
            ...source,
            id: message.params.threadId, updatedAt: updatedAt[message.params.threadId!],
            ...(message.params.excludeTurns ? { turns: [] } : {}),
          },
          ...(message.params.initialTurnsPage ? {
            initialTurnsPage: { data: initialTurns, nextCursor: null },
          } : {}),
          model: 'gpt-test', modelProvider: 'openai', serviceTier: null, cwd: '/work', approvalPolicy: 'on-request',
          runtimeWorkspaceRoots: ['/work', '/shared'],
          approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, activePermissionProfile: null,
          reasoningEffort: 'high', multiAgentMode: 'explicitRequestOnly',
        } });
        }
      };
      if (resumeWait) void Promise.resolve(resumeWait).then(finish);
      else finish();
    } else if (message.method === 'thread/read') {
      const finish = () => {
        const source = readThread ? readThread(message.params.threadId!) : fixtureThread();
        const thread = message.params.includeTurns === false ? { ...source, turns: [] } : source;
        reply({ jsonrpc: '2.0', id: message.id, result: { thread: {
          ...thread, id: message.params.threadId, updatedAt: updatedAt[message.params.threadId!],
          parentThreadId: parentThreadIds[message.params.threadId!] ?? null,
          ephemeral: ephemeralThreadIds.includes(message.params.threadId!),
        } } });
      };
      const wait = message.params.includeTurns === false ? metadataReadWait : readWait;
      if (wait) void Promise.resolve(wait).then(finish);
      else finish();
    } else if (message.method === 'thread/turns/list') {
      const listIndex = listCount++;
      const finish = () => {
        const source = listThread ? listThread(message.params.threadId!)
          : readThread ? readThread(message.params.threadId!) : fixtureThread();
        const offset = Number(message.params.cursor || 0);
        const limit = Number(message.params.limit || source.turns.length);
        const ordered = message.params.sortDirection === 'asc'
          ? [...source.turns]
          : [...source.turns].reverse();
        const data = ordered.slice(offset, offset + limit);
        const nextOffset = offset + data.length;
        const fallback = {
          data, nextCursor: fixedListNextCursor
            ?? (nextOffset < ordered.length ? String(nextOffset) : null),
        };
        reply({
          jsonrpc: '2.0', id: message.id,
          result: listResult ? listResult(listIndex, fallback) : fallback,
        });
      };
      const listWait = listWaits[listIndex] ?? readWait;
      if (listWait) void Promise.resolve(listWait).then(finish);
      else finish();
    } else if (message.method === 'turn/start') {
      persisted = true;
      const finish = () => reply({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
      if (turnStartReply) {
        if (turnStartWait) void Promise.resolve(turnStartWait).then(finish);
        else finish();
      }
    } else if (message.method === 'turn/steer') {
      if (turnSteerReply) {
        reply({ jsonrpc: '2.0', id: message.id, result: { turnId: message.params.expectedTurnId } });
      }
    } else if (message.method === 'thread/compact/start') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'thread/start') {
      reply({ jsonrpc: '2.0', id: message.id, result: {
        thread: { id: 'thread-clear', status: { type: 'idle' }, turns: [] },
        model: message.params.model || 'gpt-test', modelProvider: message.params.modelProvider || 'openai',
        serviceTier: message.params.serviceTier ?? null, cwd: message.params.cwd || '/work',
        runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots || [],
        approvalPolicy: message.params.approvalPolicy || 'on-request',
        approvalsReviewer: message.params.approvalsReviewer || 'user',
        sandbox: { type: 'workspaceWrite' }, activePermissionProfile: null,
        reasoningEffort: 'high', multiAgentMode: 'explicitRequestOnly',
      } });
    } else if (message.method === 'model/list') {
      reply({ jsonrpc: '2.0', id: message.id, result: { data: [{ id: 'model-1', model: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium' }], nextCursor: null } });
    } else if (message.method === 'thread/goal/get') {
      const resultGoal = goal;
      const finish = () => reply({ jsonrpc: '2.0', id: message.id, result: { goal: resultGoal } });
      if (goalGetWait) void Promise.resolve(goalGetWait).then(finish);
      else finish();
    } else if (message.method === 'thread/goal/set') {
      const resultGoal = goalSetError ? null : {
        threadId: message.params.threadId!,
        objective: message.params.objective ?? goal?.objective ?? '',
        status: message.params.status ?? goal?.status ?? 'active',
        createdAt: goal?.createdAt ?? nextGoalCreatedAt++,
        updatedAt: 2,
        tokensUsed: goal?.tokensUsed ?? 0,
        timeUsedSeconds: goal?.timeUsedSeconds ?? 0,
        tokenBudget: goal?.tokenBudget ?? null,
      };
      if (resultGoal) goal = resultGoal;
      const finish = () => reply(goalSetError
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'goal set failed' } }
        : { jsonrpc: '2.0', id: message.id, result: { goal: resultGoal } });
      const wait = goalSetWaits[goalSetCount++] ?? goalSetWait;
      if (wait) void Promise.resolve(wait).then(finish);
      else finish();
    } else if (message.method === 'thread/goal/clear') {
      goal = null;
      const finish = () => reply({ jsonrpc: '2.0', id: message.id, result: {} });
      if (goalClearWait) void Promise.resolve(goalClearWait).then(finish);
      else finish();
    } else if (message.method === 'thread/settings/update') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'turn/interrupt') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  queueMicrotask(() => { ws.readyState = 1; ws.emit('open'); });
  return {
    ws: ws as TestWebSocket,
    sent,
    setServerGoal(next: TestGoal | null) { goal = next; },
    push: (message: unknown) => reply(message),
  };
}

function failedProxy(error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) {
  const ws = new EventEmitter() as TestSocket;
  ws.readyState = 0;
  ws.send = () => {};
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  queueMicrotask(() => ws.emit('error', error));
  return ws as TestWebSocket;
}

function stalledProxy() {
  const ws = new EventEmitter() as TestSocket;
  ws.readyState = 0;
  ws.send = () => {};
  ws.close = vi.fn(() => {
    if (ws.readyState === 3) return;
    ws.readyState = 3;
    ws.emit('close');
  });
  return ws as TestWebSocket;
}

describe('Codex App Server projection', () => {
  it('projects authoritative items into the existing chat contract', () => {
    const messages = projectCodexThread(fixtureThread());
    expect(messages.map((message) => message.type)).toEqual([
      'text', 'text', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'compact',
    ]);
    expect(messages[0]).toMatchObject({ id: 'codex:turn-1:user-1', k: 0, role: 'user', text: 'hello' });
    expect(messages[2]?.tool).toMatchObject({ name: 'exec_command', result: '/work\n', isError: false, outcome: 'success' });
    expect(messages.slice(3, 5).map((message) => message.tool?.input.file_path)).toEqual(['/work/a.js', '/work/b.js']);
    expect(messages.slice(5, 12).map((message) => message.tool?.name)).toEqual([
      'web__run', 'docs:search', 'custom', 'view_image', 'wait', 'spawn_agent', 'image_gen__imagegen',
    ]);
    expect(messages[5]?.tool?.result).toContain('https://example.com');
    expect(messages[10]?.tool?.input).toMatchObject({ target: 'thread-2', prompt: 'review' });
    expect(messages[7]?.tool).toMatchObject({ name: 'custom', outcome: 'success' });
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });

  it('keeps persisted declines distinct and treats dynamic completion without success as neutral', () => {
    const thread = fixtureThread();
    firstTurn(thread).items = [
      { id: 'cmd-declined', type: 'commandExecution', command: 'sw_vers', cwd: '/work', status: 'declined' },
      {
        id: 'dynamic-unknown', type: 'dynamicToolCall', tool: 'functions.exec', arguments: {},
        status: 'completed', contentItems: [{ type: 'inputText', text: 'aborted by user' }], success: null,
      },
    ];
    const messages = projectCodexThread(thread);
    expect(messages[0]?.tool).toMatchObject({ outcome: 'declined', isError: false });
    expect(messages[1]?.tool).toMatchObject({ outcome: 'completed', isError: false, result: 'aborted by user' });
  });

  it('keeps message identity stable when a snapshot inserts an earlier item', () => {
    const before = projectCodexThread(fixtureThread());
    const thread = fixtureThread();
    firstTurn(thread).items.unshift({ id: 'reasoning-0', type: 'reasoning', summary: ['thinking'], content: [] });
    const after = projectCodexThread(thread);
    const beforeHello = before.find((message) => message.text === 'hello');
    expect(beforeHello).toBeDefined();
    expect(after.find((message) => message.text === 'hello')).toMatchObject({
      id: beforeHello!.id,
      k: beforeHello!.k + 1,
    });
  });

  it('keeps interrupted turns as a visible structural marker', () => {
    const thread = fixtureThread();
    firstTurn(thread).status = 'interrupted';
    expect(projectCodexThread(thread).at(-1)?.type).toBe('interrupt');
  });
});

describe('Codex App Server client', () => {
  it('projects native Goal lifecycle notifications into status and the live stream', async () => {
    const initialGoal = {
      threadId: 'thread-1', objective: 'Finish the release', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');

    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-goal', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1',
        goal: { ...initialGoal, status: 'complete', updatedAt: 2, tokensUsed: 500, timeUsedSeconds: 12 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([expect.objectContaining({
      type: 'goal', event: 'complete', threadId: 'thread-1', turnId: 'turn-goal',
      goal: expect.objectContaining({ objective: 'Finish the release', status: 'complete' }),
    })]);
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      goal: { objective: 'Finish the release', status: 'complete', tokensUsed: 500 },
    });
    const replayed: CodexStreamEvent[] = [];
    const unsubscribeReplay = await app.subscribe('%1', 'thread-1', (event) => replayed.push(event));
    expect(replayed).toEqual([expect.objectContaining({
      type: 'goal', event: 'complete', turnId: 'turn-goal',
      goal: expect.objectContaining({ status: 'complete' }),
    })]);
    unsubscribeReplay();

    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null,
        goal: {
          ...initialGoal, objective: 'Ship the release safely', status: 'active', updatedAt: 3,
          tokensUsed: 500, timeUsedSeconds: 12,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toMatchObject({
      type: 'goal', event: 'restarted', turnId: 'turn-goal',
      goal: { objective: 'Ship the release safely', status: 'active' },
    });

    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/cleared', params: { threadId: 'thread-1', turnId: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toMatchObject({ type: 'goalCleared', threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ goal: null });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null,
        goal: { ...initialGoal, objective: 'Ship the release', createdAt: 3, updatedAt: 3 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toMatchObject({
      type: 'goal', event: 'set', goal: { objective: 'Ship the release', status: 'active' },
    });
    unsubscribe();
    app.close();
  });

  it('does not replay a terminal Goal at the chat tail when its originating turn is unknown', async () => {
    const initialGoal = {
      threadId: 'thread-1', objective: 'Finish the release', status: 'complete',
      createdAt: 1, updatedAt: 2, tokensUsed: 500, timeUsedSeconds: 12, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    const unsubscribeReplay = await app.subscribe('%1', 'thread-1', (event) => events.push(event));

    expect(events).toEqual([]);
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      goal: { objective: 'Finish the release', status: 'complete' },
    });
    unsubscribeReplay();
    unsubscribe();
    app.close();
  });

  it('projects the authoritative live turn plan and retains its completed-turn summary', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-plan', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/plan/updated', params: {
        threadId: 'thread-1', turnId: 'turn-plan', explanation: '开始实现',
        plan: [
          { step: '确认协议', status: 'completed' },
          { step: '实现任务条', status: 'inProgress' },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      plan: {
        turnId: 'turn-plan', explanation: '开始实现',
        steps: [
          { step: '确认协议', status: 'completed' },
          { step: '实现任务条', status: 'inProgress' },
        ],
      },
    });

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'turn-plan', status: 'completed', items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      plan: null,
      lastPlan: { turnId: 'turn-plan', steps: expect.any(Array) },
    });
    app.close();
  });

  it('streams agent message deltas only to the matching thread and closes subscribers with the connection', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));

    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-live',
        item: { id: 'agent-live', type: 'agentMessage', text: '' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: 'turn-live', itemId: 'agent-live', delta: '你好',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    const replayed: CodexStreamEvent[] = [];
    const unsubscribeReplay = await app.subscribe('%1', 'thread-1', (event) => replayed.push(event));
    expect(replayed).toEqual([expect.objectContaining({
      type: 'snapshot', turnId: 'turn-live', itemId: 'agent-live', text: '你好',
    })]);
    proxy.push({
      jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'thread-other', turnId: 'turn-live', itemId: 'agent-live', delta: '不应出现',
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-live',
        item: { id: 'agent-live', type: 'agentMessage', text: '你好，完成' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([
      expect.objectContaining({
        type: 'started', threadId: 'thread-1', itemId: 'agent-live',
        eventId: 'thread-1:1', sequence: 1, kind: 'assistantMessage', lifecycle: 'started',
        mutation: expect.objectContaining({
          operation: 'upsert', mode: 'replace',
          message: expect.objectContaining({ id: 'codex:turn-live:agent-live', text: '' }),
        }),
      }),
      expect.objectContaining({
        type: 'delta', delta: '你好', sequence: 2, lifecycle: 'delta',
        mutation: expect.objectContaining({
          operation: 'upsert', mode: 'append',
          message: expect.objectContaining({ id: 'codex:turn-live:agent-live', text: '你好' }),
        }),
      }),
    ]);
    expect(replayed).toEqual([
      expect.objectContaining({ type: 'snapshot', text: '你好' }),
      expect.objectContaining({ type: 'completed', text: '你好，完成' }),
    ]);
    await expect(app.reconcileTranscript('%1', 'thread-1', [{
      id: 'codex:turn-live:agent-live', role: 'assistant', type: 'text',
      turnId: 'turn-live', itemId: 'agent-live', text: '你好，完成',
    }])).resolves.toEqual({ reconciled: 1 });
    expect(replayed.find((event) => event.type === 'conversation')).toMatchObject({
      type: 'conversation', lifecycle: 'persisted',
      mutation: {
        operation: 'upsert', mode: 'replace',
        message: { id: 'codex:turn-live:agent-live', text: '你好，完成', completed: true },
      },
    });
    expect(replayed.at(-1)).toMatchObject({
      type: 'conversationSnapshot', cursor: 6,
      messages: [expect.objectContaining({ id: 'codex:turn-live:agent-live', text: '你好，完成' })],
    });
    await expect(app.reconcileTranscript('%1', 'thread-1', [{
      id: 'codex:turn-live:agent-live', role: 'assistant', type: 'text',
      turnId: 'turn-live', itemId: 'agent-live', text: '你好，完成',
    }])).resolves.toEqual({ reconciled: 0 });
    const completedReplay: CodexStreamEvent[] = [];
    const unsubscribeCompleted = await app.subscribe('%1', 'thread-1', (event) => completedReplay.push(event));
    expect(completedReplay).toEqual([expect.objectContaining({
      type: 'conversationSnapshot', cursor: 6,
      messages: [expect.objectContaining({ id: 'codex:turn-live:agent-live', text: '你好，完成' })],
    })]);
    const cursorReplay: CodexStreamEvent[] = [];
    const firstSequence = recordOf(events[0])?.sequence;
    expect(typeof firstSequence).toBe('number');
    const unsubscribeCursorReplay = await app.subscribe(
      '%1', 'thread-1', (event) => cursorReplay.push(event), firstSequence as number,
    );
    // The browser disconnected before cursor 6. Even though cursor 1 is still inside the live-event
    // journal, the newer durable checkpoint supersedes that partial replay and cannot be missed.
    expect(cursorReplay).toEqual([expect.objectContaining({
      type: 'conversationSnapshot', cursor: 6,
      messages: [expect.objectContaining({ id: 'codex:turn-live:agent-live', text: '你好，完成' })],
    })]);
    const staleReplay: CodexStreamEvent[] = [];
    const unsubscribeStale = await app.subscribe(
      '%1', 'thread-1', (event) => staleReplay.push(event), 999,
    );
    expect(staleReplay).toEqual([expect.objectContaining({
      type: 'conversationSnapshot', cursor: 6,
    })]);
    expect(projectCodexThread(threadFromRead(await app.read('%1', 'thread-1')))
      .find((message) => message.id === 'codex:turn-live:agent-live')?.text).toBe('你好，完成');

    app.close();
    expect(replayed.at(-1)).toMatchObject({ type: 'disconnected', threadId: 'thread-1' });
    unsubscribe();
    unsubscribeReplay();
    unsubscribeCompleted();
    unsubscribeCursorReplay();
    unsubscribeStale();
  });

  it('opens an atomic Conversation checkpoint without replaying the pre-checkpoint journal', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const firstEvents: CodexStreamEvent[] = [];
    const first = await app.observeConversation(
      '%1', 'thread-1', (event) => firstEvents.push(event as CodexStreamEvent),
    );
    expect(first.cursor).toBe(0);
    expect(firstEvents).toEqual([]);

    proxy.push({
      jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: 'turn-live', itemId: 'agent-live', delta: 'new',
      },
    });
    await vi.waitFor(() => expect(firstEvents).toEqual([
      expect.objectContaining({ type: 'delta', sequence: 1, delta: 'new' }),
    ]));

    const secondEvents: CodexStreamEvent[] = [];
    const second = await app.observeConversation(
      '%1', 'thread-1', (event) => secondEvents.push(event as CodexStreamEvent),
    );
    expect(second.cursor).toBe(1);
    // subscribeStream may synchronously materialize the current live overlay, but it is strictly newer
    // than the returned baseline and therefore belongs to the buffered suffix rather than a replay gap.
    expect(secondEvents).toEqual([
      expect.objectContaining({ type: 'snapshot', sequence: 2, text: 'new' }),
    ]);
    first.close();
    second.close();
    app.close();
  });

  it('captures an active Goal that arrives while Conversation observation is still setting up', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const opening = app.observeConversation(
      '%1', 'thread-1', (event) => events.push(event as CodexStreamEvent),
    );

    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null,
        goal: {
          threadId: 'thread-1', objective: 'Ship safely', status: 'active',
          createdAt: 20, updatedAt: 20, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
        },
      },
    });

    const observation = await opening;
    expect(events).toEqual([expect.objectContaining({
      type: 'goal', event: 'set', sequence: 1,
      goal: expect.objectContaining({ objective: 'Ship safely', status: 'active', createdAt: 20 }),
    })]);
    observation.close();
    app.close();
  });

  it('does not let a stale Goal get reply overwrite a setup notification', async () => {
    let releaseGoalGet!: () => void;
    const goalGetWait = new Promise<void>((resolve) => { releaseGoalGet = resolve; });
    const oldGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Old Goal', status: 'active',
      createdAt: 10, updatedAt: 10, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal: oldGoal, goalGetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const opening = app.observeConversation(
      '%1', 'thread-1', (event) => events.push(event as CodexStreamEvent),
    );
    await vi.waitFor(() => expect(proxy.sent.some((message) => message.method === 'thread/goal/get')).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-new',
        goal: {
          threadId: 'thread-1', objective: 'New Goal', status: 'active',
          createdAt: 20, updatedAt: 20, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
        },
      },
    });
    await Promise.resolve();
    releaseGoalGet();

    const observation = await opening;
    expect(events).toEqual([expect.objectContaining({
      type: 'goal', event: 'set', turnId: 'turn-new',
      goal: expect.objectContaining({ objective: 'New Goal', createdAt: 20 }),
    })]);
    expect(events.some((event) => event.type === 'goal'
      && event.goal.objective === 'Old Goal')).toBe(false);
    observation.close();
    app.close();
  });

  it('uses Goal revision to reject a stale get reply after a progress-only notification', async () => {
    let releaseGoalGet!: () => void;
    const goalGetWait = new Promise<void>((resolve) => { releaseGoalGet = resolve; });
    const oldGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Ship safely', status: 'active',
      createdAt: 10, updatedAt: 10, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal: oldGoal, goalGetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.discover('%1');
    // Seed the lifecycle before observing. The notification below then changes only progress, so it does
    // not add a Goal journal event and can only be detected by the monotonic Goal state revision.
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null, goal: oldGoal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events: CodexStreamEvent[] = [];
    const opening = app.observeConversation(
      '%1', 'thread-1', (event) => events.push(event as CodexStreamEvent),
    );
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/get'
    ))).toHaveLength(1));
    const progressGoal = {
      ...oldGoal, updatedAt: 20, tokensUsed: 50, timeUsedSeconds: 5,
    };
    proxy.setServerGoal(progressGoal);
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-current',
        goal: progressGoal,
      },
    });
    await Promise.resolve();
    releaseGoalGet();

    const observation = await opening;
    expect(events).toEqual([expect.objectContaining({
      type: 'goal', event: 'set', turnId: 'turn-current', observationSnapshot: true,
      goal: expect.objectContaining({
        objective: 'Ship safely', createdAt: 10, updatedAt: 20, tokensUsed: 50,
      }),
    })]);
    observation.close();
    app.close();
  });

  it('reuses the original Goal lifecycle and turn in a current-state observation snapshot', async () => {
    const activeThread = fixtureThread({ type: 'active', activeFlags: [] });
    activeThread.turns = [{ id: 'turn-current', status: 'inProgress', items: [] }];
    const proxy = fakeProxy({ resumeThread: () => activeThread });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.startGoal('%1', 'thread-1', 'Ship safely');
    const events: CodexStreamEvent[] = [];

    const observation = await app.observeConversation(
      '%1', 'thread-1', (event) => events.push(event as CodexStreamEvent),
    );

    expect(events).toEqual([expect.objectContaining({
      type: 'goal', event: 'set', turnId: 'turn-current', observationSnapshot: true,
      goal: expect.objectContaining({ objective: 'Ship safely', status: 'active' }),
    })]);
    observation.close();
    app.close();
  });

  it('preserves the original Goal lifecycle and turn across pause and resume', async () => {
    const goal: TestGoal = {
      threadId: 'thread-1', objective: 'Ship safely', status: 'active',
      createdAt: 10, updatedAt: 10, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal: goal });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const liveEvents: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => liveEvents.push(event));
    await app.getGoal('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-goal', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null, goal,
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'turn-goal', status: 'completed', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null,
        goal: { ...goal, status: 'paused', updatedAt: 20 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(liveEvents.at(-1)).toMatchObject({ type: 'goalCleared', turnId: null });

    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: null,
        goal: { ...goal, status: 'active', updatedAt: 30 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observed: CodexStreamEvent[] = [];
    const observation = await app.observeConversation(
      '%1', 'thread-1', (event) => observed.push(event as CodexStreamEvent),
    );

    expect(observed).toEqual([expect.objectContaining({
      type: 'goal', event: 'set', turnId: 'turn-goal', observationSnapshot: true,
      goal: expect.objectContaining({ objective: 'Ship safely', status: 'active', createdAt: 10 }),
    })]);
    observation.close();
    unsubscribe();
    app.close();
  });

  it('returns the current Goal when a public get reply loses its revision race', async () => {
    let releaseGoalGet!: () => void;
    const goalGetWait = new Promise<void>((resolve) => { releaseGoalGet = resolve; });
    const oldGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Old Goal', status: 'active',
      createdAt: 10, updatedAt: 10, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal: oldGoal, goalGetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const reading = app.getGoal('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => message.method === 'thread/goal/get')).toBe(true));
    const newGoal = {
      ...oldGoal, objective: 'New Goal', createdAt: 20, updatedAt: 20,
      tokensUsed: 0, timeUsedSeconds: 0,
    };
    proxy.setServerGoal(newGoal);
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-new',
        goal: newGoal,
      },
    });
    await Promise.resolve();
    releaseGoalGet();

    await expect(reading).resolves.toMatchObject({ objective: 'New Goal', createdAt: 20 });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'New Goal', createdAt: 20 },
    });
    app.close();
  });

  it('emits one clear control when public get first observes active Goal removal', async () => {
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    proxy.setServerGoal(null);

    await expect(app.getGoal('%1', 'thread-1')).resolves.toBeNull();
    await expect(app.getGoal('%1', 'thread-1')).resolves.toBeNull();

    expect(events.filter((event) => event.type === 'goalCleared')).toHaveLength(1);
    unsubscribe();
    app.close();
  });

  it('resets a stale client cursor after the server event journal restarts', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event), 99);

    expect(events).toEqual([{ type: 'cursorReset', threadId: 'thread-1', cursor: 0 }]);
    unsubscribe();
    app.close();
  });

  it('advances the reconnect cursor for rollout-only snapshot changes', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const unsubscribeSeed = await app.subscribe('%1', 'thread-1', () => {});
    const tool = (result: string) => ({
      k: 0, i: 0, role: 'assistant', type: 'tool', turnId: 'turn-tool',
      tool: { name: 'Bash', input: { command: 'npm test' }, result, isError: false },
    });

    // Tool messages do not create a live text mutation, but their durable contents still belong to the
    // unified conversation state and therefore must advance the same reconnect cursor.
    await expect(app.reconcileTranscript('%1', 'thread-1', [tool('running')]))
      .resolves.toEqual({ reconciled: 0 });
    await expect(app.reconcileTranscript('%1', 'thread-1', [tool('passed')]))
      .resolves.toEqual({ reconciled: 0 });

    const replayed: CodexStreamEvent[] = [];
    const unsubscribeReplay = await app.subscribe(
      '%1', 'thread-1', (event) => replayed.push(event), 1,
    );
    expect(replayed).toEqual([expect.objectContaining({
      type: 'conversationSnapshot', cursor: 2,
      messages: [expect.objectContaining({
        type: 'tool', tool: expect.objectContaining({ result: 'passed' }),
      })],
    })]);

    unsubscribeSeed();
    unsubscribeReplay();
    app.close();
  });

  it('discovers and sends the first message to a loaded thread before its rollout exists', async () => {
    const proxy = fakeProxy({
      empty: true,
      // Immediately after turn/start, thread/resume may know the active turn before its user item arrives.
      resumeThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [{ id: 'turn-2', status: 'inProgress', items: [] }],
      }),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, status: { type: 'idle' } });
    await app.send('%1', 'thread-1', 'first message');
    expect(proxy.sent.filter((message) => message.method === 'thread/resume').length).toBeGreaterThanOrEqual(2);
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start' }));
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'working', msg: 'first message' });
    app.close();
  });

  it('sends the first message when Codex reports that the new rollout is empty', async () => {
    const proxy = fakeProxy({
      empty: true,
      emptyRolloutError: 'failed to read thread: thread-store internal error: failed to read session metadata: rollout /home/test/rollout.jsonl is empty',
      resumeThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [{ id: 'turn-2', status: 'inProgress', items: [] }],
      }),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-1' });
    await expect(app.send('%1', 'thread-1', 'first message', 'request-first')).resolves.toMatchObject({
      turn: { id: 'turn-2' },
    });
    expect((await app.status('%1', 'thread-1')).receipts).toEqual([{
      requestId: 'request-first', status: 'accepted', turnId: 'turn-2',
    }]);
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    app.close();
  });

  it('rejects an empty-rollout thread that is not loaded by the current App Server', async () => {
    const emptyRolloutError = 'failed to read session metadata: rollout /home/test/rollout.jsonl is empty';
    const proxy = fakeProxy({ empty: true, emptyRolloutError, loaded: [] });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: null });

    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { thread: { id: 'thread-1', parentThreadId: null } },
    });
    await Promise.resolve();

    await expect(app.status('%1', 'thread-1')).rejects.toThrow(emptyRolloutError);
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(0);
    app.close();
  });

  it('resumes the exact thread, sends turns, and resolves a structured approval once', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ settings: { model: 'gpt-test', effort: 'high' } });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ gitBranch: 'main' });
    await app.send('%1', 'thread-1', 'continue');
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'continue' }] } }));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'working', msg: 'continue' });

    const interactionSnapshots: Array<{ cursor: number; approvals: unknown[] }> = [];
    const interactions = await app.observeInteractions('%1', 'thread-1', (snapshot) => {
      interactionSnapshots.push(snapshot);
    });
    expect(interactions).toMatchObject({ approvals: [], userInputs: [] });

    proxy.push({
      jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'cmd-2', command: 'npm test', cwd: '/work', startedAtMs: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = await app.status('%1', 'thread-1');
    expect(pending.approvals[0]).toMatchObject({ id: '91', type: 'command', command: 'npm test' });
    expect(interactionSnapshots.at(-1)).toMatchObject({ approvals: [{ id: '91' }] });
    await app.decide('%1', 'thread-1', '91', 'accept');
    expect(proxy.sent).toContainEqual({ jsonrpc: '2.0', id: 91, result: { decision: 'accept' } });
    expect((await app.status('%1', 'thread-1')).approvals).toEqual([]);
    expect(interactionSnapshots.at(-1)).toMatchObject({ approvals: [] });
    expect(interactionSnapshots.at(-1)!.cursor).toBeGreaterThan(interactions.cursor);
    interactions.close();
    app.close();
  });

  it('shares one in-flight thread resume across concurrent consumers', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });

    const [first, second, unsubscribe] = await Promise.all([
      app.status('%1', 'thread-1'),
      app.status('%1', 'thread-1'),
      app.subscribe('%1', 'thread-1', () => {}),
    ]);

    expect(first).toMatchObject({ managed: true, threadId: 'thread-1' });
    expect(second).toMatchObject({ managed: true, threadId: 'thread-1' });
    expect(proxy.sent.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
    unsubscribe();
    app.close();
  });

  it('resumes with a bounded summary page and restores active and terminal turn state', async () => {
    const proxy = fakeProxy({
      resumeThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [
          {
            id: 'turn-completed', status: 'completed', startedAt: 1, completedAt: 2,
            items: [{ id: 'agent-completed', type: 'agentMessage', text: 'previous result' }],
          },
          {
            id: 'turn-active', status: 'inProgress', startedAt: 3,
            items: [{
              id: 'user-active', type: 'userMessage',
              content: [{ type: 'text', text: 'continue working' }],
            }],
          },
        ],
      }),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      activeTurnId: 'turn-active', lastTurn: { status: 'completed' }, activityKind: 'working',
    });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/resume',
      params: {
        threadId: 'thread-1', excludeTurns: true,
        initialTurnsPage: { limit: 2, sortDirection: 'desc', itemsView: 'summary' },
      },
    }));
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'working', msg: 'continue working' });
    app.close();
  });

  it('uses the originator version from the real Handmux initialize user agent', async () => {
    const proxy = fakeProxy({
      userAgent: 'handmux/0.149.0 (macOS 15.6; arm64) rustc/1.92.0',
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      managed: true, lastTurn: { status: 'completed' },
    });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/resume',
      params: {
        threadId: 'thread-1', excludeTurns: true,
        initialTurnsPage: { limit: 2, sortDirection: 'desc', itemsView: 'summary' },
      },
    }));
    app.close();
  });

  it('keeps lightweight usage and plan events while applying an in-flight resume snapshot', async () => {
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const proxy = fakeProxy({
      resumeWait,
      resumeThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [{ id: 'turn-plan', status: 'inProgress', items: [] }],
      }),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => message.method === 'thread/resume')).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-1', turnId: 'turn-plan',
        tokenUsage: {
          total: { totalTokens: 999999 },
          last: { totalTokens: 159719 },
          modelContextWindow: 258400,
        },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/plan/updated', params: {
        threadId: 'thread-1', turnId: 'turn-plan', explanation: '开始实现',
        plan: [
          { step: '确认协议', status: 'completed' },
          { step: '实现任务条', status: 'inProgress' },
        ],
      },
    });
    await Promise.resolve();
    releaseResume();

    await expect(opening).resolves.toMatchObject({
      status: { type: 'active' },
      activeTurnId: 'turn-plan',
      settings: { model: 'gpt-test', effort: 'high' },
      contextUsage: { usedTokens: 159719, totalTokens: 258400 },
      plan: {
        turnId: 'turn-plan', explanation: '开始实现',
        steps: [
          { step: '确认协议', status: 'completed' },
          { step: '实现任务条', status: 'inProgress' },
        ],
      },
    });
    app.close();
  });

  it('merges partial live settings over resume-only settings during resume', async () => {
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const proxy = fakeProxy({ resumeWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => message.method === 'thread/resume')).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/settings/updated', params: {
        threadId: 'thread-1',
        threadSettings: { model: 'gpt-live', effort: 'medium' },
      },
    });
    await Promise.resolve();
    releaseResume();

    await expect(opening).resolves.toMatchObject({
      status: { type: 'idle' },
      lastTurn: { status: 'completed' },
      settings: {
        model: 'gpt-live', effort: 'medium',
        runtimeWorkspaceRoots: ['/work', '/shared'],
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite' },
        multiAgentMode: 'explicitRequestOnly',
      },
    });
    app.close();
  });

  it('keeps a live completion authoritative while resume reconciles older receipts', async () => {
    let releaseTurns!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseTurns = resolve; });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'active', activeFlags: [] },
      turns: [
        {
          id: 'turn-delivered-before-resume', status: 'completed', items: [{
            id: 'user-delivered-before-resume', type: 'userMessage', clientId: 'request-resume-race',
            content: [{ type: 'text', text: 'already delivered' }],
          }],
        },
        { id: 'turn-middle-before-resume', status: 'completed', items: [] },
        { id: 'turn-resume-race', status: 'inProgress', items: [] },
      ],
    });
    const outboxStore = memoryStore({
      version: 1, queues: [], receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-resume-race', text: 'already delivered',
        status: 'pending', createdAt: 10, updatedAt: 10,
      }],
    });
    const proxy = fakeProxy({ resumeThread: history, readThread: history, readWait });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-resume-race', status: 'completed', completedAt: 20, items: [] },
      },
    });
    await Promise.resolve();
    releaseTurns();

    await expect(opening).resolves.toMatchObject({
      status: { type: 'idle' }, activeTurnId: null, lastTurn: { status: 'completed' },
      activityKind: 'done',
      settings: {
        model: 'gpt-test', runtimeWorkspaceRoots: ['/work', '/shared'],
        approvalsReviewer: 'user', multiAgentMode: 'explicitRequestOnly',
      },
      receipts: [{
        requestId: 'request-resume-race', status: 'accepted',
        turnId: 'turn-delivered-before-resume',
      }],
    });
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done' });
    app.close();
  });

  it('keeps a live approval waiting state and complete settings during resume reconciliation', async () => {
    let releaseTurns!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseTurns = resolve; });
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queue-approval-race', text: 'wait safely', createdAt: 10 }],
      }],
      receipts: [],
    });
    const activeHistory = (): TestThread => ({
      id: 'thread-1', status: { type: 'active', activeFlags: [] },
      turns: [{ id: 'turn-approval-race', status: 'inProgress', items: [] }],
    });
    const proxy = fakeProxy({ resumeThread: activeHistory, readThread: activeHistory, readWait });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', id: 92, method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1', turnId: 'turn-approval-race', itemId: 'cmd-approval-race',
        command: 'npm test', cwd: '/work', reason: '需要确认',
      },
    });
    await Promise.resolve();
    releaseTurns();

    await expect(opening).resolves.toMatchObject({
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      activeTurnId: null,
      activityKind: 'permission',
      settings: {
        model: 'gpt-test', runtimeWorkspaceRoots: ['/work', '/shared'],
        approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' },
        multiAgentMode: 'explicitRequestOnly',
      },
      approvals: [{ id: '92', type: 'command', command: 'npm test' }],
    });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('refreshes control state without requesting complete thread turns', async () => {
    const proxy = fakeProxy({
      readThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [{
          id: 'turn-current', status: 'inProgress', items: [{
            id: 'user-current', type: 'userMessage',
            content: [{ type: 'text', text: 'bounded refresh' }],
          }],
        }],
      }),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: {} },
    });
    await Promise.resolve();

    await app.read('%1', 'thread-1');

    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false },
    }));
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/turns/list',
      params: {
        threadId: 'thread-1', limit: 2, sortDirection: 'desc', itemsView: 'summary',
      },
    }));
    expect(proxy.sent.some((message) => (
      message.method === 'thread/read' && message.params.includeTurns === true
    ))).toBe(false);
    app.close();
  });

  it('does not let a two-RPC refresh revive active state after a completion event', async () => {
    let releaseTurns!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseTurns = resolve; });
    const staleActive = (): TestThread => ({
      id: 'thread-1', status: { type: 'active', activeFlags: [] },
      turns: [{
        id: 'turn-race', status: 'inProgress', items: [{
          id: 'user-race', type: 'userMessage',
          content: [{ type: 'text', text: 'finish during refresh' }],
        }],
      }],
    });
    const proxy = fakeProxy({ resumeThread: staleActive, readThread: staleActive, readWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: {} },
    });
    await Promise.resolve();

    const reading = app.read('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-race', status: 'completed', completedAt: 10, items: [] },
      },
    });
    await Promise.resolve();
    releaseTurns();
    await reading;

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      status: { type: 'idle' }, activeTurnId: null, lastTurn: { status: 'completed' },
      activityKind: 'done',
    });
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done' });
    app.close();
  });

  it('applies a fresh refresh base while retaining lightweight usage and plan overlays', async () => {
    let releaseTurns!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseTurns = resolve; });
    const freshActive = (): TestThread => ({
      id: 'thread-1', status: { type: 'active', activeFlags: [] },
      turns: [{ id: 'turn-refresh-plan', status: 'inProgress', items: [] }],
    });
    const proxy = fakeProxy({ readThread: freshActive, readWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: {} },
    });
    await Promise.resolve();

    const reading = app.read('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-1', turnId: 'turn-refresh-plan',
        tokenUsage: {
          total: { totalTokens: 999999 }, last: { totalTokens: 159719 },
          modelContextWindow: 258400,
        },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/plan/updated', params: {
        threadId: 'thread-1', turnId: 'turn-refresh-plan', explanation: '刷新中保留',
        plan: [{ step: '应用最新状态', status: 'inProgress' }],
      },
    });
    await Promise.resolve();
    releaseTurns();
    await reading;

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      status: { type: 'active' }, activeTurnId: 'turn-refresh-plan',
      contextUsage: { usedTokens: 159719, totalTokens: 258400 },
      plan: {
        turnId: 'turn-refresh-plan', explanation: '刷新中保留',
        steps: [{ step: '应用最新状态', status: 'inProgress' }],
      },
    });
    const reads = proxy.sent.filter((message) => message.method === 'thread/read').length;
    const lists = proxy.sent.filter((message) => message.method === 'thread/turns/list').length;
    await app.read('%1', 'thread-1');
    expect(proxy.sent.filter((message) => message.method === 'thread/read')).toHaveLength(reads);
    expect(proxy.sent.filter((message) => message.method === 'thread/turns/list')).toHaveLength(lists);
    app.close();
  });

  it('gives old Codex versions an actionable error when a large resume exceeds the payload limit', async () => {
    const proxy = fakeProxy({
      userAgent: 'codex-cli/0.148.0', resumeError: 'Max payload size exceeded',
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await expect(app.status('%1', 'thread-1'))
      .rejects.toThrow('upgrade Codex CLI to 0.149.0 or newer');
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/resume', params: { threadId: 'thread-1' },
    }));
    app.close();
  });

  it('keeps the legacy path working for a known older Codex version and a small thread', async () => {
    const proxy = fakeProxy({ userAgent: 'codex-cli/0.148.0' });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      managed: true, lastTurn: { status: 'completed' },
    });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/resume', params: { threadId: 'thread-1' },
    }));
    app.close();
  });

  it('does not silently use unbounded history when the Codex version is unknown', async () => {
    const proxy = fakeProxy({ userAgent: 'handmux/dev (rustc/1.92.0)' });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await expect(app.status('%1', 'thread-1'))
      .rejects.toThrow('version could not be identified');
    expect(proxy.sent.filter((message) => message.method === 'thread/resume')).toEqual([]);
    app.close();
  });

  it('preserves App Server structured approval choices and returns the selected decision verbatim', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    const remembered = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['uname', '-s'] } };
    proxy.push({
      jsonrpc: '2.0', id: 94, method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', itemId: 'cmd-3', command: 'uname -s', cwd: '/work',
        availableDecisions: ['accept', remembered, 'decline'],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      approvals: [{
        id: '94',
        decisions: ['accept', { id: 'structured:1', type: 'execpolicy', rule: ['uname', '-s'] }, 'decline'],
      }],
    });
    await app.decide('%1', 'thread-1', '94', 'structured:1');
    expect(proxy.sent).toContainEqual({ jsonrpc: '2.0', id: 94, result: { decision: remembered } });
    app.close();
  });

  it('queues messages in order while a turn is active instead of starting overlapping turns', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = await app.send('%1', 'thread-1', 'first queued');
    const second = await app.send('%1', 'thread-1', 'second queued');

    expect(first).toMatchObject({ queued: true, item: { text: 'first queued' } });
    expect(second).toMatchObject({ queued: true, item: { text: 'second queued' } });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect((await app.status('%1', 'thread-1')).queue.map((item) => item.text))
      .toEqual(['first queued', 'second queued']);
    app.close();
  });

  it('deduplicates a retried send and exposes its request id in the authoritative queue', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = await app.send('%1', 'thread-1', 'only once', 'request-1');
    const retry = await app.send('%1', 'thread-1', 'only once', 'request-1');
    const firstItem = queueItemOf(first);

    expect(retry).toEqual(first);
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      queue: [expect.objectContaining({
        id: firstItem.id, requestId: 'request-1', text: 'only once',
      })],
      receipts: [{ requestId: 'request-1', status: 'queued', queueItemId: firstItem.id }],
    });
    await expect(app.send('%1', 'thread-1', 'different text', 'request-1'))
      .rejects.toThrow('request id was already used');
    app.close();
  });

  it('restores a durable queue after a Handmux restart and deduplicates its request id', async () => {
    const outboxStore = memoryStore();
    const firstProxy = fakeProxy();
    const firstApp = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => firstProxy.ws, outboxStore,
    });
    await firstApp.status('%1', 'thread-1');
    firstProxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = await firstApp.send('%1', 'thread-1', 'survive restart', 'request-durable');
    const firstItem = queueItemOf(first);
    expect(outboxStore.snapshot()).toMatchObject({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [{
        id: firstItem.id, text: 'survive restart', requestId: 'request-durable',
      }] }],
      receipts: [{ requestId: 'request-durable', status: 'queued', queueItemId: firstItem.id }],
    });
    firstApp.close();

    const secondProxy = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const secondApp = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => secondProxy.ws, outboxStore,
    });
    expect((await secondApp.status('%1', 'thread-1')).queue).toEqual([firstItem]);
    await expect(secondApp.send('%1', 'thread-1', 'survive restart', 'request-durable'))
      .resolves.toEqual(first);
    expect(secondProxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    await secondApp.removeQueued('%1', 'thread-1', firstItem.id);
    expect(outboxStore.snapshot()).toMatchObject({ queues: [], receipts: [] });
    secondApp.close();
  });

  it('moves a queued send and its receipt after Server restart when only the replacement pane remains', async () => {
    const outboxStore = memoryStore();
    const firstProxy = fakeProxy();
    const firstApp = createCodexAppServer({
      home: '/home/test', exists: (socketPath) => String(socketPath).endsWith('/1.sock'),
      outboxStore, connect: () => firstProxy.ws,
    });
    await firstApp.status('%1', 'thread-1');
    firstProxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await firstApp.send(
      '%1', 'thread-1', 'continue in replacement pane', 'request-replacement-pane',
    ));
    firstApp.close();

    let releaseStart!: () => void;
    const turnStartWait = new Promise<void>((resolve) => { releaseStart = resolve; });
    const secondProxy = fakeProxy({ turnStartWait });
    const secondApp = createCodexAppServer({
      home: '/home/test', exists: (socketPath) => String(socketPath).endsWith('/2.sock'),
      outboxStore, connect: () => secondProxy.ws,
    });

    expect((await secondApp.status('%2', 'thread-1')).queue).toEqual([queued]);
    await vi.waitFor(() => expect(secondProxy.sent.filter((message) => message.method === 'turn/start'))
      .toEqual([expect.objectContaining({
        params: expect.objectContaining({
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'continue in replacement pane' }],
          clientUserMessageId: 'request-replacement-pane',
        }),
      })]));
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%2', threadId: 'thread-1', items: [{ id: queued.id }] }],
      receipts: [{
        pane: '%2', threadId: 'thread-1', requestId: 'request-replacement-pane',
        status: 'queued', queueItemId: queued.id,
      }],
    });

    releaseStart();
    await vi.waitFor(() => expect(outboxStore.snapshot()).toMatchObject({
      queues: [],
      receipts: [{
        pane: '%2', threadId: 'thread-1', requestId: 'request-replacement-pane',
        status: 'accepted', turnId: 'turn-2',
      }],
    }));
    const starts = secondProxy.sent.filter((message) => message.method === 'turn/start').length;
    await expect(secondApp.send(
      '%2', 'thread-1', 'continue in replacement pane', 'request-replacement-pane',
    )).resolves.toEqual({ queued: false, turn: { id: 'turn-2' } });
    expect(secondProxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(starts);
    secondApp.close();
  });

  it('does not move an outbox from an old pane whose App Server socket is still live', async () => {
    const item = {
      id: 'queue-old-live', text: 'stay on old pane', createdAt: 10, requestId: 'request-old-live',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-old-live', text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    let oldPane: ReturnType<typeof fakeProxy> | undefined;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore,
      connect: (socketPath) => {
        if (socketPath.endsWith('/1.sock')) {
          oldPane ??= fakeProxy();
          return oldPane.ws;
        }
        return replacement.ws;
      },
    });

    expect((await app.status('%2', 'thread-1')).queue).toEqual([]);
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%1', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%1', requestId: 'request-old-live' }],
    });
    app.close();
  });

  it('reconciles history before delivering an outbox migrated into an already subscribed pane', async () => {
    const item = {
      id: 'queue-delayed-migration', text: 'must not run twice', createdAt: 10,
      requestId: 'request-delayed-migration',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [
        {
          id: 'turn-delayed-migration', status: 'completed', items: [{
            id: 'user-delayed-migration', type: 'userMessage', clientId: item.requestId,
            content: [{ type: 'text', text: item.text }],
          }],
        },
        { id: 'turn-delayed-middle', status: 'completed', items: [] },
        { id: 'turn-delayed-latest', status: 'completed', items: [] },
      ],
    });
    let oldPane: ReturnType<typeof fakeProxy> | undefined;
    const replacement = fakeProxy({ resumeThread: history, listThread: history });
    let oldPanePresent = true;
    const app = createCodexAppServer({
      home: '/home/test', outboxStore,
      exists: (socketPath) => !String(socketPath).endsWith('/1.sock') || oldPanePresent,
      connect: (socketPath) => {
        if (socketPath.endsWith('/1.sock')) {
          oldPane ??= fakeProxy();
          return oldPane.ws;
        }
        return replacement.ws;
      },
    });

    expect((await app.status('%2', 'thread-1')).queue).toEqual([]);
    expect(outboxStore.snapshot().queues).toEqual([
      expect.objectContaining({ pane: '%1', threadId: 'thread-1' }),
    ]);

    oldPanePresent = false;
    oldPane!.ws.close();
    await expect(app.status('%2', 'thread-1')).resolves.toMatchObject({
      queue: [], receipts: [{
        requestId: item.requestId, status: 'accepted', turnId: 'turn-delayed-migration',
      }],
    });
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [], receipts: [{
        pane: '%2', requestId: item.requestId, status: 'accepted',
        turnId: 'turn-delayed-migration',
      }],
    });
    expect(replacement.sent.filter((message) => (
      message.method === 'turn/start' || message.method === 'turn/steer'
    ))).toEqual([]);
    app.close();
  });

  it('reads complete legacy history before settling a delayed migration over partial state', async () => {
    const item = {
      id: 'queue-legacy-migration', text: 'already delivered on legacy', createdAt: 10,
      requestId: 'request-legacy-migration',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [{
        id: 'turn-legacy-delivered', status: 'completed', items: [{
          id: 'user-legacy-delivered', type: 'userMessage', clientId: item.requestId,
          content: [{ type: 'text', text: item.text }],
        }],
      }],
    });
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const replacement = fakeProxy({
      userAgent: 'codex-cli/0.148.0', resumeThread: history, readThread: history, resumeWait,
    });
    let oldPane: ReturnType<typeof fakeProxy> | undefined;
    let oldPanePresent = true;
    const app = createCodexAppServer({
      home: '/home/test', outboxStore,
      exists: (socketPath) => !String(socketPath).endsWith('/1.sock') || oldPanePresent,
      connect: (socketPath) => {
        if (socketPath.endsWith('/1.sock')) {
          oldPane ??= fakeProxy();
          return oldPane.ws;
        }
        return replacement.ws;
      },
    });

    const opening = app.status('%2', 'thread-1');
    await vi.waitFor(() => expect(replacement.sent.some((message) => (
      message.method === 'thread/resume'
    ))).toBe(true));
    replacement.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-live-partial', status: 'completed', completedAt: 20, items: [] },
      },
    });
    await Promise.resolve();
    releaseResume();
    await opening;

    oldPanePresent = false;
    oldPane!.ws.close();
    await expect(app.status('%2', 'thread-1')).resolves.toMatchObject({
      queue: [],
      receipts: [{
        requestId: item.requestId, status: 'accepted', turnId: 'turn-legacy-delivered',
      }],
    });
    expect(replacement.sent).toContainEqual(expect.objectContaining({
      method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true },
    }));
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('rechecks complete legacy history before proving absence after a resume event race', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queue-legacy-resume-race', text: 'send only after stable proof', createdAt: 10 }],
      }],
      receipts: [],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [{ id: 'turn-legacy-resting', status: 'completed', items: [] }],
    });
    let releaseResume!: () => void;
    let releaseRead!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const readWait = new Promise<void>((resolve) => { releaseRead = resolve; });
    const proxy = fakeProxy({
      userAgent: 'codex-cli/0.148.0', resumeThread: history, readThread: history,
      resumeWait, readWait,
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/resume'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-legacy-live', status: 'completed', completedAt: 20, items: [] },
      },
    });
    await Promise.resolve();
    releaseResume();
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/read' && message.params.includeTurns === true
    ))).toBe(true));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);

    releaseRead();
    await opening;
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'turn/start'
    ))).toHaveLength(1));
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        input: [{ type: 'text', text: 'send only after stable proof' }],
      }),
    }));
    app.close();
  });

  it('does not let an older exhausted scan settle proof added by a concurrent migration', async () => {
    const first = {
      id: 'queue-first-proof', text: 'first proven unsent', createdAt: 10,
      requestId: 'request-first-proof',
    };
    const migrated = {
      id: 'queue-migrated-proof', text: 'migrated proof waits', createdAt: 20,
      requestId: 'request-migrated-proof',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [
        { pane: '%2', threadId: 'thread-1', items: [first] },
        { pane: '%1', threadId: 'thread-1', items: [migrated] },
      ],
      receipts: [],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: 15 }, (_, index) => ({
        id: `turn-proof-${index}`, status: 'completed',
        items: index === 14 ? [{
          id: 'user-migrated-proof', type: 'userMessage', clientId: migrated.requestId,
          content: [{ type: 'text', text: migrated.text }],
        }] : [],
      })),
    });
    let releaseFirstScan!: () => void;
    let releaseMigratedScan!: () => void;
    const firstScanWait = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
    const migratedScanWait = new Promise<void>((resolve) => { releaseMigratedScan = resolve; });
    const replacement = fakeProxy({
      resumeThread: history,
      listThread: history,
      // The first scan has already consumed the newest page when it pauses on request two. The migrated
      // proof starts its own request while that older scan is still in flight.
      listWaits: [null, firstScanWait, migratedScanWait],
    });
    let oldPane: ReturnType<typeof fakeProxy> | undefined;
    const app = createCodexAppServer({
      home: '/home/test', outboxStore, exists: () => true,
      connect: (socketPath) => {
        if (socketPath.endsWith('/1.sock')) {
          oldPane ??= fakeProxy();
          return oldPane.ws;
        }
        return replacement.ws;
      },
    });

    const opening = app.status('%2', 'thread-1');
    await vi.waitFor(() => expect(replacement.sent.filter((message) => (
      message.method === 'thread/turns/list'
    ))).toHaveLength(2));
    oldPane!.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-other', thread: { id: 'thread-other', parentThreadId: null } },
    });
    await Promise.resolve();
    const rebinding = app.status('%2', 'thread-1');
    await vi.waitFor(() => expect(replacement.sent.filter((message) => (
      message.method === 'thread/turns/list'
    ))).toHaveLength(3));

    releaseFirstScan();
    const opened = await opening;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(opened.queue).toEqual([
      expect.objectContaining({ id: first.id }),
      expect.objectContaining({ id: migrated.id }),
    ]);

    releaseMigratedScan();
    await rebinding;
    await vi.waitFor(() => expect(replacement.sent.filter((message) => (
      message.method === 'turn/start'
    ))).toHaveLength(1));
    expect(replacement.sent).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        input: [{ type: 'text', text: first.text }],
        clientUserMessageId: first.requestId,
      }),
    }));
    expect(replacement.sent.some((message) => (
      message.method === 'turn/start'
      && recordOf(message.params.input?.[0])?.text === migrated.text
    ))).toBe(false);
    app.close();
  });

  it('moves an outbox after a live old pane is authoritatively discovered with no thread', async () => {
    const item = {
      id: 'queue-old-empty', text: 'follow the resumed thread', createdAt: 10,
      requestId: 'request-old-empty',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const oldPane = fakeProxy({ loaded: [] });
    let replacement: ReturnType<typeof fakeProxy> | undefined;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore,
      connect: (socketPath) => socketPath.endsWith('/1.sock') ? oldPane.ws : replacement!.ws,
    });

    await expect(app.discover('%1')).resolves.toEqual({ managed: true, threadId: null });
    replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    expect((await app.status('%2', 'thread-1')).queue).toEqual([item]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%2', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%2', requestId: item.requestId, queueItemId: item.id }],
    });
    app.close();
  });

  it('moves an outbox when the old pane left only an unconnectable socket file', async () => {
    const item = {
      id: 'queue-stale-socket', text: 'recover from dead socket', createdAt: 10,
      requestId: 'request-stale-socket',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore,
      connect: (socketPath) => socketPath.endsWith('/1.sock') ? failedProxy() : replacement.ws,
    });

    expect((await app.status('%2', 'thread-1')).queue).toEqual([item]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%2', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%2', requestId: item.requestId, queueItemId: item.id }],
    });
    app.close();
  });

  it('moves an outbox when the old pane socket never completes its WebSocket handshake', async () => {
    const item = {
      id: 'queue-stalled-socket', text: 'recover from stalled socket', createdAt: 10,
      requestId: 'request-stalled-socket',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const stalled = stalledProxy();
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore, rpcTimeoutMs: 20,
      connect: (socketPath) => socketPath.endsWith('/1.sock') ? stalled : replacement.ws,
    });

    expect((await app.status('%2', 'thread-1')).queue).toEqual([item]);
    expect(stalled.close).toHaveBeenCalledOnce();
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%2', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%2', requestId: item.requestId, queueItemId: item.id }],
    });
    app.close();
  });

  it('does not migrate an outbox after the target pane changes thread during liveness probing', async () => {
    const item = {
      id: 'queue-thread-switch', text: 'keep with original thread', createdAt: 10,
      requestId: 'request-thread-switch',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: item.requestId, text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const target = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    let source: TestWebSocket | undefined;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore, rpcTimeoutMs: 1_000,
      connect: (socketPath) => {
        if (!socketPath.endsWith('/1.sock')) return target.ws;
        source ??= stalledProxy();
        return source;
      },
    });

    const pending = app.status('%2', 'thread-1');
    await vi.waitFor(() => expect(source).toBeDefined());
    target.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-other', thread: { id: 'thread-other', parentThreadId: null } },
    });
    await Promise.resolve();
    source!.emit('error', new Error('old pane unavailable'));

    await expect(pending).rejects.toThrow('Codex session changed');
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%1', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%1', requestId: item.requestId, queueItemId: item.id }],
    });
    app.close();
  });

  it('moves an outbox when the old live pane is authoritatively bound to another thread', async () => {
    const item = {
      id: 'queue-rebound', text: 'follow the thread', createdAt: 10, requestId: 'request-rebound',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-rebound', text: item.text,
        status: 'queued', queueItemId: item.id, createdAt: 10, updatedAt: 10,
      }],
    });
    const oldPane = fakeProxy({
      loaded: ['thread-other'], status: { type: 'active', activeFlags: [] },
    });
    let replacement: ReturnType<typeof fakeProxy> | undefined;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, outboxStore,
      connect: (socketPath) => socketPath.endsWith('/1.sock') ? oldPane.ws : replacement!.ws,
    });
    await app.status('%1', 'thread-other');
    replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });

    expect((await app.status('%2', 'thread-1')).queue).toEqual([item]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%2', threadId: 'thread-1', items: [{ id: item.id }] }],
      receipts: [{ pane: '%2', requestId: 'request-rebound', queueItemId: item.id }],
    });
    app.close();
  });

  it('merges more than one proven orphan pane into the current thread owner', async () => {
    const first = {
      id: 'queue-orphan-1', text: 'one', createdAt: 10, requestId: 'request-orphan-1',
    };
    const second = {
      id: 'queue-orphan-2', text: 'two', createdAt: 20, requestId: 'request-orphan-2',
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [
        { pane: '%1', threadId: 'thread-1', items: [first] },
        { pane: '%2', threadId: 'thread-1', items: [second] },
      ],
      receipts: [
        {
          pane: '%1', threadId: 'thread-1', requestId: first.requestId, text: first.text,
          status: 'queued', queueItemId: first.id, createdAt: 10, updatedAt: 10,
        },
        {
          pane: '%2', threadId: 'thread-1', requestId: second.requestId, text: second.text,
          status: 'queued', queueItemId: second.id, createdAt: 20, updatedAt: 20,
        },
      ],
    });
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: (socketPath) => String(socketPath).endsWith('/3.sock'),
      outboxStore, connect: () => replacement.ws,
    });

    expect((await app.status('%3', 'thread-1')).queue).toEqual([first, second]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%3', threadId: 'thread-1', items: [{ id: first.id }, { id: second.id }] }],
      receipts: [
        { pane: '%3', requestId: first.requestId, queueItemId: first.id },
        { pane: '%3', requestId: second.requestId, queueItemId: second.id },
      ],
    });
    await expect(app.send('%3', 'thread-1', first.text, first.requestId))
      .resolves.toEqual({ queued: true, item: first });
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('coalesces the same idempotent request recovered from multiple orphan panes', async () => {
    const requestId = 'request-shared';
    const outboxStore = memoryStore({
      version: 1,
      queues: [
        { pane: '%1', threadId: 'thread-1', items: [
          { id: 'queue-shared-1', text: 'once', createdAt: 10, requestId },
        ] },
        { pane: '%2', threadId: 'thread-1', items: [
          { id: 'queue-shared-2', text: 'once', createdAt: 20, requestId },
        ] },
      ],
      receipts: [
        {
          pane: '%1', threadId: 'thread-1', requestId, text: 'once', status: 'queued',
          queueItemId: 'queue-shared-1', createdAt: 10, updatedAt: 10,
        },
        {
          pane: '%2', threadId: 'thread-1', requestId, text: 'once', status: 'queued',
          queueItemId: 'queue-shared-2', createdAt: 20, updatedAt: 20,
        },
      ],
    });
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: (socketPath) => String(socketPath).endsWith('/3.sock'),
      outboxStore, connect: () => replacement.ws,
    });

    expect((await app.status('%3', 'thread-1')).queue).toEqual([{
      id: 'queue-shared-1', text: 'once', createdAt: 10, requestId,
    }]);
    expect(outboxStore.snapshot()).toMatchObject({
      queues: [{ pane: '%3', items: [{ id: 'queue-shared-1', requestId }] }],
      receipts: [{ pane: '%3', requestId, status: 'queued', queueItemId: 'queue-shared-1' }],
    });
    await expect(app.send('%3', 'thread-1', 'once', requestId)).resolves.toMatchObject({
      queued: true, item: { id: 'queue-shared-1' },
    });
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('keeps every orphan outbox intact when the same request id has different text', async () => {
    const initial = {
      version: 1,
      queues: [
        { pane: '%1', threadId: 'thread-1', items: [
          { id: 'queue-conflict-1', text: 'first', createdAt: 10, requestId: 'request-conflict' },
        ] },
        { pane: '%2', threadId: 'thread-1', items: [
          { id: 'queue-conflict-2', text: 'second', createdAt: 20, requestId: 'request-conflict' },
        ] },
      ],
      receipts: [
        {
          pane: '%1', threadId: 'thread-1', requestId: 'request-conflict', text: 'first',
          status: 'queued', queueItemId: 'queue-conflict-1', createdAt: 10, updatedAt: 10,
        },
        {
          pane: '%2', threadId: 'thread-1', requestId: 'request-conflict', text: 'second',
          status: 'queued', queueItemId: 'queue-conflict-2', createdAt: 20, updatedAt: 20,
        },
      ],
    };
    const outboxStore = memoryStore(initial);
    const replacement = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: (socketPath) => String(socketPath).endsWith('/3.sock'),
      outboxStore, connect: () => replacement.ws,
    });

    await expect(app.status('%3', 'thread-1'))
      .rejects.toThrow('request id was already used for another message');
    expect(outboxStore.snapshot()).toEqual(initial);
    expect(replacement.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('quarantines an invalid outbox snapshot before creating a clean replacement', () => {
    const corrupt = {
      version: 1,
      queues: [
        { pane: '%1', threadId: 'thread-1', items: [] },
        { pane: '%1', threadId: 'thread-1', items: [] },
      ],
      receipts: [],
    };
    const outboxStore = memoryStore(corrupt);

    const app = createCodexAppServer({ home: '/home/test', outboxStore });

    expect(outboxStore.quarantine).toHaveBeenCalledOnce();
    expect(outboxStore.quarantined()).toEqual([corrupt]);
    expect(outboxStore.snapshot()).toEqual({ version: 1, queues: [], receipts: [] });
    app.close();
  });

  it('treats malformed JSON as corrupt and recovers only after quarantine', () => {
    const quarantine = vi.fn();
    const write = vi.fn();

    const app = createCodexAppServer({
      home: '/home/test',
      outboxStore: {
        readStrict: () => { throw new SyntaxError('bad json'); },
        write,
        quarantine,
      },
    });

    expect(quarantine).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ version: 1, queues: [], receipts: [] });
    app.close();
  });

  it('propagates outbox I/O errors without quarantining potentially valid data', () => {
    const failure = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    const quarantine = vi.fn();
    const write = vi.fn();

    expect(() => createCodexAppServer({
      home: '/home/test',
      outboxStore: {
        readStrict: () => { throw failure; },
        write,
        quarantine,
      },
    })).toThrow(failure);
    expect(quarantine).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('reconciles a pending durable receipt against App Server before retrying it', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-accepted', text: 'already accepted',
        status: 'pending', createdAt: 10, updatedAt: 10,
      }],
    });
    const acceptedThread = () => ({
      id: 'thread-1', status: { type: 'active', activeFlags: [] },
      turns: [{
        id: 'turn-existing', status: 'inProgress', items: [{
          id: 'user-existing', type: 'userMessage', clientId: 'request-accepted',
          content: [{ type: 'text', text: 'already accepted' }],
        }],
      }],
    });
    const proxy = fakeProxy({
      resumeThread: acceptedThread,
      readThread: acceptedThread,
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.send('%1', 'thread-1', 'already accepted', 'request-accepted'))
      .resolves.toEqual({ queued: false, turn: { id: 'turn-existing' } });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(outboxStore.snapshot().receipts).toEqual([expect.objectContaining({
      requestId: 'request-accepted', status: 'accepted', turnId: 'turn-existing',
    })]);
    app.close();
  });

  it('reconciles a durable queue and receipt when its client id is outside the control window', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{
          id: 'queued-delivered', text: 'already delivered', requestId: 'request-delivered', createdAt: 10,
        }],
      }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-delivered', text: 'already delivered',
        status: 'queued', queueItemId: 'queued-delivered', createdAt: 10, updatedAt: 10,
      }],
    });
    const historical = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [
        {
          id: 'turn-delivered', status: 'completed', items: [{
            id: 'user-delivered', type: 'userMessage', clientId: 'request-delivered',
            content: [{ type: 'text', text: 'already delivered' }],
          }],
        },
        ...Array.from({ length: 60 }, (_, index) => ({
          id: `turn-after-delivery-${index}`, status: 'completed', items: [],
        })),
      ],
    });
    const proxy = fakeProxy({ resumeThread: historical, readThread: historical });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      queue: [], receipts: [{
        requestId: 'request-delivered', status: 'accepted', turnId: 'turn-delivered',
      }],
    });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/turns/list',
      params: expect.objectContaining({ limit: 10, sortDirection: 'desc', itemsView: 'summary' }),
    }));
    expect(proxy.sent.filter((message) => message.method === 'thread/turns/list')).toHaveLength(7);
    app.close();
  });

  it('starts a durable queue once after exhaustive history proves it was not delivered beyond 50 turns', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queued-uncertain', text: 'do not duplicate', createdAt: 10 }],
      }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'older-pending-request',
        text: 'older pending submission', status: 'pending', createdAt: 5, updatedAt: 5,
      }],
    });
    const longHistory = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: 60 }, (_, index) => ({
        id: `turn-${index}`, status: 'completed', items: [],
      })),
    });
    const proxy = fakeProxy({ resumeThread: longHistory, readThread: longHistory });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'turn/start'
    ))).toHaveLength(1));
    expect(proxy.sent.filter((message) => message.method === 'thread/turns/list')).toHaveLength(6);
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'do not duplicate' }],
      }),
    }));
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      queue: [],
      receipts: [expect.objectContaining({
        requestId: 'older-pending-request', status: 'pending',
      })],
    });
    app.close();
  });

  it.each([
    ['non-object page', null],
    ['non-array data', { data: {}, nextCursor: null }],
    ['non-object turn', { data: [null], nextCursor: null }],
    ['missing nextCursor', { data: [] }],
    ['invalid nextCursor', { data: [], nextCursor: 1 }],
  ])('keeps all delivery proofs fail-closed for a malformed turn page: %s', async (_label, malformed) => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queue-malformed-page', text: 'keep queued', createdAt: 10 }],
      }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'older-pending-malformed-page',
        text: 'older pending submission', status: 'pending', createdAt: 5, updatedAt: 5,
      }],
    });
    const proxy = fakeProxy({ listResult: () => malformed });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      queue: [{ id: 'queue-malformed-page', text: 'keep queued' }],
      receipts: [expect.objectContaining({
        requestId: 'older-pending-malformed-page', status: 'pending',
      })],
    });
    await expect(app.steerQueued('%1', 'thread-1', 'queue-malformed-page'))
      .rejects.toThrow('delivery status is still being reconciled; the message remains queued');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    app.close();
  });

  it('keeps all delivery proofs fail-closed when unique cursors exhaust the page budget', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queue-cursor-budget', text: 'keep queued', createdAt: 10 }],
      }],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'older-pending-cursor-budget',
        text: 'older pending submission', status: 'pending', createdAt: 5, updatedAt: 5,
      }],
    });
    const proxy = fakeProxy({
      listResult: (index) => ({ data: [], nextCursor: String(index + 1) }),
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      queue: [{ id: 'queue-cursor-budget', text: 'keep queued' }],
      receipts: [expect.objectContaining({
        requestId: 'older-pending-cursor-budget', status: 'pending',
      })],
    });
    expect(proxy.sent.filter((message) => message.method === 'thread/turns/list')).toHaveLength(1_000);
    await expect(app.steerQueued('%1', 'thread-1', 'queue-cursor-budget'))
      .rejects.toThrow('delivery status is still being reconciled; the message remains queued');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    app.close();
  });

  it('does not accept bounded absence proof when a turn starts during history pagination', async () => {
    const item = {
      id: 'queue-pagination-race', text: 'do not duplicate after a live turn starts',
      requestId: 'request-pagination-race', createdAt: 10,
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [],
    });
    let listedTurnCount = 11;
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: listedTurnCount }, (_, index) => ({
        id: `turn-pagination-race-${index}`, status: 'completed', items: [],
      })),
    });
    let releaseExhaustedPage!: () => void;
    const exhaustedPageWait = new Promise<void>((resolve) => { releaseExhaustedPage = resolve; });
    const proxy = fakeProxy({
      resumeThread: history, listThread: history, listWaits: [null, exhaustedPageWait],
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/turns/list'
    ))).toHaveLength(2));
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second request now exhausts the cursor with an empty page. It cannot prove absence because the
    // live turn may have accepted this client id after the scan began but before that page was returned.
    listedTurnCount = 10;
    releaseExhaustedPage();

    await expect(opening).resolves.toMatchObject({
      queue: [{ id: item.id, text: item.text }],
    });
    await expect(app.steerQueued('%1', 'thread-1', item.id))
      .rejects.toThrow('delivery status is still being reconciled; the message remains queued');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-live', status: 'completed', completedAt: 20, items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    expect((await app.status('%1', 'thread-1')).queue).toEqual([
      { id: item.id, text: item.text, requestId: item.requestId, createdAt: item.createdAt },
    ]);
    app.close();
  });

  it.each([
    ['a repeated cursor', 20, 1, 'repeat'],
    ['deep pagination', 60, 4, null],
  ] as const)('keeps delivery guarded when an event races %s', async (
    _label, turnCount, waitIndex, fixedCursor,
  ) => {
    const item = {
      id: `queue-race-${turnCount}`, text: 'keep guarded across the race', createdAt: 10,
    };
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: turnCount }, (_, index) => ({
        id: `turn-race-${turnCount}-${index}`, status: 'completed', items: [],
      })),
    });
    let releasePage!: () => void;
    const pageWait = new Promise<void>((resolve) => { releasePage = resolve; });
    const proxy = fakeProxy({
      resumeThread: history,
      listThread: history,
      listWaits: [...Array.from({ length: waitIndex }, () => null), pageWait],
      fixedListNextCursor: fixedCursor,
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const opening = app.status('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/turns/list'
    ))).toHaveLength(waitIndex + 1));
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePage();

    await expect(opening).resolves.toMatchObject({ queue: [expect.objectContaining({ id: item.id })] });
    await expect(app.steerQueued('%1', 'thread-1', item.id))
      .rejects.toThrow('delivery status is still being reconciled; the message remains queued');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    app.close();
  });

  it('keeps a durable queue blocked when history pagination repeats a non-empty cursor', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [{
        pane: '%1', threadId: 'thread-1',
        items: [{ id: 'queue-repeated-cursor', text: 'do not assume exhaustion', createdAt: 10 }],
      }],
      receipts: [],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: 20 }, (_, index) => ({
        id: `turn-repeated-${index}`, status: 'completed', items: [],
      })),
    });
    const proxy = fakeProxy({
      resumeThread: history, listThread: history, fixedListNextCursor: 'repeat',
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      queue: [{ id: 'queue-repeated-cursor', text: 'do not assume exhaustion' }],
    });
    expect(proxy.sent.filter((message) => message.method === 'thread/turns/list')).toHaveLength(2);
    await expect(app.steerQueued('%1', 'thread-1', 'queue-repeated-cursor'))
      .rejects.toThrow('delivery status is still being reconciled; the message remains queued');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    app.close();
  });

  it('does not retry a pending receipt when history pagination repeats a non-empty cursor', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-repeated-cursor',
        text: 'must remain pending', status: 'pending', createdAt: 10, updatedAt: 10,
      }],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: Array.from({ length: 20 }, (_, index) => ({
        id: `turn-receipt-repeated-${index}`, status: 'completed', items: [],
      })),
    });
    const proxy = fakeProxy({
      resumeThread: history, readThread: history, listThread: history,
      fixedListNextCursor: 'repeat',
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    await expect(app.send(
      '%1', 'thread-1', 'must remain pending', 'request-repeated-cursor',
    )).rejects.toThrow('could not be reconciled safely');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(outboxStore.snapshot().receipts).toEqual([expect.objectContaining({
      requestId: 'request-repeated-cursor', status: 'pending',
    })]);
    app.close();
  });

  it('does not retry a legacy pending receipt when an event races its complete history read', async () => {
    const outboxStore = memoryStore({
      version: 1,
      queues: [],
      receipts: [{
        pane: '%1', threadId: 'thread-1', requestId: 'request-legacy-read-race',
        text: 'do not retry stale absence', status: 'pending', createdAt: 10, updatedAt: 10,
      }],
    });
    const history = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [{ id: 'turn-legacy-history', status: 'completed', items: [] }],
    });
    let releaseRead!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseRead = resolve; });
    const proxy = fakeProxy({
      userAgent: 'codex-cli/0.148.0', resumeThread: history, readThread: history, readWait,
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const sending = app.send(
      '%1', 'thread-1', 'do not retry stale absence', 'request-legacy-read-race',
    );
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/read' && message.params.includeTurns === true
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });
    await Promise.resolve();
    releaseRead();

    await expect(sending).rejects.toThrow('could not be reconciled safely');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(outboxStore.snapshot().receipts).toEqual([expect.objectContaining({
      requestId: 'request-legacy-read-race', status: 'pending',
    })]);
    app.close();
  });

  it('keeps an uncertain submission pending and reconciles it after restart', async () => {
    const outboxStore = memoryStore();
    const firstProxy = fakeProxy({ turnStartReply: false });
    const firstApp = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => firstProxy.ws,
      outboxStore, rpcTimeoutMs: 5,
    });
    await expect(firstApp.send('%1', 'thread-1', 'uncertain delivery', 'request-uncertain'))
      .rejects.toThrow('timed out: turn/start');
    expect(outboxStore.snapshot().receipts).toEqual([expect.objectContaining({
      requestId: 'request-uncertain', status: 'pending',
    })]);
    firstApp.close();

    const acceptedThread = () => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [{
        id: 'turn-uncertain', status: 'completed', items: [{
          id: 'user-uncertain', type: 'userMessage', clientId: 'request-uncertain',
          content: [{ type: 'text', text: 'uncertain delivery' }],
        }],
      }],
    });
    const secondProxy = fakeProxy({ resumeThread: acceptedThread, readThread: acceptedThread });
    const secondApp = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => secondProxy.ws, outboxStore,
    });
    await expect(secondApp.send('%1', 'thread-1', 'uncertain delivery', 'request-uncertain'))
      .resolves.toEqual({ queued: false, turn: { id: 'turn-uncertain' } });
    expect(secondProxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    secondApp.close();
  });

  it('serializes simultaneous idle submissions so only the first starts immediately', async () => {
    let releaseStart: () => void = () => {};
    const turnStartWait = new Promise<void>((resolve) => { releaseStart = resolve; });
    const proxy = fakeProxy({ turnStartWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');

    const first = app.send('%1', 'thread-1', 'start now');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await app.send('%1', 'thread-1', 'wait next');

    expect(second).toMatchObject({ queued: true, item: { text: 'wait next' } });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    releaseStart();
    await first;
    expect((await app.status('%1', 'thread-1')).queue.map((item) => item.text)).toEqual(['wait next']);
    app.close();
  });

  it('returns the original App Server result for an in-process retry of an accepted request', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    const first = await app.send('%1', 'thread-1', 'start once', 'request-start-once');
    const retry = await app.send('%1', 'thread-1', 'start once', 'request-start-once');

    expect(retry).toEqual(first);
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    app.close();
  });

  it('steers one queued message into the active turn and can remove another', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = queueItemOf(await app.send('%1', 'thread-1', 'guide now'));
    const second = queueItemOf(await app.send('%1', 'thread-1', 'discard me'));

    await app.steerQueued('%1', 'thread-1', first.id);
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'turn/steer',
      params: expect.objectContaining({
        threadId: 'thread-1', expectedTurnId: 'turn-live',
        input: [{ type: 'text', text: 'guide now' }],
        clientUserMessageId: `handmux-queue:${first.id}`,
      }),
    }));
    expect((await app.status('%1', 'thread-1')).queue.map((item) => item.id)).toEqual([second.id]);

    expect(await app.removeQueued('%1', 'thread-1', second.id)).toEqual({ removed: true });
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
    app.close();
  });

  it('starts a queued message when steer confirms the remembered turn already completed', async () => {
    const completed = fixtureThread({ type: 'idle' });
    const proxy = fakeProxy({ readThread: () => completed });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'send now'));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(app.steerQueued('%1', 'thread-1', queued.id)).resolves.toMatchObject({ steered: true });
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
    app.close();
  });

  it('keeps a queued message pending while Codex is busy without a steerable turn', async () => {
    const proxy = fakeProxy({ status: { type: 'active', activeFlags: [] } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'wait for compaction'));

    await expect(app.steerQueued('%1', 'thread-1', queued.id))
      .rejects.toThrow('message remains queued');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect((await app.status('%1', 'thread-1')).queue).toEqual([queued]);
    app.close();
  });

  it('does not start a turn after the pane switches thread while the old thread is resuming', async () => {
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const proxy = fakeProxy({ resumeWait });
    const outboxStore = memoryStore();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const pending = app.send('%1', 'thread-1', 'must stay in thread one', 'request-thread-race');
    await vi.waitFor(() => expect(proxy.sent.some((message) => message.method === 'thread/resume')).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-2', thread: { id: 'thread-2', parentThreadId: null } },
    });
    await Promise.resolve();
    releaseResume();

    await expect(pending).rejects.toThrow('Codex session changed');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect(outboxStore.snapshot()).toMatchObject({ queues: [], receipts: [] });
    app.close();
  });

  it('does not steer an old thread after the pane switches during a forced refresh', async () => {
    let releaseRead!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseRead = resolve; });
    const activeWithoutFlag = (): TestThread => ({
      id: 'thread-1', status: { type: 'idle' },
      turns: [{ id: 'turn-live', status: 'inProgress', items: [] }],
    });
    const item = { id: 'queue-steer-race', text: 'stay queued', createdAt: 10 };
    const proxy = fakeProxy({
      resumeThread: activeWithoutFlag,
      readThread: activeWithoutFlag,
      readWait,
    });
    const outboxStore = memoryStore({
      version: 1,
      queues: [{ pane: '%1', threadId: 'thread-1', items: [item] }],
      receipts: [],
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws, outboxStore,
    });

    const pending = app.steerQueued('%1', 'thread-1', item.id);
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-2', thread: { id: 'thread-2', parentThreadId: null } },
    });
    await Promise.resolve();
    releaseRead();

    await expect(pending).rejects.toThrow('Codex session changed');
    expect(proxy.sent.filter((message) => message.method === 'turn/steer')).toEqual([]);
    expect(outboxStore.snapshot()).toMatchObject({ queues: [], receipts: [] });
    app.close();
  });

  it('does not compact an old thread after the pane switches during resume', async () => {
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => { releaseResume = resolve; });
    const proxy = fakeProxy({ resumeWait });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });

    const pending = app.compact('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/resume'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-2', thread: { id: 'thread-2', parentThreadId: null } },
    });
    await Promise.resolve();
    releaseResume();

    await expect(pending).rejects.toThrow('Codex session changed');
    expect(proxy.sent.filter((message) => message.method === 'thread/compact/start')).toEqual([]);
    app.close();
  });

  it('does not interrupt an old thread after the pane switches during a thread read', async () => {
    let releaseRead!: () => void;
    const readWait = new Promise<void>((resolve) => { releaseRead = resolve; });
    const proxy = fakeProxy({
      readWait,
      readThread: () => ({
        id: 'thread-1', status: { type: 'active', activeFlags: [] },
        turns: [{ id: 'turn-old', status: 'inProgress', items: [] }],
      }),
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: {} },
    });
    await Promise.resolve();

    const pending = app.interrupt('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/turns/list'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-2', thread: { id: 'thread-2', parentThreadId: null } },
    });
    await Promise.resolve();
    releaseRead();

    await expect(pending).rejects.toThrow('Codex session changed');
    expect(proxy.sent.filter((message) => message.method === 'turn/interrupt')).toEqual([]);
    app.close();
  });

  it('removes a steered queue item as soon as App Server confirms its client id', async () => {
    const proxy = fakeProxy({ turnSteerReply: false });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'guide once', 'request-guide'));
    const steering = app.steerQueued('%1', 'thread-1', queued.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1', expectedTurnId: 'turn-live',
        input: [{ type: 'text', text: 'guide once' }], clientUserMessageId: 'request-guide',
      },
    }));
    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-live',
        item: {
          id: 'user-guide', type: 'userMessage', clientId: 'request-guide',
          content: [{ type: 'text', text: 'guide once' }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);

    proxy.ws.close();
    await expect(steering).rejects.toThrow('connection closed');
    app.close();
  });

  it('starts the next queued message only after a turn completes successfully', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'next turn'));

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({
        threadId: 'thread-1', input: [{ type: 'text', text: 'next turn' }],
        clientUserMessageId: `handmux-queue:${queued.id}`,
      }),
    }));
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
    app.close();
  });

  it('pauses automatic queue delivery while a message is edited, then sends the committed text', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstQueued = queueItemOf(await app.send('%1', 'thread-1', 'send first'));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'original text'));
    const edit = await app.beginQueuedEdit('%1', 'thread-1', queued.id);

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect((await app.status('%1', 'thread-1')).queue.find((item) => item.id === queued.id)).toMatchObject({
      id: queued.id, text: 'original text', editing: true,
    });

    await app.commitQueuedEdit('%1', 'thread-1', queued.id, edit.token, 'revised text');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: 'thread-1', input: [{ type: 'text', text: 'send first' }],
          clientUserMessageId: `handmux-queue:${firstQueued.id}`,
        }),
      }),
    );
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: 'thread-1', input: [{ type: 'text', text: 'revised text' }],
          clientUserMessageId: `handmux-queue:${queued.id}`,
        }),
      }),
    );
    app.close();
  });

  it('resumes automatic queue delivery with the original text when editing is cancelled', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'keep original'));
    const edit = await app.beginQueuedEdit('%1', 'thread-1', queued.id);
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await app.cancelQueuedEdit('%1', 'thread-1', queued.id, edit.token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: 'thread-1', input: [{ type: 'text', text: 'keep original' }],
          clientUserMessageId: `handmux-queue:${queued.id}`,
        }),
      }),
    );
    app.close();
  });

  it('releases an abandoned queue edit lease and resumes automatic delivery', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const proxy = fakeProxy();
      const app = createCodexAppServer({
        home: '/home/test', exists: () => true, connect: () => proxy.ws, now: () => Date.now(),
      });
      await app.status('%1', 'thread-1');
      proxy.push({
        jsonrpc: '2.0', method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
      });
      await Promise.resolve();
      const queued = queueItemOf(await app.send('%1', 'thread-1', 'send after abandoned edit'));
      await app.beginQueuedEdit('%1', 'thread-1', queued.id);
      proxy.push({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
      });
      await Promise.resolve();
      expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);

      await vi.advanceTimersByTimeAsync(31_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            threadId: 'thread-1', input: [{ type: 'text', text: 'send after abandoned edit' }],
            clientUserMessageId: `handmux-queue:${queued.id}`,
          }),
        }),
      );
      app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live queue editor leased while its heartbeat continues', async () => {
    vi.useFakeTimers();
    let app = null;
    try {
      vi.setSystemTime(0);
      const proxy = fakeProxy();
      app = createCodexAppServer({
        home: '/home/test', exists: () => true, connect: () => proxy.ws, now: () => Date.now(),
      });
      await app.status('%1', 'thread-1');
      proxy.push({
        jsonrpc: '2.0', method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
      });
      await Promise.resolve();
      const queued = queueItemOf(await app.send('%1', 'thread-1', 'wait for editor'));
      const edit = await app.beginQueuedEdit('%1', 'thread-1', queued.id);
      proxy.push({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
      });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(20_000);
      await app.renewQueuedEdit('%1', 'thread-1', queued.id, edit.token);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);

      await vi.advanceTimersByTimeAsync(11_000);
      await Promise.resolve();
      expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            threadId: 'thread-1', input: [{ type: 'text', text: 'wait for editor' }],
            clientUserMessageId: `handmux-queue:${queued.id}`,
          }),
        }),
      );
    } finally {
      app?.close();
      vi.useRealTimers();
    }
  });

  it('resumes an expired edit lease through the replacement App Server connection', async () => {
    vi.useFakeTimers();
    let app = null;
    try {
      vi.setSystemTime(0);
      const proxies: ReturnType<typeof fakeProxy>[] = [];
      app = createCodexAppServer({
        home: '/home/test', exists: () => true, now: () => Date.now(),
        connect: () => { const proxy = fakeProxy(); proxies.push(proxy); return proxy.ws; },
      });
      await app.status('%1', 'thread-1');
      const first = proxies[0];
      if (!first) throw new Error('expected the first proxy');
      first.push({
        jsonrpc: '2.0', method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
      });
      await Promise.resolve();
      const queued = queueItemOf(await app.send('%1', 'thread-1', 'resume after reconnect'));
      await app.beginQueuedEdit('%1', 'thread-1', queued.id);
      first.push({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
      });
      await Promise.resolve();
      first.ws.emit('close');
      await Promise.resolve();

      await app.status('%1', 'thread-1');
      const replacement = proxies[1];
      if (!replacement) throw new Error('expected a replacement proxy');
      await vi.advanceTimersByTimeAsync(31_000);
      await app.status('%1', 'thread-1');
      await Promise.resolve();
      await Promise.resolve();

      await vi.waitFor(() => {
        expect(replacement.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
          expect.objectContaining({
            params: expect.objectContaining({
              threadId: 'thread-1', input: [{ type: 'text', text: 'resume after reconnect' }],
              clientUserMessageId: `handmux-queue:${queued.id}`,
            }),
          }),
        );
      });
    } finally {
      app?.close();
      vi.useRealTimers();
    }
  });

  it('keeps an interrupted turn active until App Server confirms turn completion', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await app.interrupt('%1', 'thread-1')).toEqual({ interrupted: true, turnId: 'turn-live' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-live' },
    }));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      status: { type: 'active' }, activeTurnId: 'turn-live', activityKind: 'working',
    });

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'interrupted', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      status: { type: 'idle' }, activeTurnId: null, activityKind: null,
    });
    app.close();
  });

  it('clears a stale active turn when thread/read confirms the missed completion', async () => {
    const completed = fixtureThread({ type: 'idle' });
    const proxy = fakeProxy({ readThread: () => completed });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = await app.send('%1', 'thread-1', 'send after recovered completion');
    expect(sent).toMatchObject({ turn: { id: 'turn-2', status: 'inProgress' } });
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: 'thread-1', input: [{ type: 'text', text: 'send after recovered completion' }],
        }),
      }),
    );
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      activeTurnId: 'turn-2', lastTurn: { status: 'completed' }, queue: [],
    });
    app.close();
  });

  it.each(['failed', 'interrupted'])('retains the queue when the current turn is %s', async (turnStatus) => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.send('%1', 'thread-1', 'keep me');

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: turnStatus, items: [] } },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    expect((await app.status('%1', 'thread-1')).queue.map((item) => item.text)).toEqual(['keep me']);
    app.close();
  });

  it('resumes a retained queue when a successful completion happened during reconnect', async () => {
    const first = fakeProxy();
    const completed = fixtureThread({ type: 'idle' });
    firstTurn(completed).status = 'completed';
    let second: ReturnType<typeof fakeProxy> | undefined;
    let connectCount = 0;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true,
      connect: () => {
        if (connectCount++ === 0) return first.ws;
        second = fakeProxy({ resumeThread: () => completed });
        return second.ws;
      },
    });
    await app.status('%1', 'thread-1');
    first.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = queueItemOf(await app.send('%1', 'thread-1', 'continue after reconnect'));
    expect((await app.status('%1', 'thread-1')).queue).toHaveLength(1);

    first.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ lastTurn: { status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(second).toBeDefined();
    expect(second!.sent).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({
        threadId: 'thread-1', input: [{ type: 'text', text: 'continue after reconnect' }],
        clientUserMessageId: `handmux-queue:${queued.id}`,
      }),
    }));
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
    app.close();
  });

  it('does not resend a queued message accepted before its turn/start reply was lost', async () => {
    const first = fakeProxy({ turnStartReply: false });
    const completed = fixtureThread({ type: 'idle' });
    completed.turns.push({
      id: 'turn-accepted', status: 'completed',
      items: [{
        id: 'user-accepted', type: 'userMessage', clientId: 'request-accepted',
        content: [{ type: 'text', text: 'accepted once' }],
      }],
    });
    let second: ReturnType<typeof fakeProxy> | undefined;
    let connectCount = 0;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true,
      connect: () => {
        if (connectCount++ === 0) return first.ws;
        second = fakeProxy({ resumeThread: () => completed });
        return second.ws;
      },
    });
    await app.status('%1', 'thread-1');
    first.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.send('%1', 'thread-1', 'accepted once', 'request-accepted');
    first.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.sent).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: {
        threadId: 'thread-1', input: [{ type: 'text', text: 'accepted once' }],
        clientUserMessageId: 'request-accepted',
      },
    }));
    first.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.status('%1', 'thread-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
    expect(second).toBeDefined();
    expect(second!.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('restores a failed last-turn status from the App Server snapshot', async () => {
    const failed = fixtureThread({ type: 'idle' });
    firstTurn(failed).status = 'failed';
    firstTurn(failed).items = [{
      id: 'large-item', type: 'agentMessage', text: 'x'.repeat(1024 * 1024),
    }];
    const proxy = fakeProxy({ resumeThread: () => failed });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    const status = await app.status('%1', 'thread-1');
    expect(status.lastTurn).toEqual({ id: firstTurn(failed).id, status: 'failed' });
    expect(JSON.stringify(status)).not.toContain('large-item');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('answers additional-permission approvals with the requested profile and selected scope', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', id: 93, method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', itemId: 'permissions-1', cwd: '/work',
        reason: 'Needs network access', permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      approvals: [{ id: '93', type: 'permissions', decisions: ['accept', 'acceptForSession', 'decline'] }],
    });
    await app.decide('%1', 'thread-1', '93', 'acceptForSession');
    expect(proxy.sent).toContainEqual({
      jsonrpc: '2.0', id: 93,
      result: { permissions: { network: { enabled: true } }, scope: 'session' },
    });
    app.close();
  });

  it('answers structured user input through the pending App Server request', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', id: 92, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-2', itemId: 'input-1', autoResolutionMs: null,
        questions: [{
          id: 'color', header: '颜色', question: '选择颜色', isOther: true, isSecret: false,
          options: [{ label: '蓝色', description: '沉稳' }],
        }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      userInputs: [{ id: '92', questions: [{ id: 'color', question: '选择颜色' }] }],
    });
    await app.answerInput('%1', 'thread-1', '92', { color: ['蓝色'] });
    expect(proxy.sent).toContainEqual({
      jsonrpc: '2.0', id: 92, result: { answers: { color: { answers: ['蓝色'] } } },
    });
    expect((await app.status('%1', 'thread-1')).userInputs).toEqual([]);
    app.close();
  });

  it('keeps live tool items when a later thread snapshot temporarily omits them', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'cmd-live', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'inProgress' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let opened = await app.read('%1', 'thread-1');
    expect(projectCodexThread(threadFromRead(opened))
      .find((message) => message.tool?.input?.cmd === 'npm test')?.tool?.result)
      .toBeNull();

    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'cmd-live', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', aggregatedOutput: 'passed\n' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened = await app.read('%1', 'thread-1');
    expect(projectCodexThread(threadFromRead(opened))
      .find((message) => message.tool?.input?.cmd === 'npm test')?.tool?.result)
      .toBe('passed\n');
    app.close();
  });

  it('keeps rereading while a live tool is only an overlay so canonical order can converge', async () => {
    let canonicalReady = false;
    const proxy = fakeProxy({
      readThread: () => {
        const thread = fixtureThread();
        const items = [
          { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'fix it' }] },
          ...(canonicalReady ? [{
            id: 'tool-2', type: 'commandExecution', command: 'npm test', cwd: '/work',
            status: 'completed', aggregatedOutput: 'ok\n',
          }] : []),
          { id: 'agent-2', type: 'agentMessage', text: 'done' },
        ];
        thread.turns.push({ id: 'turn-2', status: 'completed', items });
        return thread;
      },
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: {
          id: 'tool-2', type: 'commandExecution', command: 'npm test', cwd: '/work',
          status: 'completed', aggregatedOutput: 'ok\n',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const provisional = projectCodexThread(threadFromRead(await app.read('%1', 'thread-1'))).slice(-3);
    expect(provisional.map((message) => message.text || message.tool?.input?.cmd))
      .toEqual(['fix it', 'done', 'npm test']);

    // App Server persistence catches up without another notification. The next phone poll must therefore
    // read again while an overlay remains instead of freezing the provisional tail forever.
    canonicalReady = true;
    const converged = projectCodexThread(threadFromRead(await app.read('%1', 'thread-1'))).slice(-3);
    expect(converged.map((message) => message.text || message.tool?.input?.cmd))
      .toEqual(['fix it', 'npm test', 'done']);
    app.close();
  });

  it('does not duplicate live messages or tools when the completed turn assigns different item ids', async () => {
    const completedItems = [
      { id: 'snapshot-user', type: 'userMessage', content: [{ type: 'text', text: 'only once' }] },
      { id: 'snapshot-agent', type: 'agentMessage', text: 'one reply' },
      { id: 'snapshot-tool', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', aggregatedOutput: 'ok\n' },
    ];
    let snapshotReady = false;
    const proxy = fakeProxy({
      readThread: () => {
        const thread = fixtureThread();
        if (snapshotReady) thread.turns.push({ id: 'turn-2', status: 'completed', items: completedItems });
        return thread;
      },
    });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: { id: 'live-agent', type: 'agentMessage', text: 'one reply' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: { id: 'live-user', type: 'userMessage', content: [{ type: 'text', text: 'only once' }] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: { id: 'live-tool', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', aggregatedOutput: 'ok\n' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: completedItems },
      },
    });
    snapshotReady = true;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const opened = await app.read('%1', 'thread-1');
    const texts = projectCodexThread(threadFromRead(opened))
      .filter((message) => message.type === 'text')
      .map((message) => [message.role, message.text]);
    expect(texts.filter((message) => message[1] === 'only once')).toEqual([['user', 'only once']]);
    expect(texts.filter((message) => message[1] === 'one reply')).toEqual([['assistant', 'one reply']]);
    expect(texts.slice(-2)).toEqual([['user', 'only once'], ['assistant', 'one reply']]);
    const projected = projectCodexThread(threadFromRead(opened));
    expect(projected.filter((message) => message.tool?.input?.cmd === 'npm test')).toHaveLength(1);
    expect(projected.filter((message) => typeof message.text === 'string'
      && ['only once', 'one reply'].includes(message.text)).map((message) => message.id))
      .toEqual(['codex:turn-2:live-user', 'codex:turn-2:live-agent']);

    // A later unrelated revision reads the same canonical ids after the live overlay has retired; identity
    // must still stay on the original notification ids or the phone will render them as new messages.
    proxy.push({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'snapshot-agent', delta: '' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reread = projectCodexThread(threadFromRead(await app.read('%1', 'thread-1')));
    expect(reread.filter((message) => typeof message.text === 'string'
      && ['only once', 'one reply'].includes(message.text)).map((message) => message.id))
      .toEqual(['codex:turn-2:live-user', 'codex:turn-2:live-agent']);
    app.close();
  });

  it('lists official models and updates thread settings on the current thread', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.models('%1', 'thread-1')).toEqual([
      expect.objectContaining({ model: 'gpt-test', defaultReasoningEffort: 'medium' }),
    ]);
    expect(await app.updateSettings('%1', 'thread-1', {
      model: 'gpt-new', effort: 'high', approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' },
    })).toMatchObject({
      model: 'gpt-new', effort: 'high', approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' },
    });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/settings/update', params: {
        threadId: 'thread-1', model: 'gpt-new', effort: 'high', approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' },
      },
    }));
    app.close();
  });

  it('reads, updates, pauses, and clears the native thread goal', async () => {
    const proxy = fakeProxy({ initialGoal: {
      threadId: 'thread-1', objective: 'Finish the migration', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 12, timeUsedSeconds: 3, tokenBudget: null,
    } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));

    expect(await app.getGoal('%1', 'thread-1')).toMatchObject({
      objective: 'Finish the migration', status: 'active',
    });
    expect(await app.updateGoal('%1', 'thread-1', { objective: 'Ship it' })).toMatchObject({
      objective: 'Ship it', status: 'active',
    });
    expect(await app.updateGoal('%1', 'thread-1', { status: 'paused' })).toMatchObject({
      objective: 'Ship it', status: 'paused',
    });
    expect(events.at(-1)).toMatchObject({ type: 'goalCleared', threadId: 'thread-1' });
    expect(await app.clearGoal('%1', 'thread-1')).toEqual({ cleared: true });
    expect(await app.getGoal('%1', 'thread-1')).toBeNull();
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/goal/set', params: { threadId: 'thread-1', objective: 'Ship it' },
    }));
    unsubscribe();
    app.close();
  });

  it('does not let an update response overwrite a newer native Goal notification', async () => {
    let releaseGoalSet!: () => void;
    const goalSetWait = new Promise<void>((resolve) => { releaseGoalSet = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalSetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.getGoal('%1', 'thread-1');
    const updating = app.updateGoal('%1', 'thread-1', { objective: 'RPC Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(1));
    const nativeGoal = { ...initialGoal, objective: 'Native Goal', createdAt: 20, updatedAt: 20 };
    proxy.setServerGoal(nativeGoal);
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-new',
        goal: nativeGoal,
      },
    });
    await Promise.resolve();
    releaseGoalSet();

    await expect(updating).resolves.toMatchObject({ objective: 'Native Goal', createdAt: 20 });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Native Goal', createdAt: 20 },
    });
    app.close();
  });

  it('refreshes after progress races an update response without its own notification', async () => {
    let releaseGoalSet!: () => void;
    const goalSetWait = new Promise<void>((resolve) => { releaseGoalSet = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalSetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.getGoal('%1', 'thread-1');
    const updating = app.updateGoal('%1', 'thread-1', { objective: 'Updated Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(1));
    // This notification was queued before the write response and does not change the provider's current
    // Goal. The delayed set response is still valid, but its revision conflict requires a fresh get.
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-current',
        goal: { ...initialGoal, updatedAt: 2, tokensUsed: 20, timeUsedSeconds: 2 },
      },
    });
    await Promise.resolve();
    releaseGoalSet();

    await expect(updating).resolves.toMatchObject({ objective: 'Updated Goal' });
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/get')).toHaveLength(2);
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Updated Goal' },
    });
    app.close();
  });

  it('serializes an old public get ahead of a write refresh and still converges to the write', async () => {
    let releaseGoalGet!: () => void;
    let releaseGoalSet!: () => void;
    const goalGetWait = new Promise<void>((resolve) => { releaseGoalGet = resolve; });
    const goalSetWait = new Promise<void>((resolve) => { releaseGoalSet = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalGetWait, goalSetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated',
      params: { threadId: 'thread-1', turnId: null, goal: initialGoal },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reading = app.getGoal('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/get'
    ))).toHaveLength(1));
    const updating = app.updateGoal('%1', 'thread-1', { objective: 'Updated Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(1));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-current',
        goal: { ...initialGoal, updatedAt: 2, tokensUsed: 20, timeUsedSeconds: 2 },
      },
    });
    await Promise.resolve();
    releaseGoalSet();
    await Promise.resolve();
    releaseGoalGet();

    await expect(reading).resolves.toMatchObject({ objective: 'Updated Goal' });
    await expect(updating).resolves.toMatchObject({ objective: 'Updated Goal' });
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/get')).toHaveLength(3);
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Updated Goal' },
    });
    app.close();
  });

  it('emits one clear control when an update conflict refresh resolves active to null', async () => {
    let releaseGoalSet!: () => void;
    const goalSetWait = new Promise<void>((resolve) => { releaseGoalSet = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 10, timeUsedSeconds: 1, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalSetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    const updating = app.updateGoal('%1', 'thread-1', { objective: 'Updated Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(1));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-current',
        goal: { ...initialGoal, updatedAt: 2, tokensUsed: 20, timeUsedSeconds: 2 },
      },
    });
    proxy.setServerGoal(null);
    await Promise.resolve();
    releaseGoalSet();

    await expect(updating).resolves.toBeNull();
    expect(events.filter((event) => event.type === 'goalCleared')).toHaveLength(1);
    await expect(app.getGoal('%1', 'thread-1')).resolves.toBeNull();
    expect(events.filter((event) => event.type === 'goalCleared')).toHaveLength(1);
    unsubscribe();
    app.close();
  });

  it('does not let a start response overwrite a newer native Goal notification', async () => {
    let releaseGoalSet!: () => void;
    const goalSetWait = new Promise<void>((resolve) => { releaseGoalSet = resolve; });
    const proxy = fakeProxy({ goalSetWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const starting = app.startGoal('%1', 'thread-1', 'RPC Goal');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/goal/set'
    ))).toBe(true));
    const nativeGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Native Goal', status: 'active',
      createdAt: 20, updatedAt: 20, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    proxy.setServerGoal(nativeGoal);
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-new',
        goal: nativeGoal,
      },
    });
    await Promise.resolve();
    releaseGoalSet();

    await expect(starting).resolves.toMatchObject({ objective: 'Native Goal', createdAt: 20 });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Native Goal', createdAt: 20 },
    });
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/get')).toHaveLength(1);
    app.close();
  });

  it('does not let a clear response erase a newer native Goal notification', async () => {
    let releaseGoalClear!: () => void;
    const goalClearWait = new Promise<void>((resolve) => { releaseGoalClear = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalClearWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    const clearing = app.clearGoal('%1', 'thread-1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/goal/clear'
    ))).toBe(true));
    const nativeGoal = { ...initialGoal, objective: 'Native Goal', createdAt: 20, updatedAt: 20 };
    proxy.setServerGoal(nativeGoal);
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-new',
        goal: nativeGoal,
      },
    });
    await Promise.resolve();
    releaseGoalClear();

    await expect(clearing).resolves.toEqual({ cleared: true });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Native Goal', createdAt: 20 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'goal', goal: { objective: 'Native Goal', createdAt: 20 },
    });
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/get')).toHaveLength(2);
    unsubscribe();
    app.close();
  });

  it('serializes Goal mutations and applies them in invocation order', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondWait = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalSetWaits: [firstWait, secondWait] });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.getGoal('%1', 'thread-1');
    const first = app.updateGoal('%1', 'thread-1', { objective: 'First Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(1));
    const second = app.updateGoal('%1', 'thread-1', { objective: 'Second Goal' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/set')).toHaveLength(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ objective: 'First Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(2));
    releaseSecond();
    await expect(second).resolves.toMatchObject({ objective: 'Second Goal' });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Second Goal' },
    });
    app.close();
  });

  it('serializes a later update behind the clear stage of an in-flight start', async () => {
    let releaseClear!: () => void;
    const goalClearWait = new Promise<void>((resolve) => { releaseClear = resolve; });
    const proxy = fakeProxy({ goalClearWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const starting = app.startGoal('%1', 'thread-1', 'First Goal');
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/clear'
    ))).toHaveLength(1));
    const updating = app.updateGoal('%1', 'thread-1', { objective: 'Second Goal' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proxy.sent.filter((message) => message.method === 'thread/goal/set')).toHaveLength(0);

    releaseClear();
    await expect(starting).resolves.toMatchObject({ objective: 'First Goal' });
    await vi.waitFor(() => expect(proxy.sent.filter((message) => (
      message.method === 'thread/goal/set'
    ))).toHaveLength(2));
    await expect(updating).resolves.toMatchObject({ objective: 'Second Goal' });
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({
      goal: { objective: 'Second Goal' },
    });
    app.close();
  });

  it('releases the active Goal barrier when start clears it but set fails', async () => {
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalSetError: true });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');

    await expect(app.startGoal('%1', 'thread-1', 'Replacement Goal')).rejects.toThrow(
      'goal set failed',
    );

    expect(events.filter((event) => event.type === 'goalCleared')).toHaveLength(1);
    await expect(app.status('%1', 'thread-1')).resolves.toMatchObject({ goal: null });
    unsubscribe();
    app.close();
  });

  it('does not duplicate a native clear when the replacement set fails', async () => {
    let releaseClear!: () => void;
    const goalClearWait = new Promise<void>((resolve) => { releaseClear = resolve; });
    const initialGoal: TestGoal = {
      threadId: 'thread-1', objective: 'Initial Goal', status: 'active',
      createdAt: 1, updatedAt: 1, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
    };
    const proxy = fakeProxy({ initialGoal, goalClearWait, goalSetError: true });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    const starting = app.startGoal('%1', 'thread-1', 'Replacement Goal');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/goal/clear'
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/cleared',
      params: { threadId: 'thread-1', turnId: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseClear();

    await expect(starting).rejects.toThrow('goal set failed');
    expect(events.filter((event) => event.type === 'goalCleared')).toHaveLength(1);
    unsubscribe();
    app.close();
  });

  it('starts a fresh active native Goal instead of reviving the previous Goal', async () => {
    const proxy = fakeProxy({ initialGoal: {
      threadId: 'thread-1', objective: 'Finish the migration', status: 'paused',
      createdAt: 1, updatedAt: 4, tokensUsed: 1200, timeUsedSeconds: 45, tokenBudget: null,
    } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-current', status: 'inProgress', items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // App Server can notify before replying. Also complete the initiating turn first to prove the Goal
    // still uses the turn captured when the mutation began, rather than the now-idle connection state.
    const send = proxy.ws.send.bind(proxy.ws);
    proxy.ws.send = (data: string) => {
      const request = JSON.parse(data) as TestRpcMessage;
      if (request.method === 'thread/goal/set') {
        proxy.push({
          jsonrpc: '2.0', method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: { id: 'turn-current', status: 'completed', items: [] },
          },
        });
        proxy.push({
          jsonrpc: '2.0', method: 'thread/goal/updated', params: {
            threadId: 'thread-1', turnId: null,
            goal: {
              threadId: 'thread-1', objective: 'Finish the migration', status: 'active',
              createdAt: 2, updatedAt: 2, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
            },
          },
        });
      }
      send(data);
    };

    expect(await app.startGoal('%1', 'thread-1', 'Finish the migration')).toMatchObject({
      objective: 'Finish the migration', status: 'active', createdAt: 2,
      tokensUsed: 0, timeUsedSeconds: 0,
    });
    expect(proxy.sent.slice(-2)).toEqual([
      expect.objectContaining({ method: 'thread/goal/clear', params: { threadId: 'thread-1' } }),
      expect.objectContaining({
        method: 'thread/goal/set',
        params: { threadId: 'thread-1', objective: 'Finish the migration', status: 'active' },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'goal', event: 'set', turnId: 'turn-current',
      goal: { objective: 'Finish the migration', status: 'active', createdAt: 2 },
    });
    unsubscribe();
    app.close();
  });

  it('keeps an idle Goal mutation unanchored when a turn starts before its native notification', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    const send = proxy.ws.send.bind(proxy.ws);
    proxy.ws.send = (data: string) => {
      const request = JSON.parse(data) as TestRpcMessage;
      if (request.method === 'thread/goal/set') {
        proxy.push({
          jsonrpc: '2.0', method: 'turn/started', params: {
            threadId: 'thread-1', turn: { id: 'turn-after-goal', status: 'inProgress', items: [] },
          },
        });
        proxy.push({
          jsonrpc: '2.0', method: 'thread/goal/updated', params: {
            threadId: 'thread-1', turnId: null,
            goal: {
              threadId: 'thread-1', objective: 'Start from idle', status: 'active',
              createdAt: 1, updatedAt: 2, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null,
            },
          },
        });
      }
      send(data);
    };

    await app.updateGoal('%1', 'thread-1', { objective: 'Start from idle' });

    expect(events.at(-1)).toMatchObject({
      type: 'goal', event: 'set', turnId: null,
      goal: { objective: 'Start from idle', status: 'active' },
    });
    unsubscribe();
    app.close();
  });

  it('keeps resume-only settings when App Server publishes its settings snapshot', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          model: 'gpt-new', effort: 'medium', cwd: '/work', approvalPolicy: 'on-request',
          approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await app.status('%1', 'thread-1')).toMatchObject({
      settings: { model: 'gpt-new', effort: 'medium', runtimeWorkspaceRoots: ['/work', '/shared'] },
    });
    app.close();
  });

  it('chooses the newest loaded thread after a server restart', async () => {
    const proxy = fakeProxy({ loaded: ['thread-old', 'thread-new'], updatedAt: { 'thread-old': 10, 'thread-new': 20 } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-new' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'thread/read', params: { threadId: 'thread-new', includeTurns: false } }));
    app.close();
  });

  it('does not overwrite a newer native thread switch with stale startup discovery', async () => {
    let releaseMetadata!: () => void;
    const metadataReadWait = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const proxy = fakeProxy({ metadataReadWait });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    const pending = app.discover('%1');
    await vi.waitFor(() => expect(proxy.sent.some((message) => (
      message.method === 'thread/read' && message.params.includeTurns === false
    ))).toBe(true));
    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { threadId: 'thread-2', thread: { id: 'thread-2', parentThreadId: null } },
    });
    await Promise.resolve();
    releaseMetadata();

    await expect(pending).resolves.toEqual({ managed: true, threadId: 'thread-2' });
    app.close();
  });

  it('keeps the root conversation when a newer collaboration child is also loaded', async () => {
    const proxy = fakeProxy({
      loaded: ['thread-root', 'thread-child'],
      updatedAt: { 'thread-root': 10, 'thread-child': 20 },
      parentThreadIds: { 'thread-child': 'thread-root' },
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-root' });
    app.close();
  });

  it('keeps the root conversation when a newer ephemeral helper is also loaded', async () => {
    const proxy = fakeProxy({
      loaded: ['thread-root', 'thread-helper'],
      updatedAt: { 'thread-root': 10, 'thread-helper': 20 },
      ephemeralThreadIds: ['thread-helper'],
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-root' });
    app.close();
  });

  it('does not discover an ephemeral helper as a pane conversation', async () => {
    const proxy = fakeProxy({
      loaded: ['thread-helper'],
      ephemeralThreadIds: ['thread-helper'],
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: null });
    app.close();
  });

  it('does not let a collaboration child thread replace the pane conversation', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');

    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { thread: { id: 'thread-child', parentThreadId: 'thread-1' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.discover('%1')).threadId).toBe('thread-1');
    app.close();
  });

  it('does not let an ephemeral helper replace or update the pane conversation', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');

    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { thread: { id: 'thread-helper', parentThreadId: null, ephemeral: true } },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-helper', turn: { id: 'helper-turn' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await app.discover('%1')).threadId).toBe('thread-1');
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ threadId: 'thread-1', kind: 'done' });
    app.close();
  });

  it('projects turn and approval events into one authoritative inbox state', async () => {
    let ts = 100;
    const changed: string[] = [];
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
      now: () => ++ts, onStateChange: (pane) => changed.push(pane),
    });
    await app.discover('%1');
    const interactionSnapshots: CodexInteractionSnapshot[] = [];
    const interactions = await app.observeInteractions('%1', 'thread-1', (snapshot) => {
      interactionSnapshots.push(snapshot);
    });
    changed.length = 0;
    proxy.push({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'fix the inbox' }] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'working', msg: 'fix the inbox' });

    proxy.push({
      jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'command-2', command: 'npm test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({
      kind: 'permission', msg: 'npm test', correlationId: 'command-2',
    });
    expect(interactionSnapshots.at(-1)?.approvals[0]).toMatchObject({
      id: '91', itemId: 'command-2',
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: {
        threadId: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({
      kind: 'permission', correlationId: 'command-2',
    });

    proxy.push({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 91 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({
      kind: 'working', msg: 'fix the inbox', correlationId: 'command-2',
    });

    proxy.push({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'all green' }] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', msg: 'all green' });
    expect(changed).toEqual(['%1', '%1', '%1', '%1', '%1', '%1', '%1']);
    interactions.close();
    app.close();
  });

  it('uses the fresh completed turn final message instead of a merged live commentary tail', async () => {
    const canonicalRead = fixtureThread();
    canonicalRead.turns = [{
      id: 'turn-summary', status: 'completed',
      items: [{ id: 'final-canonical', type: 'agentMessage', text: '已完成并提交' }],
    }];
    const proxy = fakeProxy({ readThread: () => canonicalRead });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-summary', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-summary',
        item: {
          id: 'commentary-live', type: 'agentMessage',
          text: '最终评审通过，正在提交',
        },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-summary',
        item: { id: 'final-live', type: 'agentMessage', text: '已完成并提交' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-summary', status: 'completed',
          items: [{ id: 'final-canonical', type: 'agentMessage', text: '已完成并提交' }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: '已完成并提交' });

    await app.read('%1', 'thread-1');
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: '已完成并提交' });
    app.close();
  });

  it('falls back to the merged live final when the fresh completed turn has no assistant text', async () => {
    const canonicalRead = fixtureThread();
    canonicalRead.turns = [{ id: 'turn-live-fallback', status: 'completed', items: [] }];
    const proxy = fakeProxy({ readThread: () => canonicalRead });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'thread-1', turn: { id: 'turn-live-fallback', status: 'inProgress', items: [] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-live-fallback',
        item: { id: 'live-final', type: 'agentMessage', text: 'live final fallback' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: { id: 'turn-live-fallback', status: 'completed', items: [] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: 'live final fallback' });

    await app.read('%1', 'thread-1');
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: 'live final fallback' });
    app.close();
  });

  it('falls back to the real user prompt when completion has no final message and ignores injected context', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.discover('%1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress', items: [] } },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'ship the release' }] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-2',
        item: {
          id: 'context-2', type: 'userMessage',
          content: [{ type: 'text', text: '<permissions instructions>internal policy</permissions instructions>' }],
        },
      },
    });
    proxy.push({
      jsonrpc: '2.0', id: 92, method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'files-2' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'permission', msg: 'ship the release' });

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: 'ship the release' });
    app.close();
  });

  it('switches discovery to the new thread announced by /clear', async () => {
    const proxy = fakeProxy({ loaded: ['thread-1', 'thread-2'], updatedAt: { 'thread-1': 20, 'thread-2': 10 } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');
    proxy.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'thread-2' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.discover('%1')).threadId).toBe('thread-2');
    app.close();
  });

  it('does not let late events or reads from the old thread undo a /clear switch', async () => {
    const proxy = fakeProxy({
      loaded: ['thread-1', 'thread-clear'], updatedAt: { 'thread-1': 20, 'thread-clear': 10 },
      resumeThread: (threadId) => (threadId === 'thread-clear'
        ? { ...fixtureThread(), turns: [] }
        : fixtureThread()),
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'old-active-turn', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.send('%1', 'thread-1', 'do not send after clear'))
      .toMatchObject({ queued: true });
    proxy.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'thread-clear' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-1', turn: { id: 'late-old-turn', status: 'completed', items: [{ id: 'late-old-message', type: 'agentMessage', text: 'old done' }] },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A transcript request already in flight for the old id may still finish after /clear.
    await app.read('%1', 'thread-1');
    const sentTurns = proxy.sent.filter((message) => message.method === 'turn/start').length;
    await expect(app.send('%1', 'thread-1', 'stale send')).rejects.toThrow('Codex session changed');
    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toHaveLength(sentTurns);
    expect((await app.discover('%1')).threadId).toBe('thread-clear');
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ threadId: 'thread-clear', kind: null });
    app.close();
  });

  it('marks an active startup snapshot as a no-replay push baseline', async () => {
    const proxy = fakeProxy({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => ['1.sock'], connect: () => proxy.ws,
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = (await app.inboxStates([{ id: '%1' }]))['%1'];
    expect(state).toMatchObject({ kind: 'permission', suppressPush: true });
    app.close();
  });

  it('treats a Codex socket first discovered after startup as a no-replay baseline', async () => {
    let sockets: string[] = [];
    const scanTimer: { run?: () => Promise<void> } = {};
    let proxy: ReturnType<typeof fakeProxy> | null = null;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => sockets,
      connect: () => { proxy ||= fakeProxy(); return proxy.ws; },
      setTimer: (callback) => {
        scanTimer.run = async () => callback();
        return { unref() {} };
      }, clearTimer: () => {},
    });
    app.start();
    await Promise.resolve();
    await Promise.resolve();

    sockets = ['1.sock'];
    if (!scanTimer.run) throw new Error('scan timer was not installed');
    await scanTimer.run();
    const state = (await app.inboxStates([{ id: '%1' }]))['%1'];

    expect(state).toMatchObject({ kind: 'done', suppressPush: true });
    app.close();
  });

  it('ends baseline suppression after observing an empty managed App Server', async () => {
    const completed = {
      id: 'thread-new', status: { type: 'idle' },
      turns: [{
        id: 'turn-new', status: 'completed', completedAt: 2,
        items: [{ id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: 'new work' }] }],
      }],
    };
    const proxy = fakeProxy({ loaded: [], resumeThread: () => completed });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: null });

    proxy.push({
      jsonrpc: '2.0', method: 'thread/started',
      params: { thread: { id: 'thread-new', parentThreadId: null } },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'thread-new', turn: {
          id: 'turn-new', status: 'completed',
          items: [{ id: 'user-new', type: 'userMessage', content: [{ type: 'text', text: 'new work' }] }],
        },
      },
    });
    await Promise.resolve();

    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: 'new work', suppressPush: false });
    app.close();
  });

  it('restores the active user prompt from the App Server thread after reconnecting', async () => {
    const active = fixtureThread({ type: 'active', activeFlags: [] });
    active.turns.push({
      id: 'turn-live', status: 'inProgress', items: [
        { id: 'user-live', type: 'userMessage', content: [{ type: 'text', text: 'resume this task' }] },
      ],
    });
    const proxy = fakeProxy({ resumeThread: () => active });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    await app.discover('%1');
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'working', msg: 'resume this task' });
    app.close();
  });

  it('restores the last completion with its stable timestamp without replaying its push', async () => {
    const completed = fixtureThread();
    firstTurn(completed).items = [
      { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
    ];
    const proxy = fakeProxy({ resumeThread: () => completed });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => ['1.sock'], connect: () => proxy.ws,
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1'])
      .toMatchObject({ kind: 'done', msg: 'hello', ts: 2000, suppressPush: true });
    app.close();
  });

  it('keeps compaction distinct from a normal working turn until it settles', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.compact('%1', 'thread-1');
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: 'compacting' });
    proxy.push({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: 'compacting' });
    proxy.push({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'turn-2' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: null });
    app.close();
  });

  it('hides the compactor handoff and resumes streaming when the compaction item completes', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    const events: CodexStreamEvent[] = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));

    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'compact-turn',
        item: { id: 'compaction', type: 'contextCompaction' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'compact-turn',
        item: { id: 'compactor-answer', type: 'agentMessage', text: '' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: 'compact-turn',
        itemId: 'compactor-answer', delta: '## retained context',
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'compact-turn',
        item: { id: 'compactor-answer', type: 'agentMessage', text: '## retained context' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);

    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'compact-turn',
        item: { id: 'compaction', type: 'contextCompaction' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'normal-turn',
        item: { id: 'normal-answer', type: 'agentMessage', text: '' },
      },
    });
    proxy.push({
      jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: 'normal-turn',
        itemId: 'normal-answer', delta: 'Visible live reply',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'started', threadId: 'thread-1', turnId: 'normal-turn', itemId: 'normal-answer',
      }),
      expect.objectContaining({
        type: 'delta', threadId: 'thread-1', turnId: 'normal-turn',
        itemId: 'normal-answer', delta: 'Visible live reply',
      }),
    ]);

    unsubscribe();
    app.close();
  });

  it('exposes the current context token counts from App Server usage updates', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-1', turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 999999 },
          last: { totalTokens: 159719 },
          modelContextWindow: 258400,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({
      contextUsage: { usedTokens: 159719, totalTokens: 258400 },
    });
    app.close();
  });
});
