import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createCodexAppServer, projectCodexThread } from '../src/codexAppServer.js';

function fixtureThread(status = { type: 'idle' }) {
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

function fakeProxy({
  empty = false, loaded = ['thread-1'], updatedAt = {}, status = { type: 'idle' }, readThread = null,
  resumeThread = null, turnStartWait = null, turnStartReply = true, turnSteerReply = true,
  parentThreadIds = {}, initialGoal = null,
} = {}) {
  const ws = new EventEmitter();
  ws.readyState = 0;
  const sent = [];
  let persisted = !empty;
  let goal = initialGoal;
  const reply = (message) => queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify(message))));
  ws.send = (data) => {
    const message = JSON.parse(data);
    sent.push(message);
    if (message.id == null) return;
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    else if (message.method === 'thread/loaded/list') {
      reply({ jsonrpc: '2.0', id: message.id, result: { data: loaded, nextCursor: null } });
    } else if (message.method === 'thread/resume') {
      if (!persisted) reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no rollout found for thread id thread-1' } });
      else reply({ jsonrpc: '2.0', id: message.id, result: {
        thread: {
          ...(resumeThread ? resumeThread(message.params.threadId) : fixtureThread(status)),
          id: message.params.threadId, updatedAt: updatedAt[message.params.threadId],
        },
        model: 'gpt-test', modelProvider: 'openai', serviceTier: null, cwd: '/work', approvalPolicy: 'on-request',
        runtimeWorkspaceRoots: ['/work', '/shared'],
        approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, activePermissionProfile: null,
        reasoningEffort: 'high', multiAgentMode: 'explicitRequestOnly',
      } });
    } else if (message.method === 'thread/read') {
      const thread = message.params.includeTurns !== false && readThread ? readThread(message.params.threadId) : fixtureThread();
      reply({ jsonrpc: '2.0', id: message.id, result: { thread: {
        ...thread, id: message.params.threadId, updatedAt: updatedAt[message.params.threadId],
        parentThreadId: parentThreadIds[message.params.threadId] ?? null,
      } } });
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
      reply({ jsonrpc: '2.0', id: message.id, result: { goal } });
    } else if (message.method === 'thread/goal/set') {
      goal = {
        threadId: message.params.threadId,
        objective: message.params.objective ?? goal?.objective,
        status: message.params.status ?? goal?.status ?? 'active',
        createdAt: goal?.createdAt ?? 1,
        updatedAt: 2,
        tokensUsed: goal?.tokensUsed ?? 0,
        timeUsedSeconds: goal?.timeUsedSeconds ?? 0,
        tokenBudget: goal?.tokenBudget ?? null,
      };
      reply({ jsonrpc: '2.0', id: message.id, result: { goal } });
    } else if (message.method === 'thread/goal/clear') {
      goal = null;
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'thread/settings/update') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'turn/interrupt') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  queueMicrotask(() => { ws.readyState = 1; ws.emit('open'); });
  return { ws, sent, push: (message) => reply(message) };
}

