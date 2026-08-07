import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createCodexAppServer, projectCodexThread } from '../src/codexAppServer.js';

function fixtureThread(status = { type: 'idle' }) {
  return {
    id: 'thread-1', status,
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
  turnStartWait = null,
} = {}) {
  const ws = new EventEmitter();
  ws.readyState = 0;
  const sent = [];
  let persisted = !empty;
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
        thread: { ...fixtureThread(status), id: message.params.threadId, updatedAt: updatedAt[message.params.threadId] },
        model: 'gpt-test', modelProvider: 'openai', serviceTier: null, cwd: '/work', approvalPolicy: 'on-request',
        runtimeWorkspaceRoots: ['/work', '/shared'],
        approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, activePermissionProfile: null,
        reasoningEffort: 'high', multiAgentMode: 'explicitRequestOnly',
      } });
    } else if (message.method === 'thread/read') {
      const thread = message.params.includeTurns !== false && readThread ? readThread(message.params.threadId) : fixtureThread();
      reply({ jsonrpc: '2.0', id: message.id, result: { thread: { ...thread, id: message.params.threadId, updatedAt: updatedAt[message.params.threadId] } } });
    } else if (message.method === 'turn/start') {
      persisted = true;
      const finish = () => reply({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
      if (turnStartWait) void Promise.resolve(turnStartWait).then(finish);
      else finish();
    } else if (message.method === 'turn/steer') {
      reply({ jsonrpc: '2.0', id: message.id, result: { turnId: message.params.expectedTurnId } });
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
    expect(messages[2].tool).toMatchObject({ name: 'exec_command', result: '/work\n', isError: false });
    expect(messages.slice(3, 5).map((message) => message.tool.input.file_path)).toEqual(['/work/a.js', '/work/b.js']);
    expect(messages.slice(5, 12).map((message) => message.tool.name)).toEqual([
      'web__run', 'docs:search', 'custom', 'view_image', 'wait', 'spawn_agent', 'image_gen__imagegen',
    ]);
    expect(messages[5].tool.result).toContain('https://example.com');
    expect(messages[10].tool.input).toMatchObject({ target: 'thread-2', prompt: 'review' });
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
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
  it('discovers and sends the first message to a loaded thread before its rollout exists', async () => {
    const proxy = fakeProxy({ empty: true });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, status: { type: 'idle' } });
    await app.send('%1', 'thread-1', 'first message');
    expect(proxy.sent.filter((message) => message.method === 'thread/resume').length).toBeGreaterThanOrEqual(2);
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start' }));
    app.close();
  });

  it('resumes the exact thread, sends turns, and resolves a structured approval once', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ settings: { model: 'gpt-test', effort: 'high' } });
    await app.send('%1', 'thread-1', 'continue');
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'continue' }] } }));

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
      params: {
        threadId: 'thread-1', expectedTurnId: 'turn-live',
        input: [{ type: 'text', text: 'guide now' }],
      },
    }));
    expect((await app.status('%1', 'thread-1')).queue.map((item) => item.id)).toEqual([second.id]);

    expect(await app.removeQueued('%1', 'thread-1', second.id)).toEqual({ removed: true });
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
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
    await app.send('%1', 'thread-1', 'next turn');

    proxy.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proxy.sent.filter((message) => message.method === 'turn/start')).toContainEqual(expect.objectContaining({
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'next turn' }] },
    }));
    expect((await app.status('%1', 'thread-1')).queue).toEqual([]);
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

  it('starts /clear as a native App Server thread with the current settings', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.clear('%1', 'thread-1')).toEqual({ threadId: 'thread-clear' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/start',
      params: expect.objectContaining({
        sessionStartSource: 'clear', model: 'gpt-test', modelProvider: 'openai', cwd: '/work',
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
        runtimeWorkspaceRoots: ['/work', '/shared'],
      }),
    }));
    expect((await app.discover('%1')).threadId).toBe('thread-clear');
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

  it('lists official models and updates model and effort on the current thread', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.models('%1', 'thread-1')).toEqual([
      expect.objectContaining({ model: 'gpt-test', defaultReasoningEffort: 'medium' }),
    ]);
    expect(await app.updateSettings('%1', 'thread-1', { model: 'gpt-new', effort: 'high' }))
      .toMatchObject({ model: 'gpt-new', effort: 'high' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/settings/update', params: { threadId: 'thread-1', model: 'gpt-new', effort: 'high' },
    }));
    app.close();
  });

  it('chooses the newest loaded thread after a server restart', async () => {
    const proxy = fakeProxy({ loaded: ['thread-old', 'thread-new'], updatedAt: { 'thread-old': 10, 'thread-new': 20 } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-new' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'thread/read', params: { threadId: 'thread-new', includeTurns: false } }));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'working' });

    proxy.push({ jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'npm test' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'permission', msg: 'npm test' });

    proxy.push({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'all green' }] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', msg: 'all green' });
    expect(changed).toEqual(['%1', '%1', '%1']);
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
    });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');
    expect(await app.clear('%1', 'thread-1')).toEqual({ threadId: 'thread-clear' });

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

  it('restores the last completion with its stable timestamp without replaying its push', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => ['1.sock'], connect: () => proxy.ws,
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', ts: 2000, suppressPush: true });
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