describe('Codex App Server projection', () => {
  it('projects authoritative items into the existing chat contract', () => {
    const messages = projectCodexThread(fixtureThread());
    expect(messages.map((message) => message.type)).toEqual([
      'text', 'text', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'compact',
    ]);
    expect(messages[0]).toMatchObject({ id: 'codex:turn-1:user-1', k: 0, role: 'user', text: 'hello' });
    expect(messages[2].tool).toMatchObject({ name: 'exec_command', result: '/work\n', isError: false, outcome: 'success' });
    expect(messages.slice(3, 5).map((message) => message.tool.input.file_path)).toEqual(['/work/a.js', '/work/b.js']);
    expect(messages.slice(5, 12).map((message) => message.tool.name)).toEqual([
      'web__run', 'docs:search', 'custom', 'view_image', 'wait', 'spawn_agent', 'image_gen__imagegen',
    ]);
    expect(messages[5].tool.result).toContain('https://example.com');
    expect(messages[10].tool.input).toMatchObject({ target: 'thread-2', prompt: 'review' });
    expect(messages[7].tool).toMatchObject({ name: 'custom', outcome: 'success' });
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });

  it('keeps persisted declines distinct and treats dynamic completion without success as neutral', () => {
    const thread = fixtureThread();
    thread.turns[0].items = [
      { id: 'cmd-declined', type: 'commandExecution', command: 'sw_vers', cwd: '/work', status: 'declined' },
      {
        id: 'dynamic-unknown', type: 'dynamicToolCall', tool: 'functions.exec', arguments: {},
        status: 'completed', contentItems: [{ type: 'inputText', text: 'aborted by user' }], success: null,
      },
    ];
    const messages = projectCodexThread(thread);
    expect(messages[0].tool).toMatchObject({ outcome: 'declined', isError: false });
    expect(messages[1].tool).toMatchObject({ outcome: 'completed', isError: false, result: 'aborted by user' });
  });

  it('keeps message identity stable when a snapshot inserts an earlier item', () => {
    const before = projectCodexThread(fixtureThread());
    const thread = fixtureThread();
    thread.turns[0].items.unshift({ id: 'reasoning-0', type: 'reasoning', summary: ['thinking'], content: [] });
    const after = projectCodexThread(thread);
    expect(after.find((message) => message.text === 'hello')).toMatchObject({
      id: before.find((message) => message.text === 'hello').id,
      k: before.find((message) => message.text === 'hello').k + 1,
    });
  });

  it('keeps interrupted turns as a visible structural marker', () => {
    const thread = fixtureThread();
    thread.turns[0].status = 'interrupted';
    expect(projectCodexThread(thread).at(-1).type).toBe('interrupt');
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
    const events = [];
    const unsubscribe = await app.subscribe('%1', 'thread-1', (event) => events.push(event));
    await app.getGoal('%1', 'thread-1');

    proxy.push({
      jsonrpc: '2.0', method: 'thread/goal/updated', params: {
        threadId: 'thread-1', turnId: 'turn-goal',
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
    const replayed = [];
    const unsubscribeReplay = await app.subscribe('%1', 'thread-1', (event) => replayed.push(event));
    expect(replayed).toEqual([expect.objectContaining({
      type: 'goal', event: 'complete', goal: expect.objectContaining({ status: 'complete' }),
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
      type: 'goal', event: 'restarted',
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
    const events = [];
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
    const replayed = [];
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
      expect.objectContaining({ type: 'started', threadId: 'thread-1', itemId: 'agent-live' }),
      expect.objectContaining({ type: 'delta', delta: '你好' }),
    ]);
    expect(replayed).toEqual([
      expect.objectContaining({ type: 'snapshot', text: '你好' }),
      expect.objectContaining({ type: 'completed', text: '你好，完成' }),
    ]);
    const completedReplay = [];
    const unsubscribeCompleted = await app.subscribe('%1', 'thread-1', (event) => completedReplay.push(event));
    // Completed text is history and must come only from the rollout projection. Replaying it as a live
    // snapshot can place old replies below the current stream after a reconnect.
    expect(completedReplay).toEqual([]);
    expect(projectCodexThread((await app.read('%1', 'thread-1')).thread)
      .find((message) => message.id === 'codex:turn-live:agent-live')?.text).toBe('你好，完成');

    app.close();
    expect(replayed.at(-1)).toMatchObject({ type: 'disconnected', threadId: 'thread-1' });
    unsubscribe();
    unsubscribeReplay();
    unsubscribeCompleted();
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

    proxy.push({
      jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'cmd-2', command: 'npm test', cwd: '/work', startedAtMs: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = await app.status('%1', 'thread-1');
    expect(pending.approvals[0]).toMatchObject({ id: '91', type: 'command', command: 'npm test' });
    await app.decide('%1', 'thread-1', '91', 'accept');
    expect(proxy.sent).toContainEqual({ jsonrpc: '2.0', id: 91, result: { decision: 'accept' } });
    expect((await app.status('%1', 'thread-1')).approvals).toEqual([]);
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

    expect(retry).toEqual(first);
    expect((await app.status('%1', 'thread-1')).queue).toEqual([expect.objectContaining({
      id: first.item.id, requestId: 'request-1', text: 'only once',
    })]);
    await expect(app.send('%1', 'thread-1', 'different text', 'request-1'))
      .rejects.toThrow('request id was already used');
    app.close();
  });

  it('serializes simultaneous idle submissions so only the first starts immediately', async () => {
    let releaseStart;
    const turnStartWait = new Promise((resolve) => { releaseStart = resolve; });
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

  it('steers one queued message into the active turn and can remove another', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = (await app.send('%1', 'thread-1', 'guide now')).item;
    const second = (await app.send('%1', 'thread-1', 'discard me')).item;

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

  it('removes a steered queue item as soon as App Server confirms its client id', async () => {
    const proxy = fakeProxy({ turnSteerReply: false });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.status('%1', 'thread-1');
    proxy.push({
      jsonrpc: '2.0', method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = (await app.send('%1', 'thread-1', 'guide once', 'request-guide')).item;
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
    const queued = (await app.send('%1', 'thread-1', 'next turn')).item;

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
    const firstQueued = (await app.send('%1', 'thread-1', 'send first')).item;
    const queued = (await app.send('%1', 'thread-1', 'original text')).item;
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
    const queued = (await app.send('%1', 'thread-1', 'keep original')).item;
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
      const queued = (await app.send('%1', 'thread-1', 'send after abandoned edit')).item;
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
      const queued = (await app.send('%1', 'thread-1', 'wait for editor')).item;
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
      const proxies = [];
      app = createCodexAppServer({
        home: '/home/test', exists: () => true, now: () => Date.now(),
        connect: () => { const proxy = fakeProxy(); proxies.push(proxy); return proxy.ws; },
      });
      await app.status('%1', 'thread-1');
      const first = proxies[0];
      first.push({
        jsonrpc: '2.0', method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'inProgress', items: [] } },
      });
      await Promise.resolve();
      const queued = (await app.send('%1', 'thread-1', 'resume after reconnect')).item;
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
      await vi.advanceTimersByTimeAsync(31_000);
      await app.status('%1', 'thread-1');
      await Promise.resolve();
      await Promise.resolve();

      expect(replacement.sent.filter((message) => message.method === 'turn/start')).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            threadId: 'thread-1', input: [{ type: 'text', text: 'resume after reconnect' }],
            clientUserMessageId: `handmux-queue:${queued.id}`,
          }),
        }),
      );
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
    completed.turns[0].status = 'completed';
    let second;
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
    const queued = (await app.send('%1', 'thread-1', 'continue after reconnect')).item;
    expect((await app.status('%1', 'thread-1')).queue).toHaveLength(1);

    first.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ lastTurn: { status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(second.sent).toContainEqual(expect.objectContaining({
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
    let second;
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
    expect(second.sent.filter((message) => message.method === 'turn/start')).toEqual([]);
    app.close();
  });

  it('restores a failed last-turn status from the App Server snapshot', async () => {
    const failed = fixtureThread({ type: 'idle' });
    failed.turns[0].status = 'failed';
    const proxy = fakeProxy({ resumeThread: () => failed });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });

    expect(await app.status('%1', 'thread-1')).toMatchObject({ lastTurn: { status: 'failed' } });
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
    expect(projectCodexThread(opened.thread).find((message) => message.tool?.input?.cmd === 'npm test')?.tool.result)
      .toBeNull();

    proxy.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'cmd-live', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', aggregatedOutput: 'passed\n' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened = await app.read('%1', 'thread-1');
    expect(projectCodexThread(opened.thread).find((message) => message.tool?.input?.cmd === 'npm test')?.tool.result)
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

    const provisional = projectCodexThread((await app.read('%1', 'thread-1')).thread).slice(-3);
    expect(provisional.map((message) => message.text || message.tool?.input?.cmd))
      .toEqual(['fix it', 'done', 'npm test']);

    // App Server persistence catches up without another notification. The next phone poll must therefore
    // read again while an overlay remains instead of freezing the provisional tail forever.
    canonicalReady = true;
    const converged = projectCodexThread((await app.read('%1', 'thread-1')).thread).slice(-3);
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
    const texts = projectCodexThread(opened.thread)
      .filter((message) => message.type === 'text')
      .map((message) => [message.role, message.text]);
    expect(texts.filter((message) => message[1] === 'only once')).toEqual([['user', 'only once']]);
    expect(texts.filter((message) => message[1] === 'one reply')).toEqual([['assistant', 'one reply']]);
    expect(texts.slice(-2)).toEqual([['user', 'only once'], ['assistant', 'one reply']]);
    const projected = projectCodexThread(opened.thread);
    expect(projected.filter((message) => message.tool?.input?.cmd === 'npm test')).toHaveLength(1);
    expect(projected.filter((message) => ['only once', 'one reply'].includes(message.text)).map((message) => message.id))
      .toEqual(['codex:turn-2:live-user', 'codex:turn-2:live-agent']);

    // A later unrelated revision reads the same canonical ids after the live overlay has retired; identity
    // must still stay on the original notification ids or the phone will render them as new messages.
    proxy.push({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'snapshot-agent', delta: '' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reread = projectCodexThread((await app.read('%1', 'thread-1')).thread);
    expect(reread.filter((message) => ['only once', 'one reply'].includes(message.text)).map((message) => message.id))
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

    expect(await app.getGoal('%1', 'thread-1')).toMatchObject({
      objective: 'Finish the migration', status: 'active',
    });
    expect(await app.updateGoal('%1', 'thread-1', { objective: 'Ship it' })).toMatchObject({
      objective: 'Ship it', status: 'active',
    });
    expect(await app.updateGoal('%1', 'thread-1', { status: 'paused' })).toMatchObject({
      objective: 'Ship it', status: 'paused',
    });
    expect(await app.clearGoal('%1', 'thread-1')).toEqual({ cleared: true });
    expect(await app.getGoal('%1', 'thread-1')).toBeNull();
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/goal/set', params: { threadId: 'thread-1', objective: 'Ship it' },
    }));
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

  it('projects turn and approval events into one authoritative inbox state', async () => {
    let ts = 100;
    const changed = [];
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
      now: () => ++ts, onStateChange: (pane) => changed.push(pane),
    });
    await app.discover('%1');
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

    proxy.push({ jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'npm test' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'permission', msg: 'npm test' });

    proxy.push({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 91 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'working', msg: 'fix the inbox' });

    proxy.push({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'all green' }] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', msg: 'all green' });
    expect(changed).toEqual(['%1', '%1', '%1', '%1', '%1', '%1']);
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
    let sockets = [];
    let scanTick = null;
    let proxy = null;
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => sockets,
      connect: () => { proxy ||= fakeProxy(); return proxy.ws; },
      setTimer: (callback) => { scanTick = callback; return { unref() {} }; }, clearTimer: () => {},
    });
    app.start();
    await Promise.resolve();
    await Promise.resolve();

    sockets = ['1.sock'];
    await scanTick();
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
    completed.turns[0].items = [
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
